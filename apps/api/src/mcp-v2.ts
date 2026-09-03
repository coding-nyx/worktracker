/**
 * MCP-spec-compliant JSON-RPC 2.0 wrapper. Adds the required
 * `content` array (text blocks) and an optional
 * `structuredContent` to every `tools/call` result, so strict
 * MCP SDKs (Anthropic, OpenAI, Hermes) accept our responses.
 *
 * The v1 endpoint (`/mcp` in mcp.ts) returns a bare `result`
 * object — fast for the AI chat, but non-conformant. The two
 * routes share the same tool dispatch (`dispatchTool` in
 * `mcp-tools.ts`) so behavior is identical; only the response
 * envelope differs.
 *
 * v2 route surface:
 *   POST /api/mcp/v2   POST /mcp/v2
 *   GET  /api/mcp/v2   GET  /mcp/v2  (405 — POST a JSON-RPC envelope)
 *
 * Slice 4: the 23 tools come from `mcp-tools.ts` (single source
 * of truth). This file only adds the spec-compliant envelope.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireSource, getEffectiveScope } from './auth.js';
import {
  dispatchTool,
  listToolsForScope,
  type ToolDispatchResult,
} from './mcp-tools.js';
import type { JsonRpcRequest, JsonRpcResponse } from './mcp.js';
import { attachTrace, getTrace, logTraceEvent, newRequestTrace } from './trace.js';

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
    const trace = newRequestTrace();
    attachTrace(req, trace);
    logTraceEvent(req, 'mcp.request', { path: '/api/mcp/v2' });
    const body = req.body as JsonRpcRequest | JsonRpcRequest[];
    const requests = Array.isArray(body) ? body : [body];
    const responses = await Promise.all(requests.map((r) => handleRpcV2(r, req)));
    reply.header('X-Request-Id', trace.requestId);
    reply.send(Array.isArray(body) ? responses : responses[0]);
  });
  app.post('/mcp/v2', { preHandler: requireSource }, async (req, reply) => {
    const trace = newRequestTrace();
    attachTrace(req, trace);
    logTraceEvent(req, 'mcp.request', { path: '/mcp/v2' });
    const body = req.body as JsonRpcRequest | JsonRpcRequest[];
    const requests = Array.isArray(body) ? body : [body];
    const responses = await Promise.all(requests.map((r) => handleRpcV2(r, req)));
    reply.header('X-Request-Id', trace.requestId);
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
          serverInfo: { name: 'worktracker', version: '1.0.0' },
          capabilities: { tools: {} },
        });
      case 'notifications/initialized':
        return v2Result(req, {});
      case 'tools/list': {
        // Filter the registry by the bearer's effective scope.
        // v1 and v2 see the same tool set for the same caller.
        const tools = listToolsForScope(getEffectiveScope(httpReq));
        return v2Result(req, { tools });
      }
      case 'tools/call': {
        const params = (req.params ?? {}) as { name: string; arguments?: unknown };
        logTraceEvent(httpReq, 'mcp.tool.call.start', { tool: params.name });
        const result = await dispatchTool(params.name, params.arguments, httpReq);
        if (result.ok) {
          logTraceEvent(httpReq, 'mcp.tool.call.ok', { tool: params.name });
        } else {
          logTraceEvent(httpReq, 'mcp.tool.call.error', {
            tool: params.name,
            code: result.code ?? -32603,
          });
        }
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
 * Wrap a ToolDispatchResult in the MCP-spec CallToolResult shape:
 *   { content: [{ type: 'text', text: '...' }], structuredContent: {...}, isError: false }
 *
 * - `content[0].text` is a JSON-stringified version of the data —
 *   strict MCP clients use this as the model-visible text.
 * - `structuredContent` is the raw data for clients that want
 *   typed access (Anthropic, OpenAI, Hermes SDK validators).
 * - `isError: true` is set on dispatch failures so strict
 *   clients can surface tool errors instead of treating them
 *   as successful results.
 * - On error, the structured payload includes the JSON-RPC code
 *   so the SDK can branch on it (`result.code === -32602`).
 */
function v2ToolResult(req: JsonRpcRequest, dispatch: ToolDispatchResult): JsonRpcResponse {
  if (dispatch.ok) {
    const value = dispatch.value;
    return v2Result(req, {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value,
      isError: false,
    });
  }
  const errorPayload = {
    ok: false,
    error: dispatch.error ?? 'internal error',
    code: dispatch.code ?? -32603,
    ...(dispatch.data ? { data: dispatch.data } : {}),
  };
  return v2Result(req, {
    content: [{ type: 'text', text: JSON.stringify(errorPayload) }],
    structuredContent: errorPayload,
    isError: true,
  });
}
