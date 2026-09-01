/**
 * Authentication middleware. Three token types:
 *   - Admin token: WORKTRACKER_ADMIN_TOKEN; can do everything
 *     including source registration and conflict resolution.
 *   - Firebase Auth ID token: a JWT issued by Identity Toolkit
 *     for a user in the project's Firebase Auth. Resolves to a
 *     `WorktrackerUser` document at `users/{firebase_uid}`. The
 *     first user to sign in is auto-promoted to admin; subsequent
 *     users default to non-admin and need an existing admin to
 *     flip their `is_admin` flag.
 *   - Per-source bearer token: the API key returned at source
 *     registration. The token is a scrypt hash of the source's
 *     API key; the request carries the plaintext key in the
 *     `Authorization: Bearer …` header.
 *
 * Why scrypt (not bcrypt): bcrypt's cost-10 hash takes 30-60s
 * on Cloud Run's throttled CPU. API keys already have high
 * entropy (24 random bytes), so a faster, still-secure hash
 * is the right tradeoff. scrypt is in Node's `crypto` module
 * and is constant-time verified with `timingSafeEqual`.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SourceRegistration, WorktrackerUser } from '@worktracker/types';
import { applicationDefault, getApp, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { getDb } from './firestore.js';
import { ForbiddenError, UnauthorizedError } from './errors.js';
import { loadConfig } from './config.js';
import { nowIso, ulid } from './ids.js';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

// Cache the admin token at module init. loadConfig() throws if
// the token can't be resolved (env var missing AND no default),
// so this surfaces a clear startup error.
const ADMIN_TOKEN = loadConfig().adminToken;

declare module 'fastify' {
  interface FastifyRequest {
    auth?: {
      kind: 'admin' | 'source' | 'user';
      source?: SourceRegistration;
      user?: WorktrackerUser;
    };
  }
}

const ADMIN_HEADER = 'authorization';

function extractBearer(req: FastifyRequest): string | null {
  const h = req.headers[ADMIN_HEADER];
  if (typeof h !== 'string') return null;
  if (!h.toLowerCase().startsWith('bearer ')) return null;
  return h.slice(7).trim();
}

/**
 * Admin-only. Used for source registration, conflict resolution,
 * the Hermes bridge, etc.
 *
 * Accepts either the static admin token (operator scripts) OR a
 * Firebase Auth ID token whose corresponding `users/{uid}` doc
 * has `is_admin: true`. The first Firebase user to sign in is
 * auto-promoted to admin; subsequent users default to non-admin
 * and need an existing admin to flip their flag.
 */
export async function requireAdmin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = extractBearer(req);
  if (token && token === ADMIN_TOKEN) {
    req.auth = { kind: 'admin' };
    return;
  }
  if (token && looksLikeJwt(token)) {
    const user = await resolveUserFromFirebaseToken(token);
    if (user) {
      if (!user.enabled) throw new ForbiddenError('user disabled');
      if (!user.is_admin) throw new ForbiddenError('admin access required');
      req.auth = { kind: 'user', user };
      return;
    }
  }
  throw new UnauthorizedError('admin token invalid');
}

/**
 * Source auth. Three paths, in priority order:
 *
 *   1. Admin token (WORKTRACKER_ADMIN_TOKEN) → `kind: 'admin'`.
 *      Used by the admin UI and operator scripts.
 *   2. Firebase Auth ID token (a JWT issued by the project's
 *      Identity Toolkit) → looked up against the `users`
 *      collection, attaches `kind: 'user', user`.
 *      Used by the React web app after sign-in.
 *   3. Per-source bearer (`<source>.<key>`) → looked up against
 *      the `sources` collection. Used by external MCP clients
 *      (Claude Code, Codex, Hermes) and the Hermes bridge.
 *
 * Anything else is 401.
 */
export async function requireSource(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = extractBearer(req);
  if (token && token === ADMIN_TOKEN) {
    req.auth = { kind: 'admin' };
    return;
  }
  if (!token) {
    throw new UnauthorizedError('bearer token required');
  }
  // Firebase Auth ID tokens are JWTs (three dot-separated base64
  // sections) issued by Identity Toolkit. The presence of three
  // dots is a cheap, reliable shape test — source bearers are
  // `<source>.<key>` and never have more than one dot. Verified
  // by `getAuth().verifyIdToken`, which checks the signature,
  // the issuer (must be the project), the audience (must be the
  // project), and the expiry.
  if (looksLikeJwt(token)) {
    const user = await resolveUserFromFirebaseToken(token);
    if (user) {
      if (!user.enabled) throw new ForbiddenError('user disabled');
      req.auth = { kind: 'user', user };
      return;
    }
  }
  const source = await resolveSourceFromToken(token);
  if (!source) {
    throw new UnauthorizedError('bearer token invalid');
  }
  if (!source.enabled) {
    throw new ForbiddenError('source disabled');
  }
  req.auth = { kind: 'source', source };
}

function looksLikeJwt(token: string): boolean {
  // Three dot-separated non-empty segments.
  const parts = token.split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

// ----- Firebase Admin -----

let firebaseApp: App | null = null;
function getFirebaseApp(): App {
  if (firebaseApp) return firebaseApp;
  try {
    firebaseApp = getApp();
  } catch {
    // Application Default Credentials: on Cloud Run the service
    // account is auto-discovered via the metadata server; locally,
    // `gcloud auth application-default login` provides the same.
    // We deliberately do NOT pass a cert — env-var-loaded certs
    // are easy to misconfigure (undefined fields create a broken
    // credential) and ADC just works.
    firebaseApp = initializeApp({
      credential: applicationDefault(),
    });
  }
  return firebaseApp;
}

async function resolveUserFromFirebaseToken(idToken: string): Promise<WorktrackerUser | null> {
  let decoded: DecodedIdToken;
  try {
    decoded = await getAuth(getFirebaseApp()).verifyIdToken(idToken, true);
  } catch {
    return null;
  }
  return upsertUserFromDecoded(decoded);
}

/**
 * Look up `users/{firebase_uid}`, creating the record on first
 * sign-in. The first user is auto-promoted to admin so the
 * bootstrap is one person; subsequent users default to
 * non-admin and need an existing admin to flip their `is_admin`.
 *
 * Returns the worktracker user record. A `null` return means
 * the user is disabled (enabled: false) and should be rejected.
 */
async function upsertUserFromDecoded(decoded: DecodedIdToken): Promise<WorktrackerUser | null> {
  const db = getDb();
  const ref = db.collection('users').doc(decoded.uid);
  const snap = await ref.get();
  const now = nowIso();
  if (snap.exists) {
    const existing = snap.data() as WorktrackerUser;
    // Refresh email + last_seen on every sign-in. Don't touch
    // is_admin / enabled from the token — those are admin-set.
    const updates: Partial<WorktrackerUser> = {
      email: decoded.email ?? existing.email,
      last_seen_at: now,
      updated_at: now,
    };
    await ref.set(updates, { merge: true });
    return { ...existing, ...updates } as WorktrackerUser;
  }
  // First time this Firebase user has hit the API. Decide if
  // they are the bootstrap admin (first user ever) or a
  // non-admin invitee.
  const existing = await db.collection('users').limit(1).get();
  const isBootstrap = existing.empty;
  const user: WorktrackerUser = {
    firebase_uid: decoded.uid,
    email: decoded.email ?? '',
    display_name: decoded.name ?? null,
    is_admin: isBootstrap,
    enabled: true,
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  };
  await ref.set(user);
  // Touch a side doc so we can find the admin later without
  // scanning `users`. The id is the admin's firebase_uid; if
  // the bootstrap admin is later demoted, the doc still points
  // at them, but the is_admin check reads from the user record.
  if (isBootstrap) {
    await db.collection('meta').doc('bootstrap').set({ admin_uid: decoded.uid, ts: now });
  }
  // ulid import kept for parity with the rest of the module —
  // used elsewhere when minting new work items.
  void ulid;
  return user;
}

async function resolveSourceFromToken(token: string): Promise<SourceRegistration | null> {
  // Optimistic fast path: the token has the form `<source>.<key>`.
  const dot = token.indexOf('.');
  if (dot > 0) {
    const name = token.slice(0, dot);
    const plaintext = token.slice(dot + 1);
    const db = getDb();
    const doc = await db.collection('sources').doc(name).get();
    if (!doc.exists) return null;
    const data = doc.data() as SourceRegistration;
    if (data.api_key_hash && (await verifyApiKey(plaintext, data.api_key_hash))) {
      return data;
    }
  }
  // Slow path: scan all sources. Bounded by single-user v0.
  const db = getDb();
  const snap = await db.collection('sources').get();
  for (const doc of snap.docs) {
    const data = doc.data() as SourceRegistration;
    if (data.api_key_hash && (await verifyApiKey(token, data.api_key_hash))) {
      return data;
    }
  }
  return null;
}

const SCRYPT_KEYLEN = 64;

/**
 * Hash a freshly-minted source API key for storage. The encoded
 * format is `scrypt$<salt-hex>$<derived-hex>`.
 */
export async function hashApiKey(plaintext: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(plaintext, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyApiKey(plaintext: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (expected.length !== SCRYPT_KEYLEN) return false;
  const derived = await scryptAsync(plaintext, salt, SCRYPT_KEYLEN);
  // Constant-time comparison; same length enforced above.
  return timingSafeEqual(derived, expected);
}
