/**
 * Authentication middleware. Two token types:
 *   - Admin token: WORKTRACKER_ADMIN_TOKEN; can do everything
 *     including source registration and conflict resolution.
 *   - Per-source bearer token: the API key returned at source
 *     registration. The token is a scrypt hash of the source's
 *     API key; the request carries the plaintext key in the
 *     `Authorization: Bearer …` header.
 *
 * The middleware resolves the source name from the token and
 * attaches it to the request.
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
import type { SourceRegistration } from './local-types/index';
import { getDb } from './firestore.js';
import { ForbiddenError, UnauthorizedError } from './errors.js';
import { loadConfig } from './config.js';

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
      kind: 'admin' | 'source';
      source?: SourceRegistration;
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
 */
export async function requireAdmin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = extractBearer(req);
  if (!token || token !== ADMIN_TOKEN) {
    throw new UnauthorizedError('admin token invalid');
  }
  req.auth = { kind: 'admin' };
}

/**
 * Source auth. Accepts either the admin token OR a per-source
 * bearer token. Resolves the source by looking up the
 * `sources/{name}` document whose `api_key_hash` matches the
 * bearer (we use the source name as a routing key for fast lookup).
 *
 * The lookup is O(1) when the bearer is a `<source>.<key>` token
 * (source name as a prefix); for plain bearer tokens we fall
 * back to iterating the `sources` collection.
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
  const source = await resolveSourceFromToken(token);
  if (!source) {
    throw new UnauthorizedError('bearer token invalid');
  }
  if (!source.enabled) {
    throw new ForbiddenError('source disabled');
  }
  req.auth = { kind: 'source', source };
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
