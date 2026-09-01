/**
 * Admin-only user management REST routes. The Firebase Auth user
 * is the source of truth for credentials; the `users/{uid}`
 * document holds the WorkTracker-specific fields (`is_admin`,
 * `enabled`, `display_name`). The admin updates the latter here.
 *
 * Endpoints:
 *   GET  /api/admin/users          list all worktracker users
 *   PATCH /api/admin/users/:uid     update is_admin / enabled
 *   POST /api/admin/users/invite    create a Firebase Auth user
 *                                   (email + temp password) and
 *                                   the matching users/{uid} doc
 *
 * All routes require admin (static admin token OR is_admin: true
 * Firebase user). The "self-demote" guard prevents the only
 * admin from removing their own admin flag and locking everyone
 * out — at least one admin must remain.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getAuth } from 'firebase-admin/auth';
import type { WorktrackerUser } from '@worktracker/types';
import { requireAdmin } from '../auth.js';
import { getDb } from '../firestore.js';
import { nowIso, ulid } from '../ids.js';
import { loadConfig } from '../config.js';

function requireRealAdmin(req: FastifyRequest): asserts req is FastifyRequest & { auth: { kind: 'admin' } | { kind: 'user'; user: WorktrackerUser } } {
  // requireAdmin must have run first and either set kind: 'admin'
  // or kind: 'user' with is_admin. We re-check the is_admin flag
  // here for the user case so a future bug in requireAdmin can't
  // silently open this surface.
  if (req.auth?.kind === 'admin') return;
  if (req.auth?.kind === 'user' && req.auth.user?.is_admin) return;
  const e = new Error('admin access required') as Error & { statusCode?: number };
  e.statusCode = 403;
  throw e;
}

export async function adminUsersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/users', { preHandler: requireAdmin }, async (req, reply) => {
    requireRealAdmin(req);
    const snap = await getDb().collection('users').get();
    const users: WorktrackerUser[] = snap.docs.map((d) => d.data() as WorktrackerUser);
    users.sort((a, b) => (a.email || '').localeCompare(b.email || ''));
    reply.send({ users });
  });

  app.patch<{ Params: { uid: string } }>(
    '/api/admin/users/:uid',
    { preHandler: requireAdmin },
    async (req, reply) => {
      requireRealAdmin(req);
      const body = z
        .object({
          is_admin: z.boolean().optional(),
          enabled: z.boolean().optional(),
          display_name: z.string().max(120).nullable().optional(),
        })
        .parse(req.body);

      const ref = getDb().collection('users').doc(req.params.uid);
      const snap = await ref.get();
      if (!snap.exists) {
        reply.code(404).send({ error: { code: 'not_found', message: 'user not found' } });
        return;
      }
      const current = snap.data() as WorktrackerUser;

      // Self-demote guard. If the caller is removing their own
      // admin flag, require at least one other admin to remain.
      const selfUid = req.auth?.kind === 'user' ? req.auth.user.firebase_uid : null;
      if (selfUid === req.params.uid && body.is_admin === false) {
        const admins = await getDb().collection('users').where('is_admin', '==', true).get();
        if (admins.size <= 1) {
          reply.code(409).send({
            error: {
              code: 'last_admin',
              message: 'cannot demote the only admin; promote another user first',
            },
          });
          return;
        }
      }
      // Same guard for `enabled: false` — the only admin must
      // not be able to disable themselves.
      if (selfUid === req.params.uid && body.enabled === false) {
        reply.code(409).send({
          error: {
            code: 'last_admin',
            message: 'cannot disable the only admin; promote another user first',
          },
        });
        return;
      }

      const patch: Partial<WorktrackerUser> = { updated_at: nowIso() };
      if (body.is_admin !== undefined) patch.is_admin = body.is_admin;
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      if (body.display_name !== undefined) patch.display_name = body.display_name;
      await ref.set(patch, { merge: true });

      // Also flip the Firebase Auth `disabled` flag so the user
      // can't sign in if they've been disabled here. The admin
      // SDK call is best-effort — if it fails (e.g. user doc
      // created before Firebase Auth user existed), the worktracker
      // `enabled` flag still blocks API access.
      if (body.enabled !== undefined) {
        try {
          await getAuth().updateUser(req.params.uid, { disabled: !body.enabled });
        } catch {
          // ignore
        }
      }
      const next = (await ref.get()).data() as WorktrackerUser;
      reply.send({ user: next });
    },
  );

  app.post('/api/admin/users/invite', { preHandler: requireAdmin }, async (req, reply) => {
    requireRealAdmin(req);
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(8).max(128),
        display_name: z.string().max(120).optional(),
        is_admin: z.boolean().optional(),
      })
      .parse(req.body);

    // Create the Firebase Auth user.
    let firebaseUid: string;
    try {
      const created = await getAuth().createUser({
        email: body.email,
        password: body.password,
        displayName: body.display_name,
        disabled: false,
      });
      firebaseUid = created.uid;
    } catch (err) {
      reply.code(400).send({
        error: {
          code: 'firebase_create_failed',
          message: (err as Error).message,
        },
      });
      return;
    }

    // Mint the matching worktracker user record.
    const now = nowIso();
    const user: WorktrackerUser = {
      firebase_uid: firebaseUid,
      email: body.email,
      display_name: body.display_name ?? null,
      is_admin: body.is_admin ?? false,
      enabled: true,
      created_at: now,
      updated_at: now,
      last_seen_at: null,
    };
    await getDb().collection('users').doc(firebaseUid).set(user);
    void ulid; // keep import for parity with other routes
    void loadConfig; // keep import for parity
    reply.send({ user });
  });
}
