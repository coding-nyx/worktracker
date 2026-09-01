/**
 * Auth-related REST routes. The MCP server uses the same
 * `requireSource` preHandler and shares the `users/{firebase_uid}`
 * records that these routes read.
 *
 * Endpoints:
 *   GET /api/auth/me  — return the current worktracker user
 *     record (id, email, is_admin, …). The first sign-in mints
 *     the record; the first user is auto-promoted to admin.
 */

import type { FastifyInstance } from 'fastify';
import { requireSource } from '../auth.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/auth/me', { preHandler: requireSource }, async (req, reply) => {
    // requireSource runs first; the only authenticated kind we
    // attach a `user` to is `kind: 'user'`. Admin and source
    // tokens don't have a worktracker user record.
    if (req.auth?.kind !== 'user' || !req.auth.user) {
      reply.code(404).send({ error: { code: 'not_a_user', message: 'no worktracker user for this token' } });
      return;
    }
    reply.send({ user: req.auth.user });
  });
}
