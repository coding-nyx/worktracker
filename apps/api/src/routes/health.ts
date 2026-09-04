/**
 * Health probes. Cloud Run's default startup + liveness probe
 * hits `GET /` on port 8080, so we register `/` as a no-op 200.
 * `/api/healthz` is the same probe under the conventional path;
 * `/api/readyz` waits for Firestore to respond.
 */

import type { FastifyInstance } from 'fastify';
import { getDb } from '../firestore.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Root probe — Cloud Run's default healthcheck hits GET /.
  // Keep this fast (no Firestore round-trip); the readiness
  // probe below is the "is the system actually ready" check.
  app.get('/', async () => ({ ok: true, service: 'worktracker-api' }));
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
