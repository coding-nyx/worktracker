'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '../../lib/auth';

/**
 * Email/password sign-in. The first user to sign in becomes
 * admin (the API auto-promotes). Subsequent users default to
 * non-admin and need an existing admin to flip their `is_admin`.
 *
 * On success, redirect to `?next=…` (defaults to `/`). The
 * `next` value is validated to be a same-origin path so a
 * crafted link can't be used to bounce through `/login`.
 */
export default function LoginPage() {
  const auth = useAuth();
  const router = useRouter();
  const search = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If the user is already signed in, bounce to next immediately.
  useEffect(() => {
    if (!auth.isLoading && auth.firebaseUser) {
      const next = sanitizeNext(search.get('next'));
      router.replace(next);
    }
  }, [auth.isLoading, auth.firebaseUser, search, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await auth.signIn(email.trim(), password);
      const next = sanitizeNext(search.get('next'));
      router.replace(next);
    } catch (err) {
      setError(humanizeAuthError(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[80vh] max-w-md flex-col justify-center px-5 py-12">
      <div className="space-y-7">
        <div className="space-y-1.5 text-center">
          <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-glow">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4Z" />
              <path d="M13 5v2" /><path d="M13 17v2" /><path d="M13 11v2" />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-1">Sign in to WorkTracker</h1>
          <p className="text-[13px] text-ink-2">
            Use the email and password the admin shared with you. The first sign-in creates the admin account.
          </p>
        </div>

        <form onSubmit={onSubmit} className="card space-y-4 p-6" noValidate>
          <div className="space-y-1.5">
            <label htmlFor="email" className="block text-[12px] font-medium uppercase tracking-wider text-ink-3">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="field w-full text-[14px]"
              placeholder="you@example.com"
              disabled={submitting}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="password" className="block text-[12px] font-medium uppercase tracking-wider text-ink-3">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="field w-full text-[14px]"
              placeholder="••••••••"
              disabled={submitting}
            />
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-status-blocked-500/40 bg-status-blocked-500/10 px-3 py-2 text-[12.5px] text-status-blocked-600"
            >
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={submitting || !email || !password}
            className="btn-primary focus-ring inline-flex w-full items-center justify-center gap-2 px-4 py-2.5 text-[14px] font-medium disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? (
              <>
                <Spinner />
                Signing in…
              </>
            ) : (
              'Sign in'
            )}
          </button>
        </form>

        <p className="text-center text-[12px] text-ink-3">
          New here? Ask the admin to create an account for you — registration is invite-only.
        </p>
      </div>
    </div>
  );
}

function sanitizeNext(raw: string | null): string {
  if (!raw) return '/';
  // Only accept same-origin paths (start with `/`, not `//`, not a scheme).
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//')) return '/';
  return raw;
}

function humanizeAuthError(err: unknown): string {
  // firebase/auth surfaces errors as { code, message }.
  const code = (err as { code?: string })?.code ?? '';
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
    return 'Wrong email or password.';
  }
  if (code === 'auth/too-many-requests') {
    return 'Too many attempts. Try again in a few minutes.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Network error. Check your connection and try again.';
  }
  if (code === 'auth/invalid-email') {
    return 'That email address looks invalid.';
  }
  return (err as Error)?.message ?? 'Sign-in failed. Try again.';
}

function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 1-9 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
