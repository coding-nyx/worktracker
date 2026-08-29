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
 *   4. On reject: writes a `conflicts` document, marks the command
 *      as `rejected` with a human-readable reason.
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
}

/**
 * The trigger entry point. Wired in `index.ts` as a Cloud Function
 * `onDocumentCreated('commands/{id}')` handler.
 */
export async function handleCommandCreated(snap: QueryDocumentSnapshot, opts: BrainOptions = {}): Promise<void> {
  const command = snap.data() as Command;
  if (command.status !== 'queued') {
    // The trigger fires on create; status is `queued` from the
    // command constructor. Defensive check.
    return;
  }
  const db = opts.db ?? getDb();
  const actor = opts.actor ?? `brain:trigger`;

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
      await recordConflictAndReject(db, command, err.code, err.message, actor);
      return;
    }
    // Unknown failure: log and re-throw so the trigger retries.
    console.error('[brain] unknown failure processing command', command.id, err);
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
