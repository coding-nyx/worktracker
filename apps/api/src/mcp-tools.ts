/**
 * MCP tool registry — slice 4. The 23 tools exposed on `/mcp` and
 * `/mcp/stream` are declared as entries here. `mcp.ts` and
 * `mcp-v2.ts` use this single source of truth to:
 *   - render `tools/list` (filtered by the caller's scope)
 *   - dispatch `tools/call` to the right handler
 *
 * Adding a tool:
 *   1. Add the dotted name to `MCP_TOOL_NAMES` in @worktracker/types.
 *   2. Add an entry to `TOOL_REGISTRY` below.
 *   3. The handler receives parsed args + a `ToolContext` carrying
 *      the request, the bearer source, and the auth scope. Return
 *      any JSON-serializable value; the MCP wrapper puts it under
 *      `result.structuredContent` (v2) or `result` (v1).
 *
 * Each handler MUST throw `InvalidInputError` for 4xx-class
 * problems (mapped to JSON-RPC -32602 by the wrapper) and
 * `WorkTrackerError` for domain failures (mapped to -32603).
 * Unhandled throws are caught and surfaced as -32603 with the
 * error message.
 *
 * Scope ladder: `read` < `read_write` < `admin`. A `read_write`
 * caller can run all `read` and `read_write` tools; an `admin`
 * caller can run all 23. The list filter in `tools/list` enforces
 * this on the way out, and `tools/call` re-checks as defense in
 * depth.
 */

import type { FastifyRequest } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import type {
  ApiTokenScope,
  Board,
  Client,
  Connector,
  CreateClientRequest,
  FileRecord,
  IntrospectClientResponse,
  ListClientsResponse,
  ListConnectorsResponse,
  ListItemsQuery,
  ListItemsResponse,
  McpToolName,
  WorkItem,
  WorkItemEvent,
  WorkItemFile,
} from '@worktracker/types';
import { ulid, nowIso } from './ids.js';
import { getDb } from './firestore.js';
import { InvalidInputError } from './errors.js';
import { canTransition } from '@worktracker/types';
import { recordCallTrace, mapDispatchOutcome } from './analytics.js';

const SCOPE_RANK: Record<ApiTokenScope, number> = {
  read: 1,
  read_write: 2,
  admin: 3,
};

export function scopeAtLeast(have: ApiTokenScope, need: ApiTokenScope): boolean {
  return SCOPE_RANK[have] >= SCOPE_RANK[need];
}

/**
 * The tool context a handler receives. Wraps the Fastify request
 * (for `req.auth`) and pre-computes the effective scope, so a
 * handler that wants to branch on the bearer's role doesn't have
 * to walk through `auth.ts` again.
 */
export interface ToolContext {
  req: FastifyRequest;
  source: string;
  effectiveScope: ApiTokenScope;
  isAdmin: boolean;
}

export interface McpToolDef {
  name: McpToolName;
  description: string;
  required_scope: ApiTokenScope;
  /** JSON Schema fragment, derived from the Zod inputSchema. */
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  /** The Zod schema the wrapper runs against `arguments` before
   *  calling the handler. The handler receives the parsed value. */
  schema: ZodTypeAny;
  /** Run the tool. Return a JSON-serializable value. */
  handler: (args: unknown, ctx: ToolContext) => Promise<unknown>;
}

/**
 * The result the wrappers translate into JSON-RPC. Same shape as
 * the slice-1 `DispatchResult`; the v1 / v2 wrappers know how to
 * put this into their respective envelopes.
 */
export interface ToolDispatchResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  /** JSON-RPC error code. -32602 for input validation, -32603 for
   *  anything else. The wrappers default to -32603 on missing. */
  code?: number;
  /** Optional structured details, e.g. Zod issues on a -32602. */
  data?: unknown;
}

// =====================================================================
// JSON-Schema helpers — turn a Zod schema into the JSON Schema that
// MCP `tools/list` advertises. Kept tiny on purpose: the spec only
// requires `type` and `properties` for object args; we surface the
// required fields and a few shape hints. Anything richer (ref/$ref,
// oneOf, etc.) is a slice 5 follow-up.
// =====================================================================

function zodToJsonSchema(schema: ZodTypeAny): {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
} {
  // Zod's _def.shape is the canonical path for a ZodObject.
  const def = (schema as unknown as { _def?: { shape?: Record<string, ZodTypeAny> } })._def;
  if (!def?.shape) {
    return { type: 'object', properties: {} };
  }
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, child] of Object.entries(def.shape)) {
    properties[key] = describeZod(child);
    if (!child.isOptional()) required.push(key);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

function describeZod(zod: ZodTypeAny): Record<string, unknown> {
  const desc: Record<string, unknown> = {};
  if (zod.description) desc.description = zod.description;
  // The MCP spec doesn't read the `type` we surface for objects
  // (it advertises `type: 'object'` at the root), but a string /
  // number / boolean hint helps Claude Code render a friendlier
  // tool description.
  const def = (zod as unknown as { _def?: { typeName?: string; values?: unknown[]; innerType?: ZodTypeAny } })._def;
  switch (def?.typeName) {
    case 'ZodString':
      desc.type = 'string';
      break;
    case 'ZodNumber':
      desc.type = 'number';
      break;
    case 'ZodBoolean':
      desc.type = 'boolean';
      break;
    case 'ZodEnum':
      desc.type = 'string';
      desc.enum = def.values;
      break;
    case 'ZodArray':
      desc.type = 'array';
      desc.items = describeZod(def.innerType ?? z.string());
      break;
    case 'ZodOptional':
      return describeZod(def.innerType ?? z.string());
    case 'ZodRecord':
      desc.type = 'object';
      desc.additionalProperties = describeZod(def.innerType ?? z.string());
      break;
    default:
      desc.type = 'string';
  }
  return desc;
}

function tool(
  name: McpToolName,
  description: string,
  requiredScope: ApiTokenScope,
  schema: ZodTypeAny,
  handler: McpToolDef['handler'],
): McpToolDef {
  return {
    name,
    description,
    required_scope: requiredScope,
    inputSchema: zodToJsonSchema(schema),
    schema,
    handler,
  };
}

// =====================================================================
// Shared schemas
// =====================================================================

const ID = z.string().min(1).max(64);
const NonEmpty = z.string().min(1).max(200);

// =====================================================================
// items.* (7 tools)
// =====================================================================

const itemsList = tool(
  'worktracker.items.list',
  'List work items, optionally filtered by kind/status/source/owner/board/owner and a free-text search.',
  'read',
  z.object({
    kind: z.enum(['task', 'ticket', 'decision', 'review']).optional(),
    status: z.string().optional(),
    source: z.string().optional(),
    owner: z.string().optional(),
    board_id: z.string().optional(),
    q: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(50),
    include_archived: z.boolean().default(false),
  }),
  async (args, _ctx) => {
    const query = args as ListItemsQuery;
    const wantLimit = query.limit ?? 50;
    let ref = getDb().collection('work_items').orderBy('updated_at', 'desc');
    if (query.kind) ref = ref.where('kind', '==', query.kind);
    if (query.status) ref = ref.where('status', '==', query.status);
    if (query.source) ref = ref.where('source', '==', query.source);
    if (query.owner) ref = ref.where('owner', '==', query.owner);
    if (query.board_id) {
      if (query.board_id === 'backlog') {
        ref = ref.where('board_id', '==', null);
      } else {
        ref = ref.where('board_id', '==', query.board_id);
      }
    }
    const fetchLimit = query.include_archived ? wantLimit : Math.min(200, wantLimit * 4);
    ref = ref.limit(fetchLimit);
    const snap = await ref.get();
    let items: WorkItem[] = snap.docs.map((d) => d.data() as WorkItem);
    if (!query.include_archived) items = items.filter((i) => !i.archived_at);
    if (query.q) {
      const needle = query.q.toLowerCase();
      items = items.filter(
        (i) =>
          i.title.toLowerCase().includes(needle) ||
          (i.body?.toLowerCase().includes(needle) ?? false),
      );
    }
    items = items.slice(0, wantLimit);
    return {
      items,
      next_cursor: items.length === wantLimit ? items[items.length - 1]?.id ?? null : null,
    } satisfies ListItemsResponse;
  },
);

const itemsGet = tool(
  'worktracker.items.get',
  'Fetch one work item by id, plus its event timeline and file pointer list.',
  'read',
  z.object({ id: ID }),
  async (args) => {
    const { id } = args as { id: string };
    const doc = await getDb().collection('work_items').doc(id).get();
    if (!doc.exists) return { item: null, events: [], files: [] };
    const eventsSnap = await doc.ref.collection('events').orderBy('created_at', 'asc').get();
    const item = doc.data() as WorkItem;
    return {
      item,
      events: eventsSnap.docs.map((d) => d.data() as WorkItemEvent),
      files: item.files ?? [],
    };
  },
);

const itemsCreate = tool(
  'worktracker.items.create',
  'Create a new work item. Validates per-kind data strictly; enqueues a `create` command; returns the command id.',
  'read_write',
  z.object({
    kind: z.enum(['task', 'ticket', 'decision', 'review']),
    title: z.string().min(1).max(200),
    body: z.string().max(10_000).optional(),
    status: z.string().optional(),
    severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    priority: z.enum(['low', 'medium', 'high']).optional(),
    source_id: z.string().max(256).optional(),
    source_meta: z.record(z.unknown()).optional(),
    owner: z.string().optional(),
    due_at: z.string().optional(),
    parent_id: z.string().optional(),
    group_id: z.string().optional(),
    board_id: z.string().nullable().optional(),
    data: z.record(z.unknown()).optional(),
    data_map: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  }),
  async (args, ctx) => {
    const command = await enqueue('create', null, args, ctx);
    return { command_id: command.id, status: 'queued' };
  },
);

const itemsUpdate = tool(
  'worktracker.items.update',
  'Patch fields on a work item with optimistic concurrency. Folds in transition (status field), archive (archived_at field), and set_reminder (deferred) — the state machine still gates status moves.',
  'read_write',
  z.object({
    id: ID,
    expected_version: z.number().int().min(0),
    patch: z.record(z.unknown()),
  }),
  async (args, ctx) => {
    const a = args as { id: string; expected_version: number; patch: Record<string, unknown> };
    // Slice 4 short-circuit: if the patch sets `status`, run it as
    // a transition so the state machine gate fires (rather than a
    // raw update, which would bypass slice 3's canTransition). The
    // brain will reject bad moves with code: 'invalid_transition'.
    if ('status' in a.patch && typeof a.patch.status === 'string') {
      const toStatus = a.patch.status as WorkItem['status'];
      // Reject obviously-bad transitions up-front so the user gets
      // a clean -32602 instead of a 409 from the brain.
      const cur = await getDb().collection('work_items').doc(a.id).get();
      if (!cur.exists) throw new InvalidInputError(`work item ${a.id} not found`);
      const current = cur.data() as WorkItem;
      const check = canTransition(current.status, toStatus, current.kind);
      if (!check.ok) {
        throw new InvalidInputError(check.reason.message, {
          code: check.reason.code,
          from: check.reason.from,
          to: check.reason.to,
          kind: check.reason.kind,
        });
      }
      const command = await enqueue(
        'transition',
        a.id,
        {
          to_status: toStatus,
          expected_version: a.expected_version,
          ...(typeof a.patch.comment === 'string' ? { comment: a.patch.comment } : {}),
        },
        ctx,
      );
      return { command_id: command.id, status: 'queued', folded: 'transition' };
    }
    if ('archived_at' in a.patch) {
      // Set archived_at → archive op (single field; the patch
      // shape is preserved so callers can also clear it via
      // `archived_at: null`).
      const command = await enqueue(
        'archive',
        a.id,
        { expected_version: a.expected_version },
        ctx,
      );
      return { command_id: command.id, status: 'queued', folded: 'archive' };
    }
    const command = await enqueue(
      'update',
      a.id,
      { patch: a.patch, expected_version: a.expected_version },
      ctx,
    );
    return { command_id: command.id, status: 'queued' };
  },
);

const itemsComment = tool(
  'worktracker.items.comment',
  'Append a comment event to a work item. Does not bump the item version.',
  'read_write',
  z.object({
    id: ID,
    body: z.string().min(1).max(10_000),
    expected_version: z.number().int().min(0).optional(),
  }),
  async (args, ctx) => {
    const command = await enqueue('comment', (args as { id: string }).id, args, ctx);
    return { command_id: command.id, status: 'queued' };
  },
);

const itemsLink = tool(
  'worktracker.items.link',
  'Create a typed relationship between two work items (parent → child) with kind ∈ {depends_on, blocks, related, mirrors, parent_of}.',
  'read_write',
  z.object({
    parent_id: ID,
    child_id: ID,
    kind: z.enum(['depends_on', 'blocks', 'related', 'mirrors', 'parent_of']),
  }),
  async (args, ctx) => {
    const command = await enqueue('link', (args as { parent_id: string }).parent_id, args, ctx);
    return { command_id: command.id, status: 'queued' };
  },
);

const itemsUnlink = tool(
  'worktracker.items.unlink',
  'Remove a link by (parent_id, child_id, kind). No-op if no matching link exists.',
  'read_write',
  z.object({
    parent_id: ID,
    child_id: ID,
    kind: z.enum(['depends_on', 'blocks', 'related', 'mirrors', 'parent_of']),
  }),
  async (args, ctx) => {
    const command = await enqueue('unlink', (args as { parent_id: string }).parent_id, args, ctx);
    return { command_id: command.id, status: 'queued' };
  },
);

// =====================================================================
// boards.* (5 tools)
// =====================================================================

const boardsList = tool(
  'worktracker.boards.list',
  'List all boards, ordered by name. The `is_default` flag marks the landing view.',
  'read',
  z.object({}),
  async () => {
    const snap = await getDb().collection('boards').orderBy('name', 'asc').get();
    return { boards: snap.docs.map((d) => d.data() as Board) };
  },
);

const boardsGet = tool(
  'worktracker.boards.get',
  'Fetch one board by id, including its column definitions and kind filter.',
  'read',
  z.object({ id: ID }),
  async (args) => {
    const { id } = args as { id: string };
    const doc = await getDb().collection('boards').doc(id).get();
    if (!doc.exists) return { board: null };
    return { board: doc.data() as Board };
  },
);

const boardsCreate = tool(
  'worktracker.boards.create',
  'Create a new board. Admin only. Pass `is_default: true` to make it the landing view (unsets the previous default in the same batch).',
  'admin',
  z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(2_000).optional(),
    kinds: z.array(z.enum(['task', 'ticket', 'decision', 'review'])).nullable().optional(),
    columns: z
      .array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          statuses: z.array(z.string()).min(1),
          kinds: z.array(z.enum(['task', 'ticket', 'decision', 'review'])).optional(),
        }),
      )
      .min(1),
    is_default: z.boolean().optional(),
  }),
  async (args, _ctx) => {
    if (!_ctx.isAdmin) {
      throw new InvalidInputError('boards.create requires admin scope');
    }
    const id = ulid();
    const now = nowIso();
    const board: Board = {
      id,
      name: (args as { name: string }).name,
      description: (args as { description?: string }).description,
      kinds: (args as { kinds?: WorkItem['kind'][] | null }).kinds ?? undefined,
      columns: (args as { columns: Board['columns'] }).columns,
      is_default: Boolean((args as { is_default?: boolean }).is_default),
      created_at: now,
      updated_at: now,
    };
    await getDb().runTransaction(async (tx) => {
      if (board.is_default) {
        // Unset the previous default in the same batch.
        const prev = await tx.get(
          getDb().collection('boards').where('is_default', '==', true).limit(1),
        );
        for (const d of prev.docs) {
          tx.update(d.ref, { is_default: false, updated_at: now });
        }
      }
      tx.set(getDb().collection('boards').doc(id), board);
    });
    return { board };
  },
);

const boardsUpdate = tool(
  'worktracker.boards.update',
  'Patch an existing board. Admin only. Omit a field to keep its current value. Re-assigning `is_default: true` unsets the previous default in the same batch.',
  'admin',
  z.object({
    id: ID,
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2_000).optional(),
    kinds: z.array(z.enum(['task', 'ticket', 'decision', 'review'])).nullable().optional(),
    columns: z
      .array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          statuses: z.array(z.string()).min(1),
          kinds: z.array(z.enum(['task', 'ticket', 'decision', 'review'])).optional(),
        }),
      )
      .optional(),
    is_default: z.boolean().optional(),
  }),
  async (args, ctx) => {
    if (!ctx.isAdmin) throw new InvalidInputError('boards.update requires admin scope');
    const a = args as { id: string } & Partial<Board>;
    const ref = getDb().collection('boards').doc(a.id);
    const now = nowIso();
    await getDb().runTransaction(async (tx) => {
      if (a.is_default) {
        const prev = await tx.get(
          getDb().collection('boards').where('is_default', '==', true).limit(5),
        );
        for (const d of prev.docs) {
          if (d.id !== a.id) tx.update(d.ref, { is_default: false, updated_at: now });
        }
      }
      const patch: Record<string, unknown> = { updated_at: now };
      if (a.name !== undefined) patch.name = a.name;
      if (a.description !== undefined) patch.description = a.description;
      if (a.kinds !== undefined) patch.kinds = a.kinds;
      if (a.columns !== undefined) patch.columns = a.columns;
      if (a.is_default !== undefined) patch.is_default = a.is_default;
      tx.update(ref, patch);
    });
    const fresh = await ref.get();
    return { board: fresh.data() as Board };
  },
);

const boardsDelete = tool(
  'worktracker.boards.delete',
  'Delete a board. Admin only. The default board returns `cannot_delete_default`; set another board as default first.',
  'admin',
  z.object({ id: ID }),
  async (args, ctx) => {
    if (!ctx.isAdmin) throw new InvalidInputError('boards.delete requires admin scope');
    const { id } = args as { id: string };
    const ref = getDb().collection('boards').doc(id);
    const doc = await ref.get();
    if (!doc.exists) throw new InvalidInputError(`board ${id} not found`);
    const board = doc.data() as Board;
    if (board.is_default) {
      throw new InvalidInputError('cannot delete the default board; set another as default first', {
        code: 'cannot_delete_default',
      });
    }
    await ref.delete();
    return { id, deleted: true };
  },
);

// =====================================================================
// files.* (3 tools)
// =====================================================================

const FILE_BYTES_LIMIT = 1_048_576; // 1 MB
const ITEM_BYTES_LIMIT = 10 * FILE_BYTES_LIMIT;

const filesList = tool(
  'worktracker.files.list',
  'List file pointers attached to a work item (metadata only). The bytes live in `files/{file_id}`.',
  'read',
  z.object({ item_id: ID }),
  async (args) => {
    const { item_id } = args as { item_id: string };
    const doc = await getDb().collection('work_items').doc(item_id).get();
    if (!doc.exists) return { files: [] as WorkItemFile[] };
    const item = doc.data() as WorkItem;
    return { files: item.files ?? [] };
  },
);

const filesGet = tool(
  'worktracker.files.get',
  'Download a file by id. Returns the metadata; the actual bytes are at `GET /api/files/:id` (the MCP transport is JSON, so binary download is on the REST surface).',
  'read',
  z.object({ id: ID }),
  async (args) => {
    const { id } = args as { id: string };
    const doc = await getDb().collection('files').doc(id).get();
    if (!doc.exists) return { file: null };
    const rec = doc.data() as FileRecord;
    // Return metadata; the bytes are too large for the JSON-RPC
    // envelope, and the REST `/api/files/:id` endpoint serves them.
    const { content_b64: _omit, ...meta } = rec;
    void _omit;
    return { file: meta };
  },
);

const filesUpload = tool(
  'worktracker.files.upload',
  'Attach a base64-encoded file to a work item. 1 MB per file, 10 MB per item. Returns the file_id and pointer.',
  'read_write',
  z.object({
    item_id: ID,
    name: z.string().min(1).max(200),
    content_type: z.string().min(1).max(200),
    content_b64: z.string().min(1).max(2_000_000),
  }),
  async (args, ctx) => {
    const a = args as { item_id: string; name: string; content_type: string; content_b64: string };
    const bytes = decodeBase64(a.content_b64);
    if (bytes.length > FILE_BYTES_LIMIT) {
      throw new InvalidInputError(`file exceeds 1 MB limit (got ${bytes.length} bytes)`);
    }
    const itemRef = getDb().collection('work_items').doc(a.item_id);
    const itemSnap = await itemRef.get();
    if (!itemSnap.exists) throw new InvalidInputError(`work item ${a.item_id} not found`);
    const item = itemSnap.data() as WorkItem;
    const existingBytes = (item.files ?? []).reduce((s, f) => s + (f.size_bytes ?? 0), 0);
    if (existingBytes + bytes.length > ITEM_BYTES_LIMIT) {
      throw new InvalidInputError(
        `item would exceed 10 MB attachment cap (have ${existingBytes}, adding ${bytes.length})`,
      );
    }
    const { createHash } = await import('node:crypto');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const fileId = ulid();
    const now = nowIso();
    const record: FileRecord = {
      file_id: fileId,
      name: a.name,
      content_type: a.content_type,
      size_bytes: bytes.length,
      content_b64: a.content_b64,
      owner_item_id: a.item_id,
      uploaded_by: ctx.source,
      uploaded_at: now,
      content_sha256: sha256,
    };
    const pointer: WorkItemFile = {
      file_id: fileId,
      name: a.name,
      content_type: a.content_type,
      size_bytes: bytes.length,
      added_at: now,
      content_sha256: sha256,
    };
    await getDb().runTransaction(async (tx) => {
      tx.set(getDb().collection('files').doc(fileId), record);
      tx.set(itemRef, {
        files: [...(item.files ?? []), pointer],
        updated_at: now,
        version: item.version + 1,
      });
    });
    return { file_id: fileId, file: pointer };
  },
);

// =====================================================================
// clients.* (4 tools)
// =====================================================================

const clientsList = tool(
  'worktracker.clients.list',
  'List all clients (agents + users) with their scope, last_used_at, and capabilities. Admin only.',
  'admin',
  z.object({}),
  async (_args, ctx) => {
    if (!ctx.isAdmin) throw new InvalidInputError('clients.list requires admin scope');
    const snap = await getDb().collection('sources').get();
    return { clients: snap.docs.map((d) => d.data() as Client) } satisfies ListClientsResponse;
  },
);

const clientsMint = tool(
  'worktracker.clients.mint',
  'Mint a new `kind: user` client (personal access token). Admin only. Returns the bearer exactly once.',
  'admin',
  z.object({
    name: z.string().min(1).max(120),
    scope: z.enum(['read', 'read_write', 'admin']).default('read_write'),
    owner_uid: z.string().min(1),
    owner_email: z.string().email(),
  }),
  async (args, _ctx) => {
    const { mintUserClient } = await import('./auth.js');
    const a = args as { name: string; scope: ApiTokenScope; owner_uid: string; owner_email: string };
    const mint = await mintUserClient(a);
    return { client: mint.record, bearer: mint.bearer };
  },
);

const clientsRotate = tool(
  'worktracker.clients.rotate',
  'Rotate a `kind: user` client\'s bearer. The old bearer is invalidated immediately. Admin only.',
  'admin',
  z.object({ name: ID }),
  async (args, _ctx) => {
    const { rotateUserClient } = await import('./auth.js');
    const { name } = args as { name: string };
    const ref = getDb().collection('sources').doc(name);
    const snap = await ref.get();
    if (!snap.exists) throw new InvalidInputError(`client ${name} not found`);
    const old = snap.data() as Client;
    if (old.kind !== 'user') {
      throw new InvalidInputError('rotate is only for kind: user clients');
    }
    const mint = await rotateUserClient({
      name: old.display_name,
      owner_uid: old.owner_uid ?? '',
      owner_email: old.owner_email ?? '',
      scope: old.scope,
      old_bearer_id: name,
    });
    return { client: mint.record, bearer: mint.bearer };
  },
);

const clientsIntrospect = tool(
  'worktracker.clients.introspect',
  '"Who am I" — returns the caller\'s name, scope, owner, capabilities, and the list of tool names this scope can see.',
  'read',
  z.object({}),
  async (_args, ctx) => {
    const { getEffectiveScope } = await import('./auth.js');
    const scope: ApiTokenScope = ctx.effectiveScope;
    const tools = TOOL_REGISTRY.filter((t) => scopeAtLeast(scope, t.required_scope)).map(
      (t) => t.name,
    );
    const source = ctx.req.auth?.source;
    const user = ctx.req.auth?.user;
    const response: IntrospectClientResponse = {
      name: source?.name ?? user?.firebase_uid ?? 'operator',
      kind: source?.kind ?? 'user',
      scope,
      owner_uid: source?.owner_uid ?? user?.firebase_uid ?? null,
      last_used_at: source?.last_used_at ?? null,
      capabilities: source?.capabilities ?? [],
      server_version: '1.0.0',
      visible_tools: tools,
    };
    return response;
  },
);

// =====================================================================
// connectors.* (2 tools)
// =====================================================================

const connectorsList = tool(
  'worktracker.connectors.list',
  'List all connectors (mirror, webhook-in, webhook-out, bridge) with their protocol and last-run status. Admin only.',
  'admin',
  z.object({}),
  async (_args, ctx) => {
    if (!ctx.isAdmin) throw new InvalidInputError('connectors.list requires admin scope');
    const snap = await getDb().collection('connectors').get();
    return { connectors: snap.docs.map((d) => d.data() as Connector) } satisfies ListConnectorsResponse;
  },
);

const connectorsGet = tool(
  'worktracker.connectors.get',
  'Fetch one connector by name, including its kind-specific config. Admin only.',
  'admin',
  z.object({ name: ID }),
  async (args, ctx) => {
    if (!ctx.isAdmin) throw new InvalidInputError('connectors.get requires admin scope');
    const { name } = args as { name: string };
    const doc = await getDb().collection('connectors').doc(name).get();
    if (!doc.exists) return { connector: null };
    return { connector: doc.data() as Connector };
  },
);

// =====================================================================
// dispatch.run + enrich.run (2 tools)
// =====================================================================

const dispatchRun = tool(
  'worktracker.dispatch.run',
  'High-level tool: pre-flight + missing enrichment + transition. Can also move an item from Backlog to a board (item_id + board_id + to_status).',
  'read_write',
  z.object({
    id: ID,
    options: z
      .object({
        force: z.boolean().optional(),
        enricher: z.string().optional(),
        stages: z.array(z.enum(['grill', 'wayfind'])).optional(),
        board_id: z.string().optional(),
        to_status: z.string().optional(),
      })
      .optional(),
  }),
  async (args, ctx) => {
    // Slice 4: surface a structured "fold" plan to the caller. The
    // heavy lifting (enrichment scheduling, batched updates) is a
    // slice 5 data-flow concern. For now, the tool records one or
    // more commands that the brain will apply in order.
    const a = args as { id: string; options?: { board_id?: string; to_status?: string; force?: boolean } };
    const cur = await getDb().collection('work_items').doc(a.id).get();
    if (!cur.exists) throw new InvalidInputError(`work item ${a.id} not found`);
    const current = cur.data() as WorkItem;
    const ops: Array<{ op: string; command_id: string }> = [];
    if (a.options?.board_id !== undefined && a.options.board_id !== current.board_id) {
      const c = await enqueue(
        'update',
        a.id,
        { patch: { board_id: a.options.board_id }, expected_version: current.version },
        ctx,
      );
      ops.push({ op: 'update', command_id: c.id });
    }
    if (a.options?.to_status) {
      const toStatus = a.options.to_status as WorkItem['status'];
      const check = canTransition(current.status, toStatus, current.kind);
      if (!check.ok) {
        throw new InvalidInputError(check.reason.message, {
          code: check.reason.code,
          from: check.reason.from,
          to: check.reason.to,
          kind: check.reason.kind,
        });
      }
      const c = await enqueue(
        'transition',
        a.id,
        { to_status: toStatus, expected_version: current.version },
        ctx,
      );
      ops.push({ op: 'transition', command_id: c.id });
    }
    return { ok: true, dispatch: 'queued', ops };
  },
);

const enrichRun = tool(
  'worktracker.enrich.run',
  'Standalone Grill / Wayfind run. Enqueues an `enrich` command; the brain writes the enrichment_state and an event.',
  'read_write',
  z.object({
    id: ID,
    stage: z.enum(['grill', 'wayfind', 'both']),
    enricher: z.string().optional(),
  }),
  async (args, ctx) => {
    const command = await enqueue('enrich', (args as { id: string }).id, args, ctx);
    return { command_id: command.id, status: 'queued' };
  },
);

// =====================================================================
// Registry — the order of entries here is the order `tools/list`
// returns them. Handlers are pure functions over `(args, ctx) =>
// Promise<unknown>` so a future addition (e.g. a worker thread
// pool) only has to swap the dispatch loop in `mcp.ts`, not the
// tools themselves.
// =====================================================================

export const TOOL_REGISTRY: McpToolDef[] = [
  // items
  itemsList,
  itemsGet,
  itemsCreate,
  itemsUpdate,
  itemsComment,
  itemsLink,
  itemsUnlink,
  // boards
  boardsList,
  boardsGet,
  boardsCreate,
  boardsUpdate,
  boardsDelete,
  // files
  filesList,
  filesGet,
  filesUpload,
  // clients
  clientsList,
  clientsMint,
  clientsRotate,
  clientsIntrospect,
  // connectors
  connectorsList,
  connectorsGet,
  // dispatch + enrich
  dispatchRun,
  enrichRun,
];

/**
 * Build the `tools/list` payload filtered by the caller's scope.
 * The wrapper calls this on every `tools/list` JSON-RPC request.
 */
export function listToolsForScope(scope: ApiTokenScope): Array<{
  name: McpToolName;
  description: string;
  required_scope: ApiTokenScope;
  inputSchema: McpToolDef['inputSchema'];
}> {
  return TOOL_REGISTRY.filter((t) => scopeAtLeast(scope, t.required_scope)).map((t) => ({
    name: t.name,
    description: t.description,
    required_scope: t.required_scope,
    inputSchema: t.inputSchema,
  }));
}

/**
 * Look up a tool by name. The wrapper calls this on every
 * `tools/call` request. Returns `null` for unknown names so the
 * caller can surface a -32601.
 */
export function findTool(name: string): McpToolDef | null {
  return TOOL_REGISTRY.find((t) => t.name === name) ?? null;
}

/**
 * Build the ToolContext for a Fastify request. The auth middleware
 * has already populated `req.auth` by the time this is called
 * (the wrapper registers `requireSource` as a preHandler).
 */
export function buildToolContext(req: FastifyRequest): ToolContext {
  const { getEffectiveScope } = require('./auth.js') as typeof import('./auth.js');
  const source =
    req.auth?.source?.name ??
    (req.auth?.user ? `users/${req.auth.user.firebase_uid}` : 'web');
  const effectiveScope = getEffectiveScope(req);
  return {
    req,
    source,
    effectiveScope,
    isAdmin: scopeAtLeast(effectiveScope, 'admin'),
  };
}

/**
 * The unified dispatcher. v1 (`/mcp`) and v2 (`/mcp/v2`,
 * `/mcp/stream`) both call this. The flow:
 *
 *   1. Look up the tool by name. Unknown → -32601.
 *   2. Re-check scope. `tools/list` already filtered, but a
 *      stale client could try a tool it can't see. → -32603.
 *   3. Parse `arguments` against the tool's Zod schema. → -32602.
 *   4. Run the handler. `InvalidInputError` → -32602; any other
 *      throw → -32603.
 *   5. Return the value on success.
 */
export async function dispatchTool(
  name: string,
  arguments_: unknown,
  req: FastifyRequest,
): Promise<ToolDispatchResult> {
  const tool = findTool(name);
  if (!tool) {
    const result: ToolDispatchResult = { ok: false, error: `unknown tool: ${name}`, code: -32601 };
    void recordTrace(name, req, result);
    return result;
  }
  const ctx = buildToolContext(req);
  if (!scopeAtLeast(ctx.effectiveScope, tool.required_scope)) {
    const result: ToolDispatchResult = {
      ok: false,
      error: `tool ${name} requires ${tool.required_scope} scope (effective: ${ctx.effectiveScope})`,
      code: -32603,
    };
    void recordTrace(name, req, result);
    return result;
  }
  const parsed = tool.schema.safeParse(arguments_ ?? {});
  if (!parsed.success) {
    const result: ToolDispatchResult = {
      ok: false,
      error: `arguments for ${name} failed schema validation: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
      code: -32602,
      data: { issues: parsed.error.issues },
    };
    void recordTrace(name, req, result);
    return result;
  }
  const start = Date.now();
  try {
    const value = await tool.handler(parsed.data, ctx);
    const result: ToolDispatchResult = { ok: true, value };
    void recordTrace(name, req, result, Date.now() - start);
    return result;
  } catch (err) {
    let result: ToolDispatchResult;
    if (err instanceof InvalidInputError) {
      result = {
        ok: false,
        error: err.message,
        code: -32602,
        data: err.details,
      };
    } else if (err && typeof err === 'object' && 'name' in err && err.name === 'WorkTrackerError') {
      result = {
        ok: false,
        error: (err as Error).message,
        code: -32603,
      };
    } else {
      result = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: -32603,
      };
    }
    void recordTrace(name, req, result, Date.now() - start);
    return result;
  }
}

/**
 * Best-effort analytics write. The dispatcher doesn't await
 * the trace (it's a side-channel; latency-sensitive calls
 * shouldn't block on Firestore), but the failure mode is
 * "lost trace row", never "broken tool call".
 */
async function recordTrace(
  name: string,
  req: FastifyRequest,
  result: ToolDispatchResult,
  latencyMs?: number,
): Promise<void> {
  try {
    const mapped = mapDispatchOutcome(result.ok, result.code, result.error);
    const bearerId = req.auth?.source?.name
      ? `clients/${req.auth.source.name}`
      : req.auth?.user
        ? `users/${req.auth.user.firebase_uid}`
        : 'anonymous';
    const agent = (req.headers['user-agent'] ?? 'unknown')
      .toString()
      .split(' ')[0]
      .toLowerCase()
      .slice(0, 64);
    await recordCallTrace({
      agent,
      bearer_id: bearerId,
      context: 'mcp_call',
      tool: name,
      request: {
        method: req.method,
        path: req.url,
      },
      outcome: mapped.outcome,
      ...(latencyMs !== undefined
        ? { response: { status: 200, latency_ms: latencyMs } }
        : {}),
      ...(mapped.error ? { error: mapped.error } : {}),
    });
  } catch {
    // The trace write is best-effort; swallow errors so a
    // Firestore blip doesn't bubble up as a tool call failure.
  }
}

// =====================================================================
// Helpers
// =====================================================================

/**
 * Enqueue a brain command. The brain's Firestore trigger picks
 * it up and applies it inside a transaction. We return the
 * command so the handler can echo the `command_id` to the
 * caller.
 */
async function enqueue(
  op: 'create' | 'update' | 'transition' | 'comment' | 'link' | 'unlink' | 'archive' | 'enrich',
  itemId: string | null,
  payload: unknown,
  ctx: ToolContext,
) {
  const command = {
    id: ulid(),
    source: ctx.source,
    source_event_id: null,
    op,
    item_id: itemId,
    payload: payload as never,
    status: 'queued' as const,
    error: null,
    applied_event_id: null,
    created_at: nowIso(),
    applied_at: null,
    failure_count: 0,
    failed_at: null,
    requeued_at: null,
  };
  await getDb().collection('commands').doc(command.id).set(command);
  return command;
}

function decodeBase64(input: string): Buffer {
  const cleaned = input.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}
