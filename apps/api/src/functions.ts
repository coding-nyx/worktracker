/**
 * Cloud Functions entry (brain trigger).
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
// `POST /api/commands/{id}/replay` can re-fire the brain after it
// marks a command as `failed`. The `brain` guard in `handleCommandCreated`
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
