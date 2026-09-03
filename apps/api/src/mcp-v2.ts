/**
 * MCP-spec-compliant JSON-RPC 2.0 wrapper. Adds the required
 * `content` array (text blocks) and an optional
 * `structuredContent` to every `tools/call` result, so strict
 * MCP SDKs (Anthropic, OpenAI, Hermes) accept our responses.
 *
 * The v1 endpoint (`/mcp` in mcp.ts) returns a bare `result`
 * object — fast for the AI chat, but non-conformant. The two
 * routes share the same tool dispatch (`dispatchTool`) so
 * behavior is identical; only the response envelope differs.
 *
 * v2 route surface:
 *   POST /api/mcp/v2   POST /mcp/v2
 *   GET  /api/mcp/v2   GET  /mcp/v2  (405 — POST a JSON-RPC envelope)
 *
 * The transport is the same JSON-RPC 2.0 + SSE-ready pattern
 * as v1; the only difference is the `result` shape inside
 * `tools/call` responses.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireSource, getEffectiveScope } from './auth.js';
import { dispatchTool, type DispatchResult, type JsonRpcRequest, type JsonRpcResponse } from './mcp.js';
import type { ApiTokenScope } from '@worktracker/types';

const TOOL_LIST = [
  { name: 'worktracker_list_items', required_scope: 'read' as const, description: 'List work items.', inputSchema: { type: 'object', properties: {
    kind: { type: 'string', enum: ['task', 'ticket', 'decision', 'review'] },
    status: { type: 'string' },
    source: { type: 'string' },
    owner: { type: 'string' },
    q: { type: 'string' },
    limit: { type: 'number' },
    include_archived: { type: 'boolean' },
  }}},
  { name: 'worktracker_get_item', required_scope: 'read' as const, description: 'Get one work item with its events.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'worktracker_create_item', required_scope: 'read_write' as const, description: 'Create a new work item.', inputSchema: { type: 'object', properties: {
    kind: { type: 'string', enum: ['task', 'ticket', 'decision', 'review'] }, title: { type: 'string' },
    body: { type: 'string' }, severity: { type: 'string' }, priority: { type: 'string' },
    owner: { type: 'string' }, due_at: { type: 'string' },
  }, required: ['kind', 'title'] } },
  { name: 'worktracker_update_item', required_scope: 'read_write' as const, description: 'Patch fields on a work item.', inputSchema: { type: 'object', properties: {
    id: { type: 'string' }, patch: { type: 'object' }, expected_version: { type: 'number' },
  }, required: ['id', 'patch', 'expected_version'] } },
  { name: 'worktracker_transition', required_scope: 'read_write' as const, description: 'Move a work item to a new status.', inputSchema: { type: 'object', properties: {
    id: { type: 'string' }, to_status: { type: 'string' }, comment: { type: 'string' },
    force_dispatch: { type: 'boolean' }, expected_version: { type: 'number' },
  }, required: ['id', 'to_status', 'expected_version'] } },
  { name: 'worktracker_comment', required_scope: 'read_write' as const, description: 'Append a comment to a work item.', inputSchema: { type: 'object', properties: {
    id: { type: 'string' }, body: { type: 'string' }, expected_version: { type: 'number' },
  }, required: ['id', 'body'] } },
  { name: 'worktracker_link_items', required_scope: 'read_write' as const, description: 'Link two work items.', inputSchema: { type: 'object', properties: {
    parent_id: { type: 'string' }, child_id: { type: 'string' },
    kind: { type: 'string', enum: ['depends_on', 'blocks', 'related', 'mirrors', 'parent_of'] },
  }, required: ['parent_id', 'child_id', 'kind'] } },
  { name: 'worktracker_list_boards', required_scope: 'read' as const, description: 'List all kanban boards.', inputSchema: { type: 'object', properties: {} } },
  { name: 'worktracker_get_board', required_scope: 'read' as const, description: 'Get one board by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'worktracker_create_board', required_scope: 'admin' as const, description: 'Create a new board. Admin only.', inputSchema: { type: 'object', properties: {
    name: { type: 'string' }, description: { type: 'string' },
    kinds: { type: 'array', items: { type: 'string' } },
    columns: { type: 'array' }, is_default: { type: 'boolean' },
  }, required: ['name', 'columns'] } },
  { name: 'worktracker_update_board', required_scope: 'admin' as const, description: 'Patch a board. Admin only.', inputSchema: { type: 'object', properties: {
    id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
    kinds: { type: 'array', items: { type: 'string' } },
    columns: { type: 'array' }, is_default: { type: 'boolean' },
  }, required: ['id'] } },
  { name: 'worktracker_delete_board', required_scope: 'admin' as const, description: 'Delete a board. Admin only.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'worktracker_enrich', required_scope: 'read_write' as const, description: 'Run Grill/Wayfind on a work item.', inputSchema: { type: 'object', properties: {
    id: { type: 'string' }, stage: { type: 'string', enum: ['grill', 'wayfind', 'both'] }, enricher: { type: 'string' },
  }, required: ['id', 'stage'] } },
  { name: 'worktracker_dispatch', required_scope: 'read_write' as const, description: 'High-level ship-it tool.', inputSchema: { type: 'object', properties: {
    id: { type: 'string' }, options: { type: 'object' },
  }, required: ['id'] } },
  { name: 'worktracker_set_reminder', required_scope: 'read_write' as const, description: 'Set a reminder (v0.5 stub).', inputSchema: { type: 'object', properties: {
    item_id: { type: 'string' }, remind_at: { type: 'string' }, channel: { type: 'string' }, target: { type: 'string' },
  }, required: ['item_id', 'remind_at', 'channel', 'target'] } },
];

export async function mcpRoutesV2(app: FastifyInstance): Promise<void> {
  const getHandler = async (
    _req: FastifyRequest,
    reply: import('fastify').FastifyReply,
  ) => {
    reply.code(405).send({ error: 'GET /mcp/v2 not supported; POST JSON-RPC to /mcp/v2' });
  };
  app.get('/api/mcp/v2', { preHandler: requireSource }, getHandler);
  app.get('/mcp/v2', { preHandler: requireSource }, getHandler);

  app.post('/api/mcp/v2', { preHandler: requireSource }, async (req, reply) => {
    const body = req.body as JsonRpcRequest | JsonRpcRequest[];
    const requests = Array.isArray(body) ? body : [body];
    const responses = await Promise.all(requests.map((r) => handleRpcV2(r, req)));
    reply.send(Array.isArray(body) ? responses : responses[0]);
  });
  app.post('/mcp/v2', { preHandler: requireSource }, async (req, reply) => {
    const body = req.body as JsonRpcRequest | JsonRpcRequest[];
    const requests = Array.isArray(body) ? body : [body];
    const responses = await Promise.all(requests.map((r) => handleRpcV2(r, req)));
    reply.send(Array.isArray(body) ? responses : responses[0]);
  });
}

async function handleRpcV2(
  req: JsonRpcRequest,
  httpReq: FastifyRequest,
): Promise<JsonRpcResponse> {
  if (req.jsonrpc !== '2.0') {
    return v2Error(req, -32600, 'invalid jsonrpc version');
  }
  try {
    switch (req.method) {
      case 'initialize':
        return v2Result(req, {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'worktracker', version: '0.1.0' },
          capabilities: { tools: {} },
        });
      case 'notifications/initialized':
        return v2Result(req, {});
      case 'tools/list': {
        // Slice 1: filter the catalog by the bearer's effective
        // scope. Mirror of the v1 filter; the v1 and v2 endpoints
        // see the same tool set for the same caller. Slice 4 will
        // consolidate the two TOOL_* arrays; for now they share
        // the same `required_scope` field per entry.
        const effective = getEffectiveScope(httpReq);
        const RANK: Record<ApiTokenScope, number> = { read: 1, read_write: 2, admin: 3 };
        const tools = TOOL_LIST.filter((t) => {
          const required = (t as { required_scope?: ApiTokenScope }).required_scope ?? 'read';
          return RANK[effective] >= RANK[required];
        });
        return v2Result(req, { tools });
      }
      case 'tools/call': {
        const params = (req.params ?? {}) as { name: string; arguments?: unknown };
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const result = await dispatchTool(params.name, args, httpReq);
        return v2ToolResult(req, result);
      }
      default:
        return v2Error(req, -32601, `unknown method: ${req.method}`);
    }
  } catch (err) {
    return v2Error(req, -32603, (err as Error).message);
  }
}

function v2Result(req: JsonRpcRequest, value: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: req.id, result: value };
}

function v2Error(req: JsonRpcRequest, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: req.id, error: { code, message, ...(data ? { data } : {}) } };
}

/**
 * Wrap a DispatchResult in the MCP-spec CallToolResult shape:
 *   { content: [{ type: 'text', text: '...' }], structuredContent: {...}, isError: false }
 *
 * - `content[0].text` is a JSON-stringified version of the data —
 *   strict MCP clients use this as the model-visible text.
 * - `structuredContent` is the raw data for clients that want
 *   typed access (Anthropic, OpenAI, Hermes SDK validators).
 * - `isError: true` is set on dispatch failures so strict
 *   clients can surface tool errors instead of treating them
 *   as successful results.
 */
function v2ToolResult(req: JsonRpcRequest, dispatch: DispatchResult): JsonRpcResponse {
  if (dispatch.ok) {
    const value = dispatch.value;
    return v2Result(req, {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value,
      isError: false,
    });
  }
  const errorPayload = { ok: false, error: dispatch.error ?? 'internal error' };
  return v2Result(req, {
    content: [{ type: 'text', text: JSON.stringify(errorPayload) }],
    structuredContent: errorPayload,
    isError: true,
  });
}
