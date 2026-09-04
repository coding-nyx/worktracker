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
import { VersionConflictError, NotFoundError, InvalidInputError } from './errors.js';
import { canTransition } from '@worktracker/types';
import { validateItemData } from './data-schemas.js';

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
    const kind = command.payload.kind;
    // Validate per-kind `data` strictly. Throws ZodError on
    // failure; the brain's catch path maps that to a `rejected`
    // command with `code: 'invalid_data'`.
    const validatedData = command.payload.data
      ? validateItemData(command.payload.data, kind)
      : {};
    // Sanity-check the initial status against the kind, so a
    // `task` with status `triaged` (a ticket-only status) is
    // rejected at the door instead of slipping through to the
    // state machine which would then reject it without context.
    const initialStatus = command.payload.status ?? defaultStatusFor(kind);
    if (command.payload.status && command.payload.status !== defaultStatusFor(kind)) {
      // The state machine's getValidTransitions is keyed by
      // (kind, from), so we use it backwards: from = the default
      // for the kind, to = the requested status. If the default
      // can't reach the requested status, reject.
      const result = canTransition(defaultStatusFor(kind), command.payload.status, kind);
      if (!result.ok) {
        throw new InvalidInputError(
          `initial status '${command.payload.status}' is not reachable for ${kind}`,
          { kind, status: command.payload.status, allowed: result.reason.allowed },
        );
      }
    }
    const item: WorkItem = {
      id,
      kind,
      title: command.payload.title,
      body: command.payload.body ?? null,
      status: initialStatus,
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
      // Slice 3 — rich data + board association.
      board_id: command.payload.board_id ?? null,
      // Slice 10 — project / release / tag taxonomy.
      project_id: command.payload.project_id ?? null,
      release_id: command.payload.release_id ?? null,
      tag_slugs: command.payload.tag_slugs ?? [],
      data: validatedData,
      data_map: command.payload.data_map ?? {},
      plan_file_id: null,
      analysis: null,
      files: [],
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
      // If the patch includes `data`, validate it strictly against
      // the per-kind Zod schema. The shape is allowed to shrink
      // (e.g. a task clearing its `tags`) but not to drift.
      const patch = { ...command.payload.patch };
      if ('data' in patch && patch.data !== undefined) {
        patch.data = validateItemData(patch.data, current.kind);
      }
      const next: WorkItem = {
        ...current,
        ...patch,
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
      // Slice 3 — gate on the state machine. A bad move is a
      // structured rejection (`code: 'invalid_transition'`), not a
      // silent no-op. The brain records the reason on the conflict
      // log; the web renders it in the mono `[err]` block.
      const result = canTransition(fromStatus, toStatus, current.kind);
      if (!result.ok) {
        throw new InvalidInputError(result.reason.message, {
          code: result.reason.code,
          from: result.reason.from,
          to: result.reason.to,
          kind: result.reason.kind,
          allowed: result.reason.allowed,
        });
      }
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
    case 'link': {
      // The brain writes a relational row to `item_links/{linkId}`
      // and appends a `linked` event on BOTH items (parent and
      // child). Links are stored in a top-level collection rather
      // than as a field on WorkItem so a single item can have many
      // links of different kinds (depends_on, blocks, related,
      // mirrors, parent_of) without overwriting each other.
      const childId = (command.payload as { child_id: string }).child_id;
      const linkKind = (command.payload as { kind: string }).kind;
      const childRef = db.collection('work_items').doc(childId);
      const childSnap = await tx.get(childRef);
      if (!childSnap.exists) {
        throw new NotFoundError(`link child work item ${childId} not found`);
      }
      const now = nowIso();
      const linkId = ulid();
      const linkDoc = {
        id: linkId,
        parent_id: command.item_id,
        child_id: childId,
        kind: linkKind,
        source: command.source,
        source_event_id: command.source_event_id,
        command_id: command.id,
        created_at: now,
      };
      tx.set(db.collection('item_links').doc(linkId), linkDoc);
      // Parent event. Returned as `event` so `markApplied` can
      // record it as `applied_event_id` on the command.
      const parentEvent: WorkItemEvent = {
        id: ulid(),
        item_id: current.id,
        kind: 'linked',
        actor,
        body: null,
        from_status: null,
        to_status: null,
        field: 'links',
        from_value: null,
        to_value: { link_id: linkId, child_id: childId, kind: linkKind },
        command_id: command.id,
        source_event_id: command.source_event_id,
        enrichment_stage: null,
        created_at: now,
      };
      tx.set(itemRef.collection('events').doc(parentEvent.id), parentEvent);
      // Child event — same link, mirrored on the child's timeline.
      // Written in the same transaction so a brain retry is atomic.
      const childEvent: WorkItemEvent = {
        id: ulid(),
        item_id: childId,
        kind: 'linked',
        actor,
        body: null,
        from_status: null,
        to_status: null,
        field: 'links',
        from_value: null,
        to_value: { link_id: linkId, parent_id: current.id, kind: linkKind },
        command_id: command.id,
        source_event_id: command.source_event_id,
        enrichment_stage: null,
        created_at: now,
      };
      tx.set(childRef.collection('events').doc(childEvent.id), childEvent);
      return { item: current, event: parentEvent };
    }
    case 'unlink': {
      // Match by (parent_id, child_id, kind) — that's the smallest
      // identifying tuple carried in the command payload. The
      // schema doesn't include a `link_id` field because most
      // callers don't see one (links are server-generated ULIDs).
      // If multiple matching links exist (theoretically possible
      // if a caller submitted the same link twice), we delete all
      // and write one `unlinked` event for the soft-delete.
      const childId = (command.payload as { child_id: string }).child_id;
      const linkKind = (command.payload as { kind: string }).kind;
      const matches = await tx.get(
        db.collection('item_links')
          .where('parent_id', '==', command.item_id)
          .where('child_id', '==', childId)
          .where('kind', '==', linkKind),
      );
      if (matches.empty) {
        // No-op idempotent — there was no link to remove.
        return null;
      }
      const now = nowIso();
      const parentRef = itemRef;
      const childRef = db.collection('work_items').doc(childId);
      const parentEvent: WorkItemEvent = {
        id: ulid(),
        item_id: current.id,
        kind: 'unlinked',
        actor,
        body: null,
        from_status: null,
        to_status: null,
        field: 'links',
        from_value: null,
        to_value: { child_id: childId, kind: linkKind, removed_count: matches.size },
        command_id: command.id,
        source_event_id: command.source_event_id,
        enrichment_stage: null,
        created_at: now,
      };
      tx.set(parentRef.collection('events').doc(parentEvent.id), parentEvent);
      for (const doc of matches.docs) {
        tx.delete(doc.ref);
      }
      const childEvent: WorkItemEvent = {
        id: ulid(),
        item_id: childId,
        kind: 'unlinked',
        actor,
        body: null,
        from_status: null,
        to_status: null,
        field: 'links',
        from_value: null,
        to_value: { parent_id: current.id, kind: linkKind, removed_count: matches.size },
        command_id: command.id,
        source_event_id: command.source_event_id,
        enrichment_stage: null,
        created_at: now,
      };
      tx.set(childRef.collection('events').doc(childEvent.id), childEvent);
      return { item: current, event: parentEvent };
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
