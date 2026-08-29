/**
 * Health probes. `/healthz` is a fast liveness check; `/readyz`
 * waits for Firestore to respond. Both are public.
 */

import type { FastifyInstance } from 'fastify';
import { getDb } from '../firestore.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/healthz', async () => ({ ok: true }));

  app.get('/api/readyz', async () => {
    try {
      await getDb().collection('sources').limit(1).get();
      return { ready: true };
    } catch (err) {
      app.log.error({ err }, 'readiness check failed');
      return { ready: false, error: (err as Error).message };
    }
  });
}
