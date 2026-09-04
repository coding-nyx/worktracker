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
import type { ApiTokenScope, Client, WorktrackerUser } from '@worktracker/types';
import { applicationDefault, getApp, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import type { DocumentReference } from 'firebase-admin/firestore';
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
      source?: Client;
      user?: WorktrackerUser;
      /**
       * Effective permission scope of the caller. Set by
       * `requireSource` for `kind: 'user'` clients (personal
       * access tokens, stored at `sources/{bearer_id}`); for
       * admin/user/legacy-source bearers it's implicit and
       * resolved on demand by `getEffectiveScope`. The dispatch
       * layer (`dispatchTool`) consults this to gate write and
       * admin tools.
       */
      scope?: ApiTokenScope;
      /** For `kind: 'user'` clients, the bearer_id (doc id) + owner_uid + scope. */
      token?: { id: string; owner_uid: string; scope: ApiTokenScope };
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
 * the Hermes bridge, board CRUD, user management.
 *
 * Accepts any caller whose effective scope is `admin`:
 *   - the static `WORKTRACKER_ADMIN_TOKEN` (operator scripts)
 *   - a Firebase Auth ID token whose `users/{uid}` doc has
 *     `is_admin: true` (the web UI's admin)
 *   - a `wt_<tokenId>` API token with `scope: 'admin'`
 *
 * Composed of `requireSource` (handles all three token shapes
 * and resolves to a worktracker user / synthetic source / admin)
 * plus a `hasScopeAtLeast('admin')` gate.
 */
export async function requireAdmin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  await requireSource(req, _reply);
  if (!hasScopeAtLeast(req, 'admin')) {
    throw new ForbiddenError('admin scope required');
  }
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
  // Personal clients: `wt_<bearerId>`. The bearerId is the
  // doc id of the `sources` collection, so lookup is O(1).
  // Knowing the bearerId IS the credential — we don't store a
  // hash because the random id already has 256 bits of entropy.
  if (token.startsWith('wt_')) {
    const tokenId = token.slice(3);
    if (tokenId.length >= 16) {
      const apiToken = await resolveApiTokenFromId(tokenId);
      if (apiToken) {
        req.auth = {
          kind: 'source',
          source: apiToken.source,
          scope: apiToken.scope,
          token: { id: tokenId, owner_uid: apiToken.owner_uid, scope: apiToken.scope },
        };
        return;
      }
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
    //
    // Pin the projectId explicitly. Without it, the SDK falls
    // back to the credential's project_id, which in our case
    // resolves to a stale "worktracker-local" project on Cloud
    // Run when GCLOUD_PROJECT isn't set, and every Firestore
    // call comes back PERMISSION_DENIED. Pinning to the
    // configured projectId is the safe move.
    firebaseApp = initializeApp({
      credential: applicationDefault(),
      projectId: loadConfig().projectId,
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

async function resolveSourceFromToken(token: string): Promise<Client | null> {
  // Optimistic fast path: the token has the form `<source>.<key>`.
  const dot = token.indexOf('.');
  if (dot > 0) {
    const name = token.slice(0, dot);
    const plaintext = token.slice(dot + 1);
    const db = getDb();
    const doc = await db.collection('sources').doc(name).get();
    if (!doc.exists) return null;
    const data = doc.data() as Client;
    if (data.api_key_hash && (await verifyApiKey(plaintext, data.api_key_hash))) {
      touchLastUsed(doc.ref);
      return data;
    }
  }
  // Slow path: scan all sources. Bounded by single-user v0.
  const db = getDb();
  const snap = await db.collection('sources').get();
  for (const doc of snap.docs) {
    const data = doc.data() as Client;
    if (data.api_key_hash && (await verifyApiKey(token, data.api_key_hash))) {
      touchLastUsed(doc.ref);
      return data;
    }
  }
  return null;
}

/**
 * Best-effort write of `last_used_at` to the source doc. Mirrors
 * the same one-liner at the bottom of `resolveApiTokenFromId` so
 * the agents (Hermes, Claude, Codex) get the same staleness
 * signal the personal access tokens do.
 *
 * Fire-and-forget: the read already succeeded, so a failed
 * touch is fine. The admin UI's `last used` column is a hint,
 * not a contract.
 */
function touchLastUsed(ref: DocumentReference): void {
  void ref
    .set({ last_used_at: nowIso(), updated_at: nowIso() }, { merge: true })
    .catch((err: unknown) => {
      // Slice 8: previously swallowed silently. With the agent
      // path now also touching, a dropped write leaves the
      // admin's "last used" column stuck on "never" and is
      // hard to diagnose. Log once so the operator can see it.
      console.error('[auth] touchLastUsed failed for', ref.path, err);
    });
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

// ----- API tokens (personal access tokens) -----

/**
 * Mint a new personal `kind: 'user'` client. Slice 2: this
 * replaces `mintApiToken`. The bearer_id is a 32-byte
 * base64url-encoded random string; the bearer is `wt_<bearer_id>`;
 * the doc id is the bearer_id (so lookup is O(1)). Knowing the
 * bearer_id IS the credential — no hash is stored.
 */
export interface MintedClient {
  record: Client;
  bearer: string;
}

export async function mintUserClient(input: {
  name: string;
  owner_uid: string;
  owner_email: string;
  scope: ApiTokenScope;
}): Promise<MintedClient> {
  const bearerId = randomBytes(32).toString('base64url');
  const bearer = `wt_${bearerId}`;
  const now = nowIso();
  const record: Client = {
    name: bearerId,
    display_name: input.name,
    kind: 'user',
    scope: input.scope,
    owner_uid: input.owner_uid,
    owner_email: input.owner_email,
    manifest: {
      name: bearerId,
      display_name: input.name,
      kind: 'user',
      capabilities: [],
      version: '0.0.0',
    },
    capabilities: [],
    webhook_secret: null,
    enabled: true,
    created_at: now,
    updated_at: now,
    last_used_at: null,
    rotated_at: null,
    revoked_at: null,
    bearer_id: bearerId,
  };
  await getDb().collection('sources').doc(bearerId).set(record);
  return { record, bearer };
}

/**
 * Rotate a personal `kind: 'user'` client's bearer. Generates a
 * fresh `bearer_id`, writes the new record, and returns the new
 * plaintext bearer. The old bearer is invalidated immediately
 * (the doc id changes; the old id no longer resolves).
 */
export async function rotateUserClient(input: {
  name: string;
  owner_uid: string;
  owner_email: string;
  scope: ApiTokenScope;
  old_bearer_id: string;
}): Promise<MintedClient> {
  const newBearerId = randomBytes(32).toString('base64url');
  const newBearer = `wt_${newBearerId}`;
  const now = nowIso();
  // Read the old record to copy display_name and other immutable fields.
  const oldRef = getDb().collection('sources').doc(input.old_bearer_id);
  const oldSnap = await oldRef.get();
  const old = oldSnap.exists ? (oldSnap.data() as Client) : null;
  const record: Client = {
    name: newBearerId,
    display_name: input.name,
    kind: 'user',
    scope: input.scope,
    owner_uid: input.owner_uid,
    owner_email: input.owner_email,
    manifest: {
      name: newBearerId,
      display_name: input.name,
      kind: 'user',
      capabilities: old?.capabilities ?? [],
      version: '0.0.0',
    },
    capabilities: old?.capabilities ?? [],
    webhook_secret: null,
    enabled: true,
    created_at: old?.created_at ?? now,
    updated_at: now,
    last_used_at: null,
    rotated_at: now,
    revoked_at: null,
    bearer_id: newBearerId,
  };
  // Write the new doc, then revoke + delete the old. The delete
  // is best-effort: even if it fails, the old bearer_id doesn't
  // resolve to the new doc.
  await getDb().collection('sources').doc(newBearerId).set(record);
  await oldRef.set({ revoked_at: now, updated_at: now }, { merge: true });
  return { record, bearer: newBearer };
}

/**
 * Look up a personal client by bearer_id. The bearer is
 * `wt_<bearer_id>`; the doc id is the bearer_id. Returns null if
 * the client doesn't exist, is disabled, or is revoked.
 *
 * Slice 2: the `api_tokens` collection is gone. Personal access
 * tokens are `clients/{bearer_id}` rows with `kind: 'user'`.
 * The doc shape is the full `Client` record, so the lookup
 * returns the row directly (no synthetic source object).
 */
async function resolveApiTokenFromId(
  tokenId: string,
): Promise<{ source: Client; scope: ApiTokenScope; owner_uid: string } | null> {
  const ref = getDb().collection('sources').doc(tokenId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() as Client;
  if (data.kind !== 'user') return null;
  if (!data.enabled) return null;
  if (data.revoked_at) return null;
  // Best-effort last-used touch. Don't await; a failed touch
  // shouldn't block auth, and the read-after-write is fine
  // because the read already succeeded.
  touchLastUsed(ref);
  return { source: data, scope: data.scope, owner_uid: data.owner_uid ?? '' };
}

/**
 * Compute the caller's effective permission scope. Used by the
 * dispatch layer to gate write and admin tools.
 *
 *   - Admin token or `req.auth.kind === 'admin'`  -> 'admin'
 *   - Firebase user with `is_admin: true`         -> 'admin'
 *   - Synthetic 'web' source (React app)         -> 'admin'
 *   - Legacy source bearer whose name is on the
 *     `adminSources` allowlist (see `Config.adminSources`,
 *     default `['hermes', 'claude', 'codex']`)    -> 'admin'
 *   - API token (req.auth.scope set)             -> token's scope
 *   - Any other legacy source bearer             -> 'read_write'
 *
 * The legacy allowlist preserves the v0.4 contract that the
 * three named MCP clients had full read+write+admin access
 * before API tokens existed. Unknown legacy sources stay at
 * `read_write`; new API tokens are the only callers that get
 * the explicit downscoped behavior.
 *
 * Slice 1 (wrecking ball): the `adminSources` allowlist is gone.
 * A source's scope is whatever its `SourceRegistration.scope`
 * field says. Legacy sources without the field default to
 * `read_write`; the seed (slice 2) re-registers every source
 * with an explicit scope.
 */
export function getEffectiveScope(req: FastifyRequest): ApiTokenScope {
  if (req.auth?.kind === 'admin') return 'admin';
  if (req.auth?.source?.name === 'web') return 'admin';
  if (req.auth?.user?.is_admin === true) return 'admin';
  if (req.auth?.scope) return req.auth.scope;
  if (req.auth?.source?.scope) return req.auth.source.scope;
  return 'read_write';
}

const SCOPE_RANK: Record<ApiTokenScope, number> = {
  read: 1,
  read_write: 2,
  admin: 3,
};

export function hasScopeAtLeast(req: FastifyRequest, required: ApiTokenScope): boolean {
  return SCOPE_RANK[getEffectiveScope(req)] >= SCOPE_RANK[required];
}

/**
 * PreHandler: reject requests whose effective scope is below
 * `required`. Used to gate write and admin REST routes so an
 * API token with `read` scope literally cannot POST or PATCH,
 * even if it knows the route. Mirror of the same check the MCP
 * dispatchTool does inside its tool switch.
 */
export function requireScopeAtLeast(required: ApiTokenScope) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!hasScopeAtLeast(req, required)) {
      throw new ForbiddenError(`${required} scope required`);
    }
  };
}
