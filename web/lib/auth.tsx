'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  type User as FirebaseUser,
  type Auth,
} from 'firebase/auth';
import type { WorktrackerUser } from '@worktracker/types';
import { getFirebaseAuth } from './firebase';

/**
 * Auth context for the web app. Wraps Firebase Auth + the
 * worktracker users collection.
 *
 * Two layers:
 *   1. `firebaseUser` — the Firebase Auth user object (from
 *      `onAuthStateChanged`). Drives the "are we signed in?"
 *      gating.
 *   2. `worktrackerUser` — the `users/{firebase_uid}` record.
 *      Holds `is_admin` and other worktracker-specific fields.
 *      Fetched from the API after sign-in; the API creates the
 *      record on first sign-in (first user becomes admin).
 *
 * `getIdToken()` returns a fresh ID token for the REST/MCP
 * API. Firebase Auth refreshes the underlying token
 * automatically; we force-refresh when within 60s of expiry
 * to keep calls from racing the rotation.
 */
export interface AuthContextValue {
  firebaseUser: FirebaseUser | null;
  worktrackerUser: WorktrackerUser | null;
  isAdmin: boolean;
  isLoading: boolean;
  getIdToken: () => Promise<string | null>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const ID_TOKEN_REFRESH_LEAD_MS = 60_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  // Hold a ref to the Auth instance instead of memoizing at
  // render time. Initializing Firebase during render breaks
  // SSR/SSG builds when env vars are missing — the SDK throws
  // `auth/invalid-api-key` synchronously, which Next turns into
  // a build error. We defer the init to a ref so the first
  // render produces no Firebase calls; the ref fills in on
  // mount (client only) and is reused thereafter. The callbacks
  // (`signIn`, `signOut`, `getIdToken`) re-read the ref on
  // every call so a ref populated post-render is picked up
  // without a re-render.
  const authRef = useRef<Auth | null>(null);
  if (authRef.current === null && typeof window !== 'undefined') {
    authRef.current = getFirebaseAuth();
  }
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [worktrackerUser, setWorktrackerUser] = useState<WorktrackerUser | null>(null);
  const [isLoading, setLoading] = useState(true);

  // Pull the worktracker user record by hitting the API. The API
  // mints the record on first call (upsertUserFromDecoded) so
  // this doubles as the first sign-in side effect.
  const refreshWorktrackerUser = useCallback(
    async (token: string): Promise<WorktrackerUser | null> => {
      try {
        const apiBase =
          (typeof window !== 'undefined' && window.localStorage.getItem('worktracker.api_base')) ||
          process.env.NEXT_PUBLIC_API_BASE ||
          '';
        const res = await fetch(`${apiBase}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { user: WorktrackerUser };
        return body.user;
      } catch {
        return null;
      }
    },
    [],
  );

  useEffect(() => {
    const a = authRef.current ?? getFirebaseAuth();
    authRef.current = a;
    const unsub = onAuthStateChanged(a, async (u) => {
      setFirebaseUser(u);
      if (!u) {
        setWorktrackerUser(null);
        setLoading(false);
        return;
      }
      try {
        const token = await u.getIdToken();
        const wt = await refreshWorktrackerUser(token);
        setWorktrackerUser(wt);
      } finally {
        setLoading(false);
      }
    });
    return unsub;
  }, [refreshWorktrackerUser]);

  const getIdToken = useCallback(async (): Promise<string | null> => {
    const a = authRef.current ?? getFirebaseAuth();
    const u = a.currentUser;
    if (!u) return null;
    return u.getIdToken();
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const a = authRef.current ?? getFirebaseAuth();
      await signInWithEmailAndPassword(a, email, password);
    },
    [],
  );

  const signOut = useCallback(async () => {
    const a = authRef.current ?? getFirebaseAuth();
    await fbSignOut(a);
  }, []);

  // Auto-refresh the worktracker user record on a long-lived
  // session so a promotion to admin propagates without a reload.
  useEffect(() => {
    if (!firebaseUser) return;
    const id = window.setInterval(async () => {
      const token = await getIdToken();
      if (!token) return;
      const wt = await refreshWorktrackerUser(token);
      if (wt) setWorktrackerUser(wt);
    }, 5 * 60_000);
    return () => window.clearInterval(id);
  }, [firebaseUser, getIdToken, refreshWorktrackerUser]);

  const value: AuthContextValue = {
    firebaseUser,
    worktrackerUser,
    isAdmin: Boolean(worktrackerUser?.is_admin),
    isLoading,
    getIdToken,
    signIn,
    signOut,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

// Re-export the constant for the API client (without exporting the
// timer logic, which is internal).
export const __ID_TOKEN_REFRESH_LEAD_MS = ID_TOKEN_REFRESH_LEAD_MS;
