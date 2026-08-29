/**
 * Command debug routes. Read-only — for the Sources view's
 * "recent commands" panel and for the e2e test harness.
 *
 * Dead-letter admin routes (POST /api/commands/{id}/replay and
 * GET /api/commands/{id}/failures) are defined in
 * `commands-admin.ts` and registered separately to keep the
 * surface here narrow. The brain itself records failures to
 * `commands/{id}/failures` and marks commands as `failed` after
 * WORKTRACKER_BRAIN_MAX_FAILURES retries — see `src/brain.ts`.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../firestore.js';
import { requireSource } from '../auth.js';
import type { Command } from '../local-types/index';

const ListQuerySchema = z.object({
  status: z.enum(['queued', 'evaluating', 'applied', 'rejected', 'failed']).optional(),
  source: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function commandsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/commands', { preHandler: requireSource }, async (req) => {
    const query = ListQuerySchema.parse(req.query);
    let ref = getDb().collection('commands').orderBy('created_at', 'desc');
    if (query.status) ref = ref.where('status', '==', query.status);
    if (query.source) ref = ref.where('source', '==', query.source);
    ref = ref.limit(query.limit);
    const snap = await ref.get();
    return { commands: snap.docs.map((d) => d.data() as Command) };
  });

  app.get('/api/commands/:id', { preHandler: requireSource }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const doc = await getDb().collection('commands').doc(id).get();
    if (!doc.exists) return { command: null };
    return { command: doc.data() as Command };
  });
}
