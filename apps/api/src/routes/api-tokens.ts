/**
 * Personal API token REST routes. Lets a signed-in user mint,
 * list, and revoke personal access tokens for external MCP
 * clients (Claude Code, Codex, Hermes). The bearer plaintext
 * is shown exactly once at mint time; later reads return the
 * record (id, name, scope, created_at, last_used_at) without
 * the secret.
 *
 * Endpoints:
 *   GET    /api/auth/tokens       list the caller's tokens
 *   POST   /api/auth/tokens       mint a new token (returns bearer)
 *   DELETE /api/auth/tokens/:id   revoke (soft-delete) the caller's token
 *
 * The mint flow requires a Firebase user (`req.auth.kind ===
 * 'user'`). The admin token (`WORKTRACKER_ADMIN_TOKEN`) and
 * source bearers are rejected — those have their own paths
 * for elevated operations.
 *
 * Admin scope minting: only an `is_admin: true` user can mint
 * a token with `scope: 'admin'`. Non-admins get `read` or
 * `read_write` only.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { API_TOKEN_SCOPES, type ApiToken } from '@worktracker/types';
import { getDb } from '../firestore.js';
import { mintApiToken, requireSource } from '../auth.js';
import { ForbiddenError, InvalidInputError, NotFoundError, UnauthorizedError } from '../errors.js';
import { nowIso } from '../ids.js';

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  scope: z.enum(API_TOKEN_SCOPES),
});

/**
 * Require a Firebase Auth user (not a source bearer, not the
 * static admin token). The token-management surface is a
 * personal-account feature; admin operations have their own
 * routes and we don't want an admin's static token accidentally
 * minting tokens that look like the admin minted them.
 */
function requireUser(req: FastifyRequest): asserts req is FastifyRequest & {
  auth: { kind: 'user'; user: import('@worktracker/types').WorktrackerUser };
} {
  if (req.auth?.kind !== 'user' || !req.auth.user) {
    throw new UnauthorizedError('sign in to manage personal API tokens');
  }
}

export async function apiTokensRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/auth/tokens', { preHandler: requireSource }, async (req) => {
    requireUser(req);
    const snap = await getDb()
      .collection('api_tokens')
      .where('owner_uid', '==', req.auth.user.firebase_uid)
      .orderBy('created_at', 'desc')
      .get();
    const tokens: ApiToken[] = snap.docs.map((d) => d.data() as ApiToken);
    return { tokens };
  });

  app.post('/api/auth/tokens', { preHandler: requireSource }, async (req) => {
    requireUser(req);
    const body = CreateBody.parse(req.body);
    if (body.scope === 'admin' && !req.auth.user.is_admin) {
      throw new ForbiddenError('only admins can mint admin-scope tokens');
    }
    if (body.name.trim().length === 0) {
      throw new InvalidInputError('token name is required');
    }
    const { record, bearer } = await mintApiToken({
      name: body.name.trim(),
      owner_uid: req.auth.user.firebase_uid,
      owner_email: req.auth.user.email,
      scope: body.scope,
    });
    // Return the record AND the bearer. The bearer is the only
    // time the plaintext is ever sent over the wire; the
    // settings page is responsible for surfacing it once and
    // never again.
    return { token: record, bearer };
  });

  app.delete<{ Params: { id: string } }>(
    '/api/auth/tokens/:id',
    { preHandler: requireSource },
    async (req) => {
      requireUser(req);
      const ref = getDb().collection('api_tokens').doc(req.params.id);
      const snap = await ref.get();
      if (!snap.exists) throw new NotFoundError(`token ${req.params.id} not found`);
      const data = snap.data() as ApiToken;
      // Only the owner can revoke their own token. Admins can
      // also revoke any token — useful for cutting off a leaked
      // credential without needing the owner's session.
      if (data.owner_uid !== req.auth.user.firebase_uid && !req.auth.user.is_admin) {
        throw new ForbiddenError('only the token owner or an admin can revoke');
      }
      if (data.revoked_at) {
        return { token: data };
      }
      const revoked: ApiToken = { ...data, revoked_at: nowIso() };
      await ref.set(revoked, { merge: true });
      return { token: revoked };
    },
  );
}
