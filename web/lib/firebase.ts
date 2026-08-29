/**
 * Firebase client SDK. Used by the web UI for live `onSnapshot`
 * subscriptions to work items, sources, and commands.
 *
 * The browser client authenticates with the admin token (v0 is
 * single-user). In v0.5, this becomes Firebase Auth with an
 * anonymous session.
 */

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getFirestore, type Firestore } from 'firebase/firestore';

let app: FirebaseApp | null = null;
let db: Firestore | null = null;

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

export function getFirebaseDb(): Firestore {
  if (db) return db;
  if (!app) {
    if (getApps().length === 0) {
      app = initializeApp(firebaseConfig());
    } else {
      app = getApps()[0]!;
    }
  }
  db = getFirestore(app);
  return db;
}
