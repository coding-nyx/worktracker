/**
 * MCP server. Mounts at `/mcp` on the same Fastify process as
 * the REST API. Implements the JSON-RPC 2.0 + SSE transport
 * the MCP spec defines, with our `worktracker_*` tools.
 *
 * Auth uses the same per-source bearer token as the REST API.
 * Each source connects with its own key; admin tools (`worktracker_*`
 * admin operations, if any) require the admin token.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  Command,
  ListItemsQuery,
  McpDispatchArgs,
  McpEnrichArgs,
  WorkItem,
} from './local-types/index';
import { z } from 'zod';
import { ulid, nowIso } from './ids.js';
import { getDb } from './firestore.js';
import { requireSource } from './auth.js';
import { InvalidInputError } from './errors.js';
import { evaluateCommand as _evaluateCommand } from './brain.js';
void _evaluateCommand; // reserved for the in-process evaluation path

// ----- JSON-RPC 2.0 envelopes -----

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null | undefined;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ----- Tool definitions -----

const TOOLS = [
  {
    name: 'worktracker_list_items',
    description:
      'List work items. Returns items, optionally filtered by kind/status/source/owner and a search query.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['task', 'ticket', 'decision', 'review'] },
        status: { type: 'string' },
        source: { type: 'string' },
        owner: { type: 'string' },
        q: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 200, default: 50 },
        include_archived: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'worktracker_get_item',
    description: 'Get one work item by id, including its event timeline.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'worktracker_create_item',
    description: 'Create a new work item. Returns the new item id.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['task', 'ticket', 'decision', 'review'] },
        title: { type: 'string' },
        body: { type: 'string' },
        severity: { type: 'string' },
        priority: { type: 'string' },
        owner: { type: 'string' },
        due_at: { type: 'string' },
        source_id: { type: 'string' },
        source_meta: { type: 'object' },
      },
      required: ['kind', 'title'],
    },
  },
  {
    name: 'worktracker_update_item',
    description: 'Update fields on a work item. Requires expected_version for optimistic concurrency.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        patch: { type: 'object' },
        expected_version: { type: 'number' },
      },
      required: ['id', 'patch', 'expected_version'],
    },
  },
  {
    name: 'worktracker_transition',
    description: 'Transition a work item to a new status. Enqueues a `transition` command.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        to_status: { type: 'string' },
        comment: { type: 'string' },
        force_dispatch: { type: 'boolean' },
        expected_version: { type: 'number' },
      },
      required: ['id', 'to_status', 'expected_version'],
    },
  },
  {
    name: 'worktracker_comment',
    description: 'Add a comment event to a work item.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        body: { type: 'string' },
        expected_version: { type: 'number' },
      },
      required: ['id', 'body'],
    },
  },
  {
    name: 'worktracker_link_items',
    description: 'Link two work items (parent -> child) with a kind.',
    inputSchema: {
      type: 'object',
      properties: {
        parent_id: { type: 'string' },
        child_id: { type: 'string' },
        kind: {
          type: 'string',
          enum: ['depends_on', 'blocks', 'related', 'mirrors', 'parent_of'],
        },
      },
      required: ['parent_id', 'child_id', 'kind'],
    },
  },
  {
    name: 'worktracker_set_reminder',
    description: 'Attach a reminder to a work item (v0.5).',
    inputSchema: {
      type: 'object',
      properties: {
        item_id: { type: 'string' },
        remind_at: { type: 'string' },
        channel: { type: 'string' },
        target: { type: 'string' },
      },
      required: ['item_id', 'remind_at', 'channel', 'target'],
    },
  },
  {
    name: 'worktracker_enrich',
    description: 'Run Grill or Wayfind on a work item. v0 stretch.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        stage: { type: 'string', enum: ['grill', 'wayfind', 'both'] },
        enricher: { type: 'string' },
      },
      required: ['id', 'stage'],
    },
  },
  {
    name: 'worktracker_dispatch',
    description: 'High-level tool: pre-flight check + missing enrichment + status transition. Returns a job id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        options: {
          type: 'object',
          properties: {
            force: { type: 'boolean' },
            enricher: { type: 'string' },
            stages: { type: 'array', items: { type: 'string', enum: ['grill', 'wayfind'] } },
          },
        },
      },
      required: ['id'],
    },
  },
] as const;

// ----- Router -----

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  // SSE endpoint for clients to receive server-pushed events.
  // For v0 the MCP surface is request/response only; SSE is here
  // so the contract is ready when we add it.
  app.get('/api/mcp', { preHandler: requireSource }, async (_req, reply) => {
    reply.code(405).send({ error: 'GET /mcp not supported; POST JSON-RPC to /mcp' });
  });

  // JSON-RPC 2.0 over HTTP (per MCP spec, accepts a single
  // request or a batch).
  app.post('/api/mcp', { preHandler: requireSource }, async (req, reply) => {
    const body = req.body as JsonRpcRequest | JsonRpcRequest[];
    const requests = Array.isArray(body) ? body : [body];
    const responses = await Promise.all(requests.map((r) => handleRpc(r, req)));
    const payload = Array.isArray(body) ? responses : responses[0];
    reply.send(payload);
  });
}

async function handleRpc(req: JsonRpcRequest, httpReq: FastifyRequest): Promise<JsonRpcResponse> {
  if (req.jsonrpc !== '2.0') {
    return rpcError(req, -32600, 'invalid jsonrpc version');
  }
  try {
    switch (req.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'worktracker', version: '0.1.0' },
            capabilities: { tools: {} },
          },
        };
      case 'notifications/initialized':
        // Client-side notification; no response.
        return { jsonrpc: '2.0', id: req.id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } };
      case 'tools/call': {
        const params = (req.params ?? {}) as { name: string; arguments?: unknown };
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        return await handleToolCall(req, params.name, args, httpReq);
      }
      default:
        return rpcError(req, -32601, `unknown method: ${req.method}`);
    }
  } catch (err) {
    if (err instanceof InvalidInputError) {
      return rpcError(req, -32602, err.message, err.details);
    }
    return rpcError(req, -32603, (err as Error).message);
  }
}

function rpcError(
  req: JsonRpcRequest,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id: req.id, error: { code, message, ...(data ? { data } : {}) } };
}

async function handleToolCall(
  req: JsonRpcRequest,
  name: string,
  args: Record<string, unknown>,
  httpReq: FastifyRequest,
): Promise<JsonRpcResponse> {
  const source = httpReq.auth?.source?.name ?? 'web';
  const enqueue = async <Op extends Command['op']>(
    op: Op,
    itemId: string | null,
    payload: Extract<Command, { op: Op }>['payload'],
  ): Promise<Extract<Command, { op: Op }>> => {
    const command = {
      id: ulid(),
      source,
      source_event_id: null,
      op,
      item_id: itemId,
      payload,
      status: 'queued' as const,
      error: null,
      applied_event_id: null,
      created_at: nowIso(),
      applied_at: null,
    } as Extract<Command, { op: Op }>;
    await getDb().collection('commands').doc(command.id).set(command);
    return command;
  };

  switch (name) {
    case 'worktracker_list_items': {
      const query = (args as unknown as ListItemsQuery) ?? {};
      let ref = getDb().collection('work_items').orderBy('updated_at', 'desc');
      if (query.kind) ref = ref.where('kind', '==', query.kind);
      if (query.status) ref = ref.where('status', '==', query.status);
      if (query.source) ref = ref.where('source', '==', query.source);
      if (query.owner) ref = ref.where('owner', '==', query.owner);
      ref = ref.limit(query.limit ?? 50);
      const snap = await ref.get();
      const items = snap.docs.map((d) => d.data() as WorkItem);
      return { jsonrpc: '2.0', id: req.id, result: { items } };
    }
    case 'worktracker_get_item': {
      const id = z.object({ id: z.string() }).parse(args).id;
      const doc = await getDb().collection('work_items').doc(id).get();
      if (!doc.exists) return { jsonrpc: '2.0', id: req.id, result: { item: null } };
      const events = await doc.ref.collection('events').orderBy('created_at', 'asc').get();
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: { item: doc.data() as WorkItem, events: events.docs.map((d) => d.data()) },
      };
    }
    case 'worktracker_create_item': {
      const payload = z
        .object({
          kind: z.enum(['task', 'ticket', 'decision', 'review']),
          title: z.string().min(1),
          body: z.string().optional(),
          severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
          priority: z.enum(['low', 'medium', 'high']).optional(),
          owner: z.string().optional(),
          due_at: z.string().optional(),
          source_id: z.string().optional(),
          source_meta: z.record(z.unknown()).optional(),
        })
        .parse(args);
      const command = await enqueue('create', null, payload);
      return { jsonrpc: '2.0', id: req.id, result: { command_id: command.id, status: 'queued' } };
    }
    case 'worktracker_update_item': {
      const args_ = z
        .object({
          id: z.string(),
          patch: z.record(z.unknown()),
          expected_version: z.number(),
        })
        .parse(args);
      const command = await enqueue('update', args_.id, {
        patch: args_.patch as never,
        expected_version: args_.expected_version,
      });
      return { jsonrpc: '2.0', id: req.id, result: { command_id: command.id, status: 'queued' } };
    }
    case 'worktracker_transition': {
      const args_ = z
        .object({
          id: z.string(),
          to_status: z.string(),
          comment: z.string().optional(),
          force_dispatch: z.boolean().optional(),
          expected_version: z.number(),
        })
        .parse(args);
      const command = await enqueue('transition', args_.id, args_ as never);
      return { jsonrpc: '2.0', id: req.id, result: { command_id: command.id, status: 'queued' } };
    }
    case 'worktracker_comment': {
      const args_ = z
        .object({ id: z.string(), body: z.string(), expected_version: z.number().optional() })
        .parse(args);
      const command = await enqueue('comment', args_.id, args_ as never);
      return { jsonrpc: '2.0', id: req.id, result: { command_id: command.id, status: 'queued' } };
    }
    case 'worktracker_link_items': {
      const args_ = z
        .object({
          parent_id: z.string(),
          child_id: z.string(),
          kind: z.enum(['depends_on', 'blocks', 'related', 'mirrors', 'parent_of']),
        })
        .parse(args);
      const command = await enqueue('link', args_.parent_id, args_ as never);
      return { jsonrpc: '2.0', id: req.id, result: { command_id: command.id, status: 'queued' } };
    }
    case 'worktracker_set_reminder': {
      return { jsonrpc: '2.0', id: req.id, result: { accepted: false, reason: 'v0.5' } };
    }
    case 'worktracker_enrich': {
      const args_ = z
        .object({ id: z.string(), stage: z.enum(['grill', 'wayfind', 'both']), enricher: z.string().optional() })
        .parse(args) satisfies McpEnrichArgs;
      const command = await enqueue('enrich', args_.id, args_ as never);
      return { jsonrpc: '2.0', id: req.id, result: { command_id: command.id, status: 'queued' } };
    }
    case 'worktracker_dispatch': {
      const args_ = z
        .object({
          id: z.string(),
          options: z
            .object({
              force: z.boolean().optional(),
              enricher: z.string().optional(),
              stages: z.array(z.enum(['grill', 'wayfind'])).optional(),
            })
            .optional(),
        })
        .parse(args) satisfies McpDispatchArgs;
      const target = await getDb().collection('work_items').doc(args_.id).get();
      if (!target.exists) {
        return { jsonrpc: '2.0', id: req.id, result: { error: 'not_found' } };
      }
      const jobId = ulid();
      if (args_.options?.stages?.length) {
        for (const stage of args_.options.stages) {
          await enqueue('enrich', args_.id, {
            stage,
            ...(args_.options.enricher ? { enricher: args_.options.enricher } : {}),
          });
        }
      }
      return { jsonrpc: '2.0', id: req.id, result: { job_id: jobId, status: 'enriching' } };
    }
    default:
      return rpcError(req, -32601, `unknown tool: ${name}`);
  }
}
