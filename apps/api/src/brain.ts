/**
 * The brain — a Firestore trigger on `commands/{commandId}`.
 * Every source submits commands by writing a `commands` document
 * with `status: 'queued'`. The trigger:
 *   1. Reads the current `work_items/{itemId}` (if any) in a
 *      transaction.
 *   2. Evaluates the command: field-level validation, invariants,
 *      conflict check against `version`.
 *   3. On accept: writes the new item + an event, marks the
 *      command as `applied`.
 *   4. On reject (structured error): writes a `conflicts` document,
 *      marks the command as `rejected` with a human-readable reason.
 *   5. On unhandled exception: writes a `commands/{id}/failures`
 *      sub-doc, increments `failure_count`. After
 *      `MAX_FAILURES` the command is moved to `failed` and the
 *      function returns normally so the trigger stops retrying.
 *      That gives operators a "this command is poison, fix it
 *      manually" surface instead of infinite Eventarc retries.
 *
 * Idempotency: a composite index on `(source, source_event_id)`
 * lets the brain quickly reject duplicate commands.
 */

import type { Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { Command } from './local-types/index';
import { applyCommand, readWorkItem } from './repo.js';
import { ulid, nowIso } from './ids.js';
import { WorkTrackerError } from './errors.js';
import { getDb } from './firestore.js';

export interface BrainOptions {
  /** Override the db (for local dev or tests). */
  db?: Firestore;
  /** Override the actor label written to events. */
  actor?: string;
  /**
   * Override the dead-letter threshold. After this many recorded
   * failures, the command is moved to `status: 'failed'` and the
   * trigger stops retrying. Defaults to 3.
   */
  maxFailures?: number;
}

const DEFAULT_MAX_FAILURES = 3;

/**
 * The trigger entry point. Wired in `functions.ts` as a Cloud Function
 * `onDocumentWritten('commands/{id}')` handler (so the operator's
 * `POST /api/commands/{id}/replay` can re-fire the brain). The
 * `status !== 'queued'` guard below keeps it from looping on the
 * brain's own status updates.
 *
 * `QueryDocumentSnapshot` covers the original `onDocumentCreated`
 * trigger; `DocumentSnapshot` covers `onDocumentWritten`'s
 * `event.data.after`. Both expose `data()` identically.
 */
export async function handleCommandCreated(
  snap: QueryDocumentSnapshot | { data(): unknown },
  opts: BrainOptions = {},
): Promise<void> {
  const command = snap.data() as Command;
  // Skip commands that already reached a terminal status. The
  // trigger fires on `onDocumentCreated` so this is defensive, but
  // it also covers the case where an operator manually moves a
  // command back to a non-terminal state.
  if (command.status === 'applied' || command.status === 'rejected' || command.status === 'failed') {
    return;
  }
  if (command.status !== 'queued') {
    return;
  }
  // Poison-pill guard: if the command has already hit the failure
  // threshold but somehow is back to `queued` (manual reset),
  // ensure we don't process it again. The operator must clear
  // `failed_at` to actually re-enqueue.
  if (command.failed_at) {
    console.warn('[brain] command', command.id, 'has failed_at set; skipping');
    return;
  }
  const db = opts.db ?? getDb();
  const actor = opts.actor ?? `brain:trigger`;
  const maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;

  // 1. Idempotency: if a command with the same
  //    (source, source_event_id) already exists with status
  //    applied or rejected, short-circuit.
  if (command.source_event_id) {
    const dup = await db
      .collection('commands')
      .where('source', '==', command.source)
      .where('source_event_id', '==', command.source_event_id)
      .get();
    for (const d of dup.docs) {
      if (d.id === command.id) continue;
      const other = d.data() as Command;
      if (other.status === 'applied' || other.status === 'rejected') {
        await markRejected(db, command, 'duplicate source_event_id', actor);
        return;
      }
    }
  }

  // 2. Run the command in a transaction.
  try {
    const result = await db.runTransaction(async (tx) => {
      return await applyCommand({
        db,
        tx,
        command,
        actor,
      });
    });
    await markApplied(db, command, result?.event.id ?? null);
  } catch (err) {
    if (err instanceof WorkTrackerError) {
      // Structured error: the command payload violated an
      // invariant (bad status transition, version mismatch,
      // unknown source, etc.). Mark as `rejected` immediately;
      // no need to retry.
      await recordConflictAndReject(db, command, err.code, err.message, actor);
      return;
    }
    // Unknown failure: record and decide whether to give up.
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack ?? null : null;
    const nextCount = (command.failure_count ?? 0) + 1;
    await recordFailure(db, command, nextCount, 'internal_error', message, stack);
    if (nextCount >= maxFailures) {
      // Move to the dead-letter state. The function returns
      // normally (no re-throw) so the Eventarc trigger stops
      // retrying and the source can introspect `commands/{id}`
      // and `commands/{id}/failures/` to diagnose.
      await markFailed(db, command, message);
      console.error(
        '[brain] command',
        command.id,
        'reached failure threshold; marked as failed. Last error:',
        message,
      );
      return;
    }
    // Re-throw so Eventarc retries. The next attempt will see
    // the incremented failure_count.
    throw err;
  }
}

/**
 * Manual brain evaluation (used by the e2e test harness and by
 * the REST debug endpoint).
 */
export async function evaluateCommand(command: Command, db: Firestore = getDb()): Promise<{ applied: boolean; reason?: string }> {
  try {
    const result = await db.runTransaction(async (tx) => applyCommand({ db, tx, command, actor: 'brain:manual' }));
    return { applied: true, ...(result ? { reason: 'applied' } : { reason: 'no-op' }) };
  } catch (err) {
    if (err instanceof WorkTrackerError) {
      return { applied: false, reason: `${err.code}: ${err.message}` };
    }
    throw err;
  }
}

async function markApplied(db: Firestore, command: Command, eventId: string | null): Promise<void> {
  const now = nowIso();
  await db
    .collection('commands')
    .doc(command.id)
    .update({
      status: 'applied',
      applied_at: now,
      ...(eventId ? { applied_event_id: eventId } : {}),
    });
}

async function markRejected(db: Firestore, command: Command, reason: string, actor: string): Promise<void> {
  const now = nowIso();
  await db.runTransaction(async (tx) => {
    tx.update(db.collection('commands').doc(command.id), {
      status: 'rejected',
      error: reason,
      applied_at: now,
    });
    tx.set(db.collection('conflicts').doc(ulid()), {
      id: ulid(),
      item_id: command.item_id ?? '',
      command_id: command.id,
      field: null,
      our_value: null,
      their_value: null,
      reason,
      resolved: false,
      created_at: now,
    });
  });
  // Touch the referenced item (if any) so the Sources view
  // surfaces a fresh health signal. Best-effort.
  if (command.item_id) {
    try {
      const item = await readWorkItem(db, command.item_id);
      await db
        .collection('work_items')
        .doc(item.id)
        .update({ updated_at: now });
    } catch {
      // Item might not exist yet for a 'create' command that
      // was rejected; ignore.
    }
  }
  // Suppress unused-var warning for `actor` (used in some
  // future event hookups).
  void actor;
}

async function recordConflictAndReject(
  db: Firestore,
  command: Command,
  code: string,
  message: string,
  actor: string,
): Promise<void> {
  const reason = `${code}: ${message}`;
  await markRejected(db, command, reason, actor);
}

export async function recordFailure(
  db: Firestore,
  command: Command,
  attempt: number,
  code: string,
  message: string,
  stack: string | null,
): Promise<void> {
  const now = nowIso();
  const failureId = ulid();
  // Truncate the stack to 4KB so a runaway exception doesn't
  // bloat the failure document.
  const truncatedStack = stack && stack.length > 4096 ? `${stack.slice(0, 4096)}…` : stack;
  await db.runTransaction(async (tx) => {
    tx.set(db.collection('commands').doc(command.id).collection('failures').doc(failureId), {
      id: failureId,
      command_id: command.id,
      attempt,
      code,
      message: message.slice(0, 4000),
      stack: truncatedStack,
      occurred_at: now,
    });
    tx.update(db.collection('commands').doc(command.id), {
      failure_count: attempt,
      error: `${code}: ${message}`.slice(0, 4000),
    });
  });
}

export async function markFailed(db: Firestore, command: Command, lastMessage: string): Promise<void> {
  const now = nowIso();
  await db.collection('commands').doc(command.id).update({
    status: 'failed',
    error: lastMessage.slice(0, 4000),
    failed_at: now,
  });
}
