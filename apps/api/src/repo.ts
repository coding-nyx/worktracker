/**
 * WorkItem repository — the only code path that writes to
 * `work_items/{id}` and its events sub-collection. Every other
 * write in the system funnels through here (REST handlers
 * enqueue a command, the brain trigger calls into here).
 *
 * The brain evaluates commands and, on accept, calls into
 * `applyCommand` which is the only function that mutates a
 * `work_items` document. This is the "WorkTracker is the only
 * writer" enforcement point.
 */

import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type {
  Command,
  Conflict,
  EnrichmentState,
  WorkItem,
  WorkItemEvent,
  WorkItemStatus,
} from '@worktracker/types';
import { ulid, nowIso } from './ids.js';
import { VersionConflictError, NotFoundError } from './errors.js';

export interface ApplyContext {
  db: Firestore;
  tx: Transaction;
  command: Command;
  actor: string;
}

export interface ApplyResult {
  item: WorkItem;
  event: WorkItemEvent;
}

/**
 * Apply an accepted command inside a Firestore transaction. Reads
 * the current work item, validates the optimistic-concurrency
 * version, mutates fields as the command requires, writes the
 * updated item + an event, and returns both. Caller is
 * responsible for committing the transaction.
 */
export async function applyCommand(ctx: ApplyContext): Promise<ApplyResult | null> {
  const { db, tx, command, actor } = ctx;
  const itemRef = command.item_id ? db.collection('work_items').doc(command.item_id) : null;

  // CREATE: no prior item expected.
  if (command.op === 'create') {
    if (command.item_id) {
      const existing = await tx.get(itemRef!);
      if (existing.exists) {
        throw new VersionConflictError('item already exists for create', {
          item_id: command.item_id,
        });
      }
    }
    const id = command.item_id ?? ulid();
    const finalRef = db.collection('work_items').doc(id);
    const now = nowIso();
    const item: WorkItem = {
      id,
      kind: command.payload.kind,
      title: command.payload.title,
      body: command.payload.body ?? null,
      status: command.payload.status ?? defaultStatusFor(command.payload.kind),
      severity: command.payload.severity ?? null,
      priority: command.payload.priority ?? null,
      source: command.source,
      source_id: command.payload.source_id ?? null,
      source_meta: command.payload.source_meta ?? {},
      owner: command.payload.owner ?? null,
      enricher: null,
      enrichment_state: null,
      due_at: command.payload.due_at ?? null,
      parent_id: command.payload.parent_id ?? null,
      group_id: command.payload.group_id ?? null,
      archived_at: null,
      created_at: now,
      updated_at: now,
      version: 1,
    };
    const event: WorkItemEvent = {
      id: ulid(),
      item_id: id,
      kind: 'created',
      actor,
      body: null,
      from_status: null,
      to_status: item.status,
      field: null,
      from_value: null,
      to_value: null,
      command_id: command.id,
      source_event_id: command.source_event_id,
      enrichment_stage: null,
      created_at: now,
    };
    tx.set(finalRef, item);
    tx.set(finalRef.collection('events').doc(event.id), event);
    return { item, event };
  }

  if (!itemRef) {
    throw new NotFoundError('item_id required for non-create command');
  }
  const snap = await tx.get(itemRef);
  if (!snap.exists) {
    throw new NotFoundError(`work item ${command.item_id} not found`);
  }
  const current = snap.data() as WorkItem;

  // From here on, every op carries an `expected_version` (transitively
  // for transition / comment / archive; the `update` op carries it
  // directly). We enforce it on the work item.
  const expected = readExpectedVersion(command);
  if (expected !== undefined && expected !== current.version) {
    throw new VersionConflictError('expected_version mismatch', {
      expected,
      actual: current.version,
      item_id: current.id,
    });
  }

  switch (command.op) {
    case 'update': {
      const next: WorkItem = {
        ...current,
        ...command.payload.patch,
        updated_at: nowIso(),
        version: current.version + 1,
      };
      const event: WorkItemEvent = {
        id: ulid(),
        item_id: current.id,
        kind: 'updated',
        actor,
        body: null,
        from_status: null,
        to_status: null,
        field: null,
        from_value: current,
        to_value: next,
        command_id: command.id,
        source_event_id: command.source_event_id,
        enrichment_stage: null,
        created_at: nowIso(),
      };
      tx.set(itemRef, next);
      tx.set(itemRef.collection('events').doc(event.id), event);
      return { item: next, event };
    }
    case 'transition': {
      const fromStatus = current.status;
      const toStatus = command.payload.to_status;
      if (fromStatus === toStatus) {
        // Idempotent: no-op.
        return null;
      }
      const next: WorkItem = {
        ...current,
        status: toStatus,
        updated_at: nowIso(),
        version: current.version + 1,
      };
      const event: WorkItemEvent = {
        id: ulid(),
        item_id: current.id,
        kind: 'status_change',
        actor,
        body: command.payload.comment ?? null,
        from_status: fromStatus,
        to_status: toStatus,
        field: 'status',
        from_value: fromStatus,
        to_value: toStatus,
        command_id: command.id,
        source_event_id: command.source_event_id,
        enrichment_stage: null,
        created_at: nowIso(),
      };
      tx.set(itemRef, next);
      tx.set(itemRef.collection('events').doc(event.id), event);
      return { item: next, event };
    }
    case 'comment': {
      const event: WorkItemEvent = {
        id: ulid(),
        item_id: current.id,
        kind: 'comment',
        actor,
        body: command.payload.body,
        from_status: null,
        to_status: null,
        field: null,
        from_value: null,
        to_value: null,
        command_id: command.id,
        source_event_id: command.source_event_id,
        enrichment_stage: null,
        created_at: nowIso(),
      };
      // A comment doesn't bump the item version, but it does
      // touch updated_at (the last-activity timestamp).
      tx.set(itemRef, { ...current, updated_at: nowIso() });
      tx.set(itemRef.collection('events').doc(event.id), event);
      return { item: { ...current, updated_at: nowIso() }, event };
    }
    case 'archive': {
      const next: WorkItem = {
        ...current,
        archived_at: nowIso(),
        updated_at: nowIso(),
        version: current.version + 1,
      };
      const event: WorkItemEvent = {
        id: ulid(),
        item_id: current.id,
        kind: 'archived',
        actor,
        body: null,
        from_status: null,
        to_status: null,
        field: 'archived_at',
        from_value: null,
        to_value: next.archived_at,
        command_id: command.id,
        source_event_id: command.source_event_id,
        enrichment_stage: null,
        created_at: nowIso(),
      };
      tx.set(itemRef, next);
      tx.set(itemRef.collection('events').doc(event.id), event);
      return { item: next, event };
    }
    case 'enrich': {
      // Enrichment commands write a `enrichment_state` patch and
      // an event documenting the stage. The actual grill/wayfind
      // work is done by the source's enricher; the command just
      // records the result.
      const stage = command.payload.stage;
      const now = nowIso();
      const patch = buildEnrichmentPatch(current.enrichment_state, stage, command.source, now);
      const next: WorkItem = {
        ...current,
        enrichment_state: patch,
        updated_at: now,
        version: current.version + 1,
      };
      const event: WorkItemEvent = {
        id: ulid(),
        item_id: current.id,
        kind: stage === 'both' ? 'enrichment_completed' : 'enrichment_completed',
        actor,
        body: null,
        from_status: null,
        to_status: null,
        field: 'enrichment_state',
        from_value: current.enrichment_state,
        to_value: patch,
        command_id: command.id,
        source_event_id: command.source_event_id,
        enrichment_stage: stage === 'both' ? 'wayfind' : stage,
        created_at: now,
      };
      tx.set(itemRef, next);
      tx.set(itemRef.collection('events').doc(event.id), event);
      return { item: next, event };
    }
    case 'link':
    case 'unlink': {
      // The brain handles link commands by writing to
      // `item_links/{linkId}` (a top-level collection). This
      // branch should not normally be reached by applyCommand —
      // links don't mutate the work_items doc. Return null to
      // signal no work-item change.
      return null;
    }
  }
}

function readExpectedVersion(command: Command): number | undefined {
  switch (command.op) {
    case 'update':
    case 'transition':
    case 'archive':
      return (command.payload as { expected_version: number }).expected_version;
    case 'comment':
      return (command.payload as { expected_version?: number }).expected_version;
    default:
      return undefined;
  }
}

function defaultStatusFor(kind: WorkItem['kind']): WorkItemStatus {
  switch (kind) {
    case 'task':
      return 'open';
    case 'ticket':
      return 'open';
    case 'decision':
      return 'proposed';
    case 'review':
      return 'pending';
  }
}

function buildEnrichmentPatch(
  current: EnrichmentState | null,
  stage: 'grill' | 'wayfind' | 'both',
  source: string,
  now: string,
): EnrichmentState {
  const next: EnrichmentState = { ...(current ?? {}) };
  if (stage === 'grill' || stage === 'both') {
    next.grill = {
      ...(next.grill ?? {}),
      at: now,
      by: source,
      status: 'complete',
      // The enricher adapter is responsible for filling
      // summary / question_count / gap_count / body_hash_at_grill
      // by submitting a follow-up update event with these
      // values. The first 'enrich' command just records the
      // attempt.
    };
  }
  if (stage === 'wayfind' || stage === 'both') {
    next.wayfind = {
      ...(next.wayfind ?? {}),
      at: now,
      by: source,
      status: 'complete',
    };
  }
  return next;
}

/**
 * Read a work item by id. Throws NotFound if missing.
 */
export async function readWorkItem(db: Firestore, id: string): Promise<WorkItem> {
  const snap = await db.collection('work_items').doc(id).get();
  if (!snap.exists) throw new NotFoundError(`work item ${id} not found`);
  return snap.data() as WorkItem;
}

/**
 * Record a conflict (the brain's primary job when it rejects a
 * command).
 */
export function recordConflict(
  tx: Transaction,
  db: Firestore,
  conflict: Omit<Conflict, 'id' | 'created_at' | 'resolved'>,
): void {
  const id = ulid();
  tx.set(db.collection('conflicts').doc(id), {
    ...conflict,
    id,
    resolved: false,
    created_at: nowIso(),
  });
}
