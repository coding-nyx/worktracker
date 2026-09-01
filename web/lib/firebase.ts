/**
 * Firebase client SDK. Used by the web UI for:
 *   - live `onSnapshot` subscriptions to work items, sources,
 *     and commands (Firestore)
 *   - Auth (sign-in / sign-out / current user)
 *
 * The Firebase Auth ID token (a short-lived JWT) is sent to the
 * WorkTracker API as `Authorization: Bearer …`. The API verifies
 * it with firebase-admin and looks up the worktracker user
 * record at `users/{firebase_uid}`. See `apps/api/src/auth.ts`.
 *
 * The admin token + source-bearer flows still work for
 * automation, MCP clients, and the deep-link hash bootstrap.
 */

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

let app: FirebaseApp | null = null;
let db: Firestore | null = null;
let auth: Auth | null = null;

function firebaseConfig(): {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
} {
  return {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? '',
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? '',
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? '',
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? '',
  };
}

function ensureApp(): FirebaseApp {
  if (app) return app;
  if (getApps().length === 0) {
    app = initializeApp(firebaseConfig());
  } else {
    app = getApps()[0]!;
  }
  return app;
}

export function getFirebaseDb(): Firestore {
  if (db) return db;
  db = getFirestore(ensureApp());
  return db;
}

export function getFirebaseAuth(): Auth {
  if (auth) return auth;
  auth = getAuth(ensureApp());
  return auth;
}
