/**
 * Cloud Functions entry (just the brain trigger now).
 *
 * The `api` HTTPS function used to live here. It moved to
 * Cloud Run because Fastify 5's body parser hangs on the
 * Cloud Functions 2nd-gen request stream. See
 * `apps/api/Dockerfile` + the Cloud Run service
 * `worktracker-api` for the REST + MCP server.
 *
 * The brain trigger stays here: Firestore events are cheap
 * and event-driven, which is exactly what Cloud Functions
 * is good at.
 *
 * Retry policy: the brain catches unhandled exceptions, records
 * a `commands/{id}/failures` sub-doc, and re-throws so Eventarc
 * retries. After `WORKTRACKER_BRAIN_MAX_FAILURES` (default 3) the
 * brain marks the command as `failed` and returns normally; the
 * trigger then stops retrying and the operator can inspect via
 * `GET /api/commands/{id}/failures` and re-enqueue with
 * `POST /api/commands/{id}/replay`.
 */

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { setGlobalOptions } from 'firebase-functions/v2/options';
import { handleCommandCreated } from './brain.js';

setGlobalOptions({
  region: 'us-central1',
  maxInstances: 10,
});

function readMaxFailures(): number {
  const v = process.env.WORKTRACKER_BRAIN_MAX_FAILURES;
  if (!v) return 3;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

// onDocumentWritten (not onDocumentCreated) so the operator's
// `POST /api/commands/{id}/replay` re-fires the brain after it
// marks a command as `failed`. The brain guard in `handleCommandCreated`
// (`status !== 'queued' → return`) keeps it from looping on its own
// status updates (queued → evaluating → applied/rejected/failed).
export const brain = onDocumentWritten(
  {
    region: 'us-central1',
    document: 'commands/{commandId}',
    memory: '256MiB',
    timeoutSeconds: 30,
  },
  async (event) => {
    if (!event.data || !event.data.after) return;
    await handleCommandCreated(event.data.after, { maxFailures: readMaxFailures() });
  },
);
