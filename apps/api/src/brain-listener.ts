/**
 * Brain listener — Admin SDK native Firestore listener.
 *
 * Slice 4: the brain was previously a Firebase Functions v2 trigger
 * (`onDocumentWritten('commands/{commandId}')`) deployed via
 * `firebase deploy --only functions`. That path hit a Cloud Run
 * healthcheck wall: the event-driven trigger never binds to PORT,
 * and every new revision failed its startup probe, so Cloud Run
 * kept serving the previous (slice 1) revision indefinitely.
 *
 * This file replaces the Functions wrapper with the Admin SDK's
 * native `onSnapshot` listener. It runs as a regular Cloud Run
 * service — the container starts a minimal HTTP server (for the
 * `/` healthcheck) and a single Firestore document listener.
 * The listener is the same business logic the Functions wrapper
 * invoked, just hooked up via a different runtime.
 *
 * The HTTP server is intentionally tiny: it doesn't expose any
 * of the REST or MCP routes (those live in the separate
 * `worktracker-api` service). A no-op `/` returns 200 so the
 * Cloud Run default startup probe passes.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { Command } from '@worktracker/types';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { handleCommandCreated } from './brain.js';
import { newRequestTrace, logTraceEvent } from './trace.js';
import { loadConfig } from './config.js';
import { getDb } from './firestore.js';

const DEFAULT_MAX_FAILURES = 3;

function readMaxFailures(): number {
  const v = process.env.WORKTRACKER_BRAIN_MAX_FAILURES;
  if (!v) return DEFAULT_MAX_FAILURES;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FAILURES;
}

/**
 * Start the brain listener. Returns an unsubscribe function.
 * The Admin SDK's `onSnapshot` fires the callback for the
 * initial state and every subsequent write. We mirror the
 * Functions wrapper's `onDocumentWritten` semantics by checking
 * the command's `status` and only processing queued commands.
 *
 * The `id` field comes from `after.id` in the Functions wrapper;
 * here it comes from the document's own id. The brain's
 * `handleCommandCreated` accepts both shapes (it reads `command.id`
 * off the data and falls back to the snapshot id when needed).
 */
export function startBrainListener(opts: { db?: Firestore; actor?: string; maxFailures?: number } = {}): () => void {
  // Slice 5: pin the projectId explicitly so the Admin SDK
  // doesn't fall back to a stale credential project on Cloud Run
  // (see auth.ts note). The Functions wrapper did this for us;
  // now we have to do it ourselves.
  try {
    const cfg = loadConfig();
    initializeApp({ projectId: cfg.projectId });
  } catch {
    // Already initialized (e.g. when the Fastify app in the
    // same process called initializeApp first). Swallow.
  }
  // Use the local getDb() wrapper, NOT firebase-admin's
  // getFirestore() directly. The local wrapper calls
  // db.settings({ ignoreUndefinedProperties: true }), which is
  // required for the event write — command.source_event_id is
  // undefined for raw enqueues (e.g. operator-scripts that don't
  // set it), and the admin SDK otherwise rejects the write with
  // "Cannot use 'undefined' as a Firestore value (found in field
  // 'source_event_id')".
  const db = opts.db ?? getDb();
  const actor = opts.actor ?? 'brain:listener';
  const maxFailures = opts.maxFailures ?? readMaxFailures();

  const trace = newRequestTrace();
  logTraceEvent(trace, 'brain.listener.start', { collection: 'commands' });

  // Watch the whole `commands` collection. The listener is
  // cheap (Firestore uses the document id as the cursor) and
  // the brain's status guard drops anything that isn't queued,
  // so a `commands` write only triggers one handler invocation.
  // This replaces `onDocumentWritten('commands/{commandId}')`
  // from the Functions wrapper.
  const unsub = db
    .collection('commands')
    .onSnapshot(
      (snap) => {
        for (const change of snap.docChanges()) {
          if (change.type !== 'added' && change.type !== 'modified') continue;
          const doc = change.doc;
          // Mirror the Functions wrapper: skip on the initial
          // snapshot (type='added' fires for every existing doc
          // when the listener attaches). The `status` field on
          // the doc is the brain's own state machine; only
          // freshly-written `queued` docs are real work.
          if (change.type === 'added' && (doc as unknown as { metadata?: { fromCache?: boolean } }).metadata?.fromCache) {
            // Initial state — already-applied docs from a
            // previous container incarnation. Skip.
            continue;
          }
          // The brain's handler accepts a `{ data(): unknown }`
          // shape — the Admin SDK's `QueryDocumentSnapshot` matches
          // that interface, so we pass it through directly.
          handleCommandCreated(doc as unknown as { data(): unknown }, {
            db,
            actor,
            maxFailures,
          }).catch((err) => {
            console.error('[brain-listener] handler threw', err);
          });
        }
      },
      (err) => {
        console.error('[brain-listener] snapshot error', err);
      },
    );

  return unsub;
}
