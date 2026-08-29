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
 */

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { setGlobalOptions } from 'firebase-functions/v2/options';
import { handleCommandCreated } from './brain.js';

setGlobalOptions({
  region: 'us-central1',
  maxInstances: 10,
});

export const brain = onDocumentCreated(
  {
    region: 'us-central1',
    document: 'commands/{commandId}',
    memory: '256MiB',
    timeoutSeconds: 30,
  },
  async (event) => {
    if (!event.data) return;
    await handleCommandCreated(event.data);
  },
);
