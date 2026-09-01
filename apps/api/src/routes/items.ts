/**
 * REST routes for work items. Every write funnels through a
 * `commands/{id}` document so the brain is the only writer.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  Command,
  ListItemsResponse,
  LinkRequest,
  EnrichRequest,
  WorkItem,
  WorkItemEvent,
} from '@worktracker/types';
import { getDb } from '../firestore.js';
import { requireSource } from '../auth.js';
import { InvalidInputError, NotFoundError } from '../errors.js';
import { ulid, nowIso } from '../ids.js';

const ItemId = z.string().min(1).max(64);
const ListQuerySchema = z.object({
  kind: z.enum(['task', 'ticket', 'decision', 'review']).optional(),
  status: z.string().optional(),
  source: z.string().optional(),
  owner: z.string().optional(),
  q: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  include_archived: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
});

const CreateSchema = z.object({
  kind: z.enum(['task', 'ticket', 'decision', 'review']),
  title: z.string().min(1).max(200),
  body: z.string().max(10_000).optional(),
  status: z.string().optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  source_id: z.string().max(256).optional(),
  source_meta: z.record(z.unknown()).optional(),
  owner: z.string().optional(),
  due_at: z.string().datetime().optional(),
  parent_id: z.string().optional(),
  group_id: z.string().optional(),
});

const UpdateSchema = z.object({
  patch: z
    .object({
      title: z.string().min(1).max(200).optional(),
      body: z.string().max(10_000).nullable().optional(),
      severity: z.enum(['low', 'medium', 'high', 'critical']).nullable().optional(),
      priority: z.enum(['low', 'medium', 'high']).nullable().optional(),
      owner: z.string().nullable().optional(),
      due_at: z.string().datetime().nullable().optional(),
      parent_id: z.string().nullable().optional(),
      group_id: z.string().nullable().optional(),
      enricher: z.string().nullable().optional(),
      source_meta: z.record(z.unknown()).optional(),
    })
    .strict(),
  expected_version: z.number().int().min(0),
});

const TransitionSchema = z.object({
  to_status: z.string().min(1),
  comment: z.string().max(10_000).optional(),
  force_dispatch: z.boolean().optional(),
  expected_version: z.number().int().min(0),
});

const CommentSchema = z.object({
  body: z.string().min(1).max(10_000),
  expected_version: z.number().int().min(0).optional(),
});

const LinkSchema = z.object({
  child_id: z.string().min(1),
  kind: z.enum(['depends_on', 'blocks', 'related', 'mirrors', 'parent_of']),
});

const EnrichSchema = z.object({
  stage: z.enum(['grill', 'wayfind', 'both']),
  enricher: z.string().optional(),
});

export async function itemsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/items', { preHandler: requireSource }, async (req) => {
    const query = ListQuerySchema.parse(req.query);
    let ref = getDb().collection('work_items').orderBy('updated_at', 'desc');
    if (query.kind) ref = ref.where('kind', '==', query.kind);
    if (query.status) ref = ref.where('status', '==', query.status);
    if (query.source) ref = ref.where('source', '==', query.source);
    if (query.owner) ref = ref.where('owner', '==', query.owner);
    // Firestore's `where('archived_at', '==', null)` matches
    // both null and missing fields, so the active-only filter
    // is indexable and the limit isn't wasted on archived items.
    // The previous post-fetch filter was correct in form but
    // returned the full set whenever the limit was hit on
    // archived items first.
    if (!query.include_archived) {
      ref = ref.where('archived_at', '==', null);
    }
    if (query.cursor) {
      const cursorSnap = await getDb().collection('work_items').doc(query.cursor).get();
      if (cursorSnap.exists) ref = ref.startAfter(cursorSnap);
    }
    ref = ref.limit(query.limit);
    const snap = await ref.get();
    let items: WorkItem[] = snap.docs.map((d) => d.data() as WorkItem);
    // Text search is post-fetch (Firestore has no LIKE). The
    // upstream `limit` caps the post-filter work.
    if (query.q) {
      const needle = query.q.toLowerCase();
      items = items.filter(
        (it) =>
          it.title.toLowerCase().includes(needle) ||
          (it.body?.toLowerCase().includes(needle) ?? false),
      );
    }
    const response: ListItemsResponse = {
      items,
      next_cursor: items.length === query.limit ? items[items.length - 1]?.id ?? null : null,
    };
    return response;
  });

  app.post('/api/items', { preHandler: requireSource }, async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const commandId = ulid();
    const source = req.auth!.source?.name ?? 'web';
    const command: Command = {
      id: commandId,
      source,
      source_event_id: req.headers['x-worktracker-source-event-id']?.toString() ?? null,
      op: 'create',
      item_id: null,
      payload: {
        kind: body.kind,
        title: body.title,
        body: body.body,
        status: body.status as WorkItem['status'] | undefined,
        severity: body.severity,
        priority: body.priority,
        source_id: body.source_id,
        source_meta: body.source_meta,
        owner: body.owner,
        due_at: body.due_at,
        parent_id: body.parent_id,
        group_id: body.group_id,
      },
      status: 'queued',
      error: null,
      applied_event_id: null,
      created_at: nowIso(),
      applied_at: null,
      failure_count: 0,
      failed_at: null,
      requeued_at: null,
    };
    await enqueueCommand(command);
    reply.code(202);
    return { command_id: commandId, status: 'queued' };
  });

  app.get('/api/items/:id', { preHandler: requireSource }, async (req) => {
    const { id } = z.object({ id: ItemId }).parse(req.params);
    const doc = await getDb().collection('work_items').doc(id).get();
    if (!doc.exists) throw new NotFoundError(`work item ${id} not found`);
    return doc.data() as WorkItem;
  });

  app.patch('/api/items/:id', { preHandler: requireSource }, async (req, reply) => {
    const { id } = z.object({ id: ItemId }).parse(req.params);
    const body = UpdateSchema.parse(req.body);
    const source = req.auth!.source?.name ?? 'web';
    const command: Command = {
      id: ulid(),
      source,
      source_event_id: req.headers['x-worktracker-source-event-id']?.toString() ?? null,
      op: 'update',
      item_id: id,
      payload: { patch: body.patch, expected_version: body.expected_version },
      status: 'queued',
      error: null,
      applied_event_id: null,
      created_at: nowIso(),
      applied_at: null,
      failure_count: 0,
      failed_at: null,
      requeued_at: null,
    };
    await enqueueCommand(command);
    reply.code(202);
    return { command_id: command.id, status: 'queued' };
  });

  app.delete('/api/items/:id', { preHandler: requireSource }, async (req, reply) => {
    const { id } = z.object({ id: ItemId }).parse(req.params);
    const existing = await getDb().collection('work_items').doc(id).get();
    if (!existing.exists) throw new NotFoundError(`work item ${id} not found`);
    const current = existing.data() as WorkItem;
    const source = req.auth!.source?.name ?? 'web';
    const command: Command = {
      id: ulid(),
      source,
      source_event_id: req.headers['x-worktracker-source-event-id']?.toString() ?? null,
      op: 'archive',
      item_id: id,
      payload: { expected_version: current.version },
      status: 'queued',
      error: null,
      applied_event_id: null,
      created_at: nowIso(),
      applied_at: null,
      failure_count: 0,
      failed_at: null,
      requeued_at: null,
    };
    await enqueueCommand(command);
    reply.code(202);
    return { command_id: command.id, status: 'queued' };
  });

  app.get('/api/items/:id/events', { preHandler: requireSource }, async (req) => {
    const { id } = z.object({ id: ItemId }).parse(req.params);
    const snap = await getDb()
      .collection('work_items')
      .doc(id)
      .collection('events')
      .orderBy('created_at', 'asc')
      .limit(500)
      .get();
    const events: WorkItemEvent[] = snap.docs.map((d) => d.data() as WorkItemEvent);
    return { events };
  });

  app.post('/api/items/:id/transition', { preHandler: requireSource }, async (req, reply) => {
    const { id } = z.object({ id: ItemId }).parse(req.params);
    const body = TransitionSchema.parse(req.body);
    const source = req.auth!.source?.name ?? 'web';
    const command: Command = {
      id: ulid(),
      source,
      source_event_id: req.headers['x-worktracker-source-event-id']?.toString() ?? null,
      op: 'transition',
      item_id: id,
      payload: body as never,
      status: 'queued',
      error: null,
      applied_event_id: null,
      created_at: nowIso(),
      applied_at: null,
      failure_count: 0,
      failed_at: null,
      requeued_at: null,
    };
    await enqueueCommand(command);
    reply.code(202);
    return { command_id: command.id, status: 'queued' };
  });

  app.post('/api/items/:id/comment', { preHandler: requireSource }, async (req, reply) => {
    const { id } = z.object({ id: ItemId }).parse(req.params);
    const body = CommentSchema.parse(req.body);
    const source = req.auth!.source?.name ?? 'web';
    const command: Command = {
      id: ulid(),
      source,
      source_event_id: req.headers['x-worktracker-source-event-id']?.toString() ?? null,
      op: 'comment',
      item_id: id,
      payload: body as never,
      status: 'queued',
      error: null,
      applied_event_id: null,
      created_at: nowIso(),
      applied_at: null,
      failure_count: 0,
      failed_at: null,
      requeued_at: null,
    };
    await enqueueCommand(command);
    reply.code(202);
    return { command_id: command.id, status: 'queued' };
  });

  app.post('/api/items/:id/link', { preHandler: requireSource }, async (req, reply) => {
    const { id } = z.object({ id: ItemId }).parse(req.params);
    const body = LinkSchema.parse(req.body) satisfies LinkRequest;
    const source = req.auth!.source?.name ?? 'web';
    const command: Command = {
      id: ulid(),
      source,
      source_event_id: req.headers['x-worktracker-source-event-id']?.toString() ?? null,
      op: 'link',
      item_id: id,
      payload: body,
      status: 'queued',
      error: null,
      applied_event_id: null,
      created_at: nowIso(),
      applied_at: null,
      failure_count: 0,
      failed_at: null,
      requeued_at: null,
    };
    await enqueueCommand(command);
    reply.code(202);
    return { command_id: command.id, status: 'queued' };
  });

  app.post('/api/items/:id/enrich', { preHandler: requireSource }, async (req, reply) => {
    const { id } = z.object({ id: ItemId }).parse(req.params);
    const body = EnrichSchema.parse(req.body) satisfies EnrichRequest;
    const source = req.auth!.source?.name ?? 'web';
    const command: Command = {
      id: ulid(),
      source,
      source_event_id: req.headers['x-worktracker-source-event-id']?.toString() ?? null,
      op: 'enrich',
      item_id: id,
      payload: body,
      status: 'queued',
      error: null,
      applied_event_id: null,
      created_at: nowIso(),
      applied_at: null,
      failure_count: 0,
      failed_at: null,
      requeued_at: null,
    };
    await enqueueCommand(command);
    reply.code(202);
    return { command_id: command.id, status: 'queued' };
  });

  app.get('/api/items/:id/enrichment', { preHandler: requireSource }, async (req) => {
    const { id } = z.object({ id: ItemId }).parse(req.params);
    const doc = await getDb().collection('work_items').doc(id).get();
    if (!doc.exists) throw new NotFoundError(`work item ${id} not found`);
    const data = doc.data() as WorkItem;
    return { enrichment_state: data.enrichment_state };
  });
}

async function enqueueCommand(command: Command): Promise<void> {
  // The brain trigger fires on this write. The REST handler
  // returns 202 immediately; the caller polls /commands/:id
  // for status or subscribes to the work item's events.
  if (command.status !== 'queued') {
    throw new InvalidInputError('command must start as queued');
  }
  await getDb().collection('commands').doc(command.id).set(command);
}
