/**
 * MCP server — v1 transport. Mounts at `/mcp` and `/api/mcp` on
 * the same Fastify process as the REST API. Implements the
 * JSON-RPC 2.0 + SSE-ready transport the MCP spec defines.
 *
 * The 23 tools are declared in `mcp-tools.ts`; this file only
 * handles:
 *   - HTTP route registration
 *   - The JSON-RPC envelope (initialize, notifications/initialized,
 *     tools/list, tools/call)
 *   - The /mcp.md Markdown on-ramp
 *   - The /mcp/stream Streamable HTTP variant (slice 1)
 *
 * The v2 transport (`mcp-v2.ts`) is identical except for the
 * `tools/call` result envelope (spec-compliant `content[]` +
 * `structuredContent`); both call the same `dispatchTool` from
 * the registry.
 *
 * The "no tool will fail" promise (architecture v1 §1) is
 * preserved by `tools/list` filtering the catalog by the
 * bearer's effective scope. `tools/call` re-checks as defense
 * in depth.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { requireSource, getEffectiveScope } from './auth.js';
import { dispatchTool, listToolsForScope, findTool } from './mcp-tools.js';

// ----- JSON-RPC 2.0 envelopes -----

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null | undefined;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * The internal shape `dispatchTool` returns. The v1 wrapper
 * publishes this directly as `result`; the v2 wrapper wraps it
 * in the spec-compliant `content` + `structuredContent` envelope.
 */
export interface DispatchResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  code?: number;
}

// ----- Tool discovery (re-export the registry's filtered view) -----

/**
 * The 23 MCP tool descriptors, filtered by the bearer's effective
 * scope. The list is computed on every `tools/list` call so
 * scope changes (admin promotion, demotion) take effect
 * immediately.
 */
export function listToolsForRequest(req: FastifyRequest) {
  return listToolsForScope(getEffectiveScope(req));
}

/**
 * Look up a tool by name. Convenience re-export for the v2
 * wrapper, which doesn't import from auth.ts directly.
 */
export { findTool };

// ----- Markdown on-ramp (served on GET /mcp.md) -----
//
// A Markdown page for LLM agents (Claude Code, Codex, Hermes).
// The page is public — auth is only enforced on POST /mcp. Edit
// here and redeploy to update the live page.

const MCP_DOC = `# MCP for WorkTracker

A source-authenticated JSON-RPC 2.0 surface for the WorkTracker kanban.
Any MCP client (Claude Code, Codex, Hermes, custom GPTs) can read kanban
state, mutate work items, and manage boards through a single HTTP endpoint.

- **Server URL:** \`https://worktracker-nyx.web.app/mcp\`
- **Protocol:** JSON-RPC 2.0 over HTTP
- **Transport:** Request/response in v0 (SSE endpoint is registered but
  does not yet push events)
- **Auth:** Bearer token per client, or the \`WORKTRACKER_ADMIN_TOKEN\`
- **Tools:** 23 (dotted namespaces: \`worktracker.items.*\`, \`worktracker.boards.*\`,
  \`worktracker.files.*\`, \`worktracker.clients.*\`, \`worktracker.connectors.*\`,
  \`worktracker.dispatch.*\`, \`worktracker.enrich.*\`)

This page is the on-ramp. Fetch it with \`curl\` or point an LLM at it.

---

## Quick start

### 1. Add a client (admin)

A client is a named API credential. The admin registers it; the API
returns a bearer. The server stores the key as a scrypt hash; the
plaintext is shown once.

\`\`\`bash
curl -X POST https://worktracker-nyx.web.app/api/clients \\
  -H "Authorization: Bearer $WORKTRACKER_ADMIN_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"manifest":{"name":"my-agent","display_name":"My Agent",
                  "kind":"agent",
                  "capabilities":["create","update","transition","comment","link"],
                  "version":"1.0.0"},
       "scope":"read_write"}'
\`\`\`

Response (example):

\`\`\`json
{
  "client": { "name": "my-agent", "kind": "agent", "scope": "read_write" },
  "bearer": "my-agent.E7pK2..."
}
\`\`\`

Treat \`bearer\` like a password.

### 2. Wire the client into your MCP client

#### Claude Code (\`.mcp.json\` in project root, or \`~/.claude.json\`)

\`\`\`json
{
  "mcpServers": {
    "worktracker": {
      "type": "http",
      "url": "https://worktracker-nyx.web.app/mcp",
      "headers": {
        "Authorization": "Bearer my-agent.E7pK2..."
      }
    }
  }
}
\`\`\`

#### Codex CLI (\`~/.codex/config.toml\`)

\`\`\`toml
[mcp_servers.worktracker]
url = "https://worktracker-nyx.web.app/mcp"
bearer_token = "my-agent.E7pK2..."
\`\`\`

#### Hermes / generic HTTP MCP client

Point at the URL above with \`Authorization: Bearer <client>.<key>\`.

### 3. First call

\`\`\`bash
curl -X POST https://worktracker-nyx.web.app/mcp \\
  -H "Authorization: Bearer my-agent.E7pK2..." \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2024-11-05","capabilities":{},
                 "clientInfo":{"name":"docs","version":"1"}}}'
\`\`\`

Response:

\`\`\`json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "serverInfo": { "name": "worktracker", "version": "1.0.0" },
    "capabilities": { "tools": {} }
  }
}
\`\`\`

Then list the tools and call one:

\`\`\`json
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
\`\`\`

\`\`\`json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
  "name":"worktracker.items.list",
  "arguments":{"limit":10}
}}
\`\`\`

---

## Auth model

Three paths through \`requireSource\`:

1. **Admin token.** \`WORKTRACKER_ADMIN_TOKEN\`. Sets
   \`req.auth = { kind: 'admin' }\`. Bypasses the clients collection.
2. **Firebase Auth ID token** (three dot-separated base64
   segments). Verifies the signature via
   \`getAuth().verifyIdToken\`. A user with \`is_admin: true\` is
   admin-equivalent; everyone else is \`read\`.
3. **Client bearer.** \`<client-name>.<key>\` (scrypt-hashed) for
   agent clients, or \`wt_<bearer_id>\` for personal access tokens.
   Each carries its own \`scope\` (\`read\` / \`read_write\` / \`admin\`).

A client with \`enabled: false\` returns \`403\`.

The 23 tools are split by scope:

- **read (7):** \`items.list\`, \`items.get\`, \`boards.list\`,
  \`boards.get\`, \`files.list\`, \`files.get\`, \`clients.introspect\`
- **read_write (9):** \`items.create\`, \`items.update\` (also folds
  transition + archive), \`items.comment\`, \`items.link\`,
  \`items.unlink\`, \`files.upload\`, \`dispatch.run\`, \`enrich.run\`
- **admin (7):** \`boards.create\`, \`boards.update\`,
  \`boards.delete\`, \`clients.list\`, \`clients.mint\`,
  \`clients.rotate\`, \`connectors.list\`, \`connectors.get\`

\`tools/list\` filters the catalog by the bearer's effective scope
so a caller only sees tools they can run. \`tools/call\` re-checks
as defense in depth; an out-of-scope call returns \`-32603\` with a
clear debuggable message.

---

## Tools (23)

### items (7)

| Tool | Scope | Purpose |
| --- | --- | --- |
| \`worktracker.items.list\`        | read | List with kind/status/source/board/owner/q/limit/include_archived filters |
| \`worktracker.items.get\`         | read | One item + events + files |
| \`worktracker.items.create\`      | read_write | Create (data, data_map, plan_file_id, analysis, files[], board_id=null for backlog) |
| \`worktracker.items.update\`      | read_write | Patch fields with \`expected_version\`; status field is routed through the state machine, archived_at through archive |
| \`worktracker.items.comment\`     | read_write | Append a comment event |
| \`worktracker.items.link\`        | read_write | Create a typed relationship (depends_on, blocks, related, mirrors, parent_of) |
| \`worktracker.items.unlink\`      | read_write | Remove a link by (parent_id, child_id, kind) |

### boards (5)

| Tool | Scope | Purpose |
| --- | --- | --- |
| \`worktracker.boards.list\`       | read | All boards, ordered by name |
| \`worktracker.boards.get\`        | read | One board by id |
| \`worktracker.boards.create\`     | admin | Create; \`is_default: true\` unsets the previous default in the same batch |
| \`worktracker.boards.update\`     | admin | Patch fields; re-assigning default unsets the previous |
| \`worktracker.boards.delete\`     | admin | Delete by id; default board returns \`cannot_delete_default\` |

### files (3)

| Tool | Scope | Purpose |
| --- | --- | --- |
| \`worktracker.files.list\`        | read | List files for an item (metadata) |
| \`worktracker.files.get\`         | read | Download a file by id (metadata; bytes served by \`GET /api/files/:id\`) |
| \`worktracker.files.upload\`      | read_write | Attach a base64 file to an item; 1 MB per file, 10 MB per item |

### clients (4)

| Tool | Scope | Purpose |
| --- | --- | --- |
| \`worktracker.clients.list\`      | admin | All clients with scope + last_seen + last_used_at |
| \`worktracker.clients.mint\`      | admin | Create a new \`kind: user\` client; returns the bearer once |
| \`worktracker.clients.rotate\`    | admin | Rotate a client's bearer; old bearer invalidated immediately |
| \`worktracker.clients.introspect\`| read | "Who am I" — returns \`{ name, kind, scope, owner_uid, last_used_at, capabilities, server_version, visible_tools }\` |

### connectors (2)

| Tool | Scope | Purpose |
| --- | --- | --- |
| \`worktracker.connectors.list\`   | admin | All connectors with kind, protocol, last_run, last_status |
| \`worktracker.connectors.get\`    | admin | One connector with config and run history |

### dispatch + enrich (2)

| Tool | Scope | Purpose |
| --- | --- | --- |
| \`worktracker.dispatch.run\`      | read_write | Pre-flight + missing enrichment + transition. Extended: can move backlog → board (item_id + board_id + to_status) |
| \`worktracker.enrich.run\`        | read_write | Standalone Grill / Wayfind run |

---

## Errors

JSON-RPC error envelope:

\`\`\`json
{ "jsonrpc": "2.0", "id": <echoed>, "error": { "code": -32601, "message": "..." } }
\`\`\`

| Code | Meaning | Cause |
| --- | --- | --- |
| \`-32600\` | Invalid Request   | \`jsonrpc\` ≠ \`"2.0"\` or envelope malformed |
| \`-32601\` | Method not found  | Unknown \`method\` or \`tools/call\` name |
| \`-32602\` | Invalid params    | Zod schema rejects the args; \`data\` carries the field path |
| \`-32603\` | Internal error    | Unexpected throw, or admin-only tool called by a non-admin source |

HTTP transport errors (returned before the body is parsed):

| Status | Meaning | Cause |
| --- | --- | --- |
| \`401\` | Unauthorized      | Missing bearer, or bearer doesn't match any client / admin token |
| \`403\` | Forbidden         | Client exists but \`enabled: false\` |
| \`404\` | Not found         | Path is not \`/mcp\` on the Cloud Run service |
| \`405\` | Method not allowed | \`GET /mcp\` — POST a JSON-RPC envelope instead |

---

## Endpoint aliasing

The server mounts the JSON-RPC handler at both \`/mcp\` and \`/api/mcp\`.
The internal REST API lives at \`/api/**\`. Firebase Hosting's
\`run\` rewrite forwards the literal path to Cloud Run, so both routes
resolve to the same handler with the same auth.

This page (\`/mcp.md\`) is served on \`GET\` and does not conflict with
\`POST /mcp\`.

---

## Source of truth

- **This page:** https://worktracker-nyx.web.app/mcp.md
- **README:** https://github.com/coding-nyx/worktracker (MCP section)
- **Source code:** \`apps/api/src/mcp.ts\`, \`apps/api/src/mcp-tools.ts\`, \`apps/api/src/auth.ts\`
- **Deploy:** Cloud Run \`worktracker-api\` (us-central1), Firebase Hosting
  \`worktracker-nyx\`

Generated from master. Edit \`MCP_DOC\` in \`apps/api/src/mcp.ts\` and
redeploy to update this page.
`;

// ----- Router -----

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  // MCP routes are registered at BOTH `/api/mcp` (so internal
  // callers behind the `/api/**` Firebase Hosting rewrite hit
  // the real handler) and `/mcp` (so external clients using the
  // conventional MCP path also work — the Firebase Hosting
  // rewrite `source: "/mcp"` forwards the literal path to Cloud
  // Run, so the API itself has to expose `/mcp` directly).

  // SSE endpoint for clients to receive server-pushed events.
  // For v0 the MCP surface is request/response only; SSE is here
  // so the contract is ready when we add it.
  const getHandler = async (
    _req: FastifyRequest,
    reply: import('fastify').FastifyReply,
  ) => {
    reply.code(405).send({ error: 'GET /mcp not supported; POST JSON-RPC to /mcp' });
  };
  app.get('/api/mcp', { preHandler: requireSource }, getHandler);
  app.get('/mcp', { preHandler: requireSource }, getHandler);

  // Public Markdown on-ramp. No auth — this is the page an LLM
  // agent reads to learn how to connect. A new Firebase Hosting
  // rewrite (`/mcp.md` → Cloud Run) routes GET requests here; the
  // POST JSON-RPC handler below still owns the same prefix.
  app.get('/mcp.md', async (_req, reply) => {
    reply.type('text/markdown; charset=utf-8');
    reply.send(MCP_DOC);
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

  // Mirror the POST handler at `/mcp` for the same reason as the
  // GET handler above. The handler body is identical; Fastify
  // re-runs the preHandler so `requireSource` enforces auth at
  // either entry point.
  app.post('/mcp', { preHandler: requireSource }, async (req, reply) => {
    const body = req.body as JsonRpcRequest | JsonRpcRequest[];
    const requests = Array.isArray(body) ? body : [body];
    const responses = await Promise.all(requests.map((r) => handleRpc(r, req)));
    const payload = Array.isArray(body) ? responses : responses[0];
    reply.send(payload);
  });

  // -------------------------------------------------------------------
  // Streamable HTTP — slice 1, the spec-aligned transport.
  //
  // The 2026-07-28 MCP spec promotes "Streamable HTTP" as the
  // standard HTTP transport. The contract: same JSON-RPC 2.0
  // envelope over POST, plus a session id header the client can
  // echo on subsequent requests. v1 here does NOT yet push
  // server-initiated events over SSE; the response is still
  // a single JSON payload per call. The `Mcp-Session-Id` is
  // generated on every request for compatibility with clients
  // that expect it (Codex, OpenClaw).
  // -------------------------------------------------------------------
  app.get('/mcp/stream', { preHandler: requireSource }, (_req, reply) => {
    reply.code(405).send({ error: 'GET /mcp/stream not supported; POST JSON-RPC to /mcp/stream' });
  });
  app.post('/mcp/stream', { preHandler: requireSource }, async (req, reply) => {
    const body = req.body as JsonRpcRequest | JsonRpcRequest[];
    const requests = Array.isArray(body) ? body : [body];
    const responses = await Promise.all(requests.map((r) => handleRpc(r, req)));
    const payload = Array.isArray(body) ? responses : responses[0];
    // 32 hex chars = 128 bits. Enough for a session marker; not a
    // secret (the bearer is the real auth). Future slice 1.x adds
    // session resumption — for now it's a per-request token.
    const sessionId = randomBytes(16).toString('hex');
    reply.header('Mcp-Session-Id', sessionId);
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
            serverInfo: { name: 'worktracker', version: '1.0.0' },
            capabilities: { tools: {} },
          },
        };
      case 'notifications/initialized':
        return { jsonrpc: '2.0', id: req.id, result: {} };
      case 'tools/list': {
        // Filter the registry by the bearer's effective scope.
        return { jsonrpc: '2.0', id: req.id, result: { tools: listToolsForRequest(httpReq) } };
      }
      case 'tools/call': {
        const params = (req.params ?? {}) as { name: string; arguments?: unknown };
        const result = await dispatchTool(params.name, params.arguments, httpReq);
        if (result.ok) {
          return { jsonrpc: '2.0', id: req.id, result: result.value };
        }
        return rpcError(req, result.code ?? -32603, result.error ?? 'internal error', result.data);
      }
      default:
        return rpcError(req, -32601, `unknown method: ${req.method}`);
    }
  } catch (err) {
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
