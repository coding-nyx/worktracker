/**
 * Dead-letter admin routes. Surface for operators to inspect
 * commands the brain gave up on, and to manually re-queue a
 * command after fixing the underlying issue.
 *
 * Endpoints:
 *   GET  /api/commands/:id/failures — list the `failures` sub-col
 *   POST /api/commands/:id/replay   — reset a `failed` (or
 *                                    `rejected`) command back to
 *                                    `queued` so the brain trigger
 *                                    fires again
 *
 * Both require the admin token. The replay endpoint refuses to
 * re-queue commands that haven't reached a terminal status, so
 * a "live" command can't be restarted by accident.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../firestore.js';
import { requireAdmin } from '../auth.js';
import { NotFoundError, InvalidInputError } from '../errors.js';
import { nowIso } from '../ids.js';
import type { Command, CommandFailure } from '../local-types/index';

const CommandId = z.string().min(1).max(64);

export async function commandsAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/commands/:id/failures',
    { preHandler: requireAdmin },
    async (req) => {
      const { id } = z.object({ id: CommandId }).parse(req.params);
      const commandRef = getDb().collection('commands').doc(id);
      const commandSnap = await commandRef.get();
      if (!commandSnap.exists) {
        throw new NotFoundError(`command ${id} not found`);
      }
      const failuresSnap = await commandRef
        .collection('failures')
        .orderBy('occurred_at', 'asc')
        .get();
      const failures: CommandFailure[] = failuresSnap.docs.map(
        (d) => d.data() as CommandFailure,
      );
      const command = commandSnap.data() as Command;
      return {
        command_id: id,
        status: command.status,
        failure_count: command.failure_count ?? 0,
        failed_at: command.failed_at,
        failures,
      };
    },
  );

  app.post(
    '/api/commands/:id/replay',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = z.object({ id: CommandId }).parse(req.params);
      const commandRef = getDb().collection('commands').doc(id);
      const commandSnap = await commandRef.get();
      if (!commandSnap.exists) {
        throw new NotFoundError(`command ${id} not found`);
      }
      const command = commandSnap.data() as Command;
      if (command.status !== 'failed' && command.status !== 'rejected') {
        throw new InvalidInputError(
          `command is ${command.status}; only failed or rejected commands can be replayed`,
        );
      }
      // Re-queue: clear the failure markers, move back to `queued`.
      // The brain trigger will fire on this write and process the
      // command from scratch. We keep `failures/` sub-docs around
      // for the operator's history until a successful run rotates
      // them out (or they manually delete them).
      const now = nowIso();
      await commandRef.update({
        status: 'queued',
        error: null,
        failure_count: 0,
        failed_at: null,
        requeued_at: now,
      });
      reply.code(202);
      return { command_id: id, status: 'queued', requeued_at: now };
    },
  );
}
