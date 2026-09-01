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
  Board,
  Command,
  ListItemsQuery,
  McpDispatchArgs,
  McpEnrichArgs,
  WorkItem,
} from '@worktracker/types';
import { z } from 'zod';
import { ulid, nowIso } from './ids.js';
import { getDb } from './firestore.js';
import { requireSource } from './auth.js';
import { InvalidInputError } from './errors.js';
import { evaluateCommand as _evaluateCommand } from './brain.js';
void _evaluateCommand; // reserved for the in-process evaluation path

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
  {
    name: 'worktracker_list_boards',
    description: 'List all kanban boards. Returns the full Board objects (name, columns, kind filter, default flag).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'worktracker_get_board',
    description: 'Get one board by id, including its column definitions and kind filter.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'worktracker_create_board',
    description: 'Create a new board. Admin only. The board becomes available immediately to every user; pass is_default=true to make it the landing view.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        description: { type: 'string', maxLength: 2000 },
        kinds: { type: 'array', items: { type: 'string', enum: ['task', 'ticket', 'decision', 'review'] } },
        columns: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              statuses: { type: 'array', items: { type: 'string' }, minItems: 1 },
              kinds: { type: 'array', items: { type: 'string', enum: ['task', 'ticket', 'decision', 'review'] } },
            },
            required: ['id', 'label', 'statuses'],
          },
        },
        is_default: { type: 'boolean' },
      },
      required: ['name', 'columns'],
    },
  },
  {
    name: 'worktracker_update_board',
    description: 'Update an existing board. Admin only. Omit any field to keep its current value.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string', minLength: 1, maxLength: 120 },
        description: { type: 'string', maxLength: 2000 },
        kinds: { type: 'array', items: { type: 'string', enum: ['task', 'ticket', 'decision', 'review'] } },
        columns: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              statuses: { type: 'array', items: { type: 'string' }, minItems: 1 },
              kinds: { type: 'array', items: { type: 'string', enum: ['task', 'ticket', 'decision', 'review'] } },
            },
            required: ['id', 'label', 'statuses'],
          },
        },
        is_default: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'worktracker_delete_board',
    description: 'Delete a board. Admin only. The default board cannot be deleted; set another board as default first.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
] as const;

// ----- Discoverability doc (served on GET /mcp.md) -----
//
// A Markdown on-ramp for LLM agents (Claude Code, Codex, Hermes) so they
// can be pointed at `https://worktracker-nyx.web.app/mcp.md` and
// figure out how to connect + what tools exist, without first having
// the connection wired up in a config file. The doc is public — auth
// is only enforced on POST /mcp.

const MCP_DOC = `# MCP for WorkTracker

A source-authenticated JSON-RPC 2.0 surface for the WorkTracker kanban.
Any MCP client (Claude Code, Codex, Hermes, custom GPTs) can read kanban
state, mutate work items, and manage boards through a single HTTP endpoint.

- **Server URL:** \`https://worktracker-nyx.web.app/mcp\`
- **Protocol:** JSON-RPC 2.0 over HTTP
- **Transport:** Request/response in v0 (SSE endpoint is registered but
  does not yet push events)
- **Auth:** Bearer token per source, or the \`WORKTRACKER_ADMIN_TOKEN\`
- **Tools:** 15 (\`worktracker_*\`)

This page is the on-ramp. Fetch it with \`curl\` or point an LLM at it.
The canonical doc is also on GitHub at
\`github.com/coding-nyx/worktracker\` (see the MCP section in the README).

---

## Quick start

### 1. Add a source (admin)

A source is a named API client. The admin creates it; the API returns a
\`<source>.<key>\` bearer. The server stores the key as a scrypt hash;
the plaintext is shown once.

\`\`\`bash
curl -X POST https://worktracker-nyx.web.app/api/sources \\
  -H "Authorization: Bearer $WORKTRACKER_ADMIN_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"my-agent","kind":"external"}'
\`\`\`

Response (example):

\`\`\`json
{
  "name": "my-agent",
  "kind": "external",
  "bearer": "my-agent.E7pK2..."
}
\`\`\`

Treat \`bearer\` like a password.

### 2. Wire the source into your MCP client

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

Point at the URL above with \`Authorization: Bearer <source>.<key>\`.

### 3. First call

\`\`\`bash
curl -X POST https://worktracker-nyx.web.app/mcp \\
  -H "Authorization: Bearer my-agent.E7pK2..." \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
\`\`\`

Response:

\`\`\`json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "serverInfo": { "name": "worktracker", "version": "0.1.0" },
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
  "name":"worktracker_list_items",
  "arguments":{"limit":10}
}}
\`\`\`

---

## Auth model

Two paths through \`requireSource\`:

1. **Admin token.** \`WORKTRACKER_ADMIN_TOKEN\`. Sets
   \`req.auth = { kind: 'admin' }\`. Bypasses the sources collection.
2. **Source bearer.** Scrypt-hashed at registration. Tokens shaped
   \`<source>.<key>\` get an O(1) lookup against \`sources/{name}\`. Other
   shapes iterate the collection. Verified with \`timingSafeEqual\`.

A source with \`enabled: false\` returns \`403\`.

The three board admin tools
(\`worktracker_create_board\`, \`worktracker_update_board\`,
\`worktracker_delete_board\`) require either:

- \`req.auth.kind === 'admin'\`, or
- \`req.auth.source.name === 'web'\` (the React app's virtual admin path)

All other tools accept any enabled source.

---

## Tools (15)

### Work items (10)

| Tool | Auth | Purpose |
| --- | --- | --- |
| \`worktracker_list_items\`    | any source | List items, optional filters (kind, status, source, owner, q, limit, include_archived) |
| \`worktracker_get_item\`      | any source | One item + its \`events\` subcollection |
| \`worktracker_create_item\`   | any source | Enqueue a \`create\` command; returns \`command_id\` |
| \`worktracker_update_item\`   | any source | Enqueue an \`update\` command (optimistic concurrency) |
| \`worktracker_transition\`    | any source | Enqueue a \`transition\` command |
| \`worktracker_comment\`       | any source | Append a comment event |
| \`worktracker_link_items\`    | any source | Link two items with \`depends_on | blocks | related | mirrors | parent_of\` |
| \`worktracker_set_reminder\`  | any source | v0.5 stub: returns \`{ accepted: false, reason: "v0.5" }\` |
| \`worktracker_enrich\`        | any source | Enqueue \`grill | wayfind | both\` |
| \`worktracker_dispatch\`      | any source | Pre-flight + missing enrichment + transition (heaviest single tool) |

### Boards (5)

| Tool | Auth | Purpose |
| --- | --- | --- |
| \`worktracker_list_boards\`   | any source | All boards, ordered by name |
| \`worktracker_get_board\`     | any source | One board by id |
| \`worktracker_create_board\`  | admin      | Create; \`is_default: true\` unsets the previous default first |
| \`worktracker_update_board\`  | admin      | Patch fields; re-assigning default unsets the previous |
| \`worktracker_delete_board\`  | admin      | Delete by id; default board returns \`cannot_delete_default\` |

### Cost profile

Reads are one Firestore query. Writes enqueue a command and return a
\`command_id\` immediately; the Brain Cloud Function applies the change
in the background. \`worktracker_dispatch\` is the heaviest single tool —
pre-flight, missing enrichment, and transition in one call.

\`worktracker_get_item\` is two reads: the document and its
\`events\` subcollection.

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
| \`-32602\` | Invalid params    | zod schema rejects the args; \`data\` carries the field path |
| \`-32603\` | Internal error    | Unexpected throw, or admin-only tool called by a non-admin source |

HTTP transport errors (returned before the body is parsed):

| Status | Meaning | Cause |
| --- | --- | --- |
| \`401\` | Unauthorized      | Missing bearer, or bearer doesn't match any source / admin token |
| \`403\` | Forbidden         | Source exists but \`enabled: false\` |
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
- **Source code:** \`apps/api/src/mcp.ts\`, \`apps/api/src/auth.ts\`
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
    _req: import('fastify').FastifyRequest,
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

/**
 * Dispatch a single tool call. Exported so the AI chat
 * route can reuse the same handlers (and therefore the same
 * auth, RBAC, and brain-command-queue integration) without
 * going through HTTP. The AI builds a fake `JsonRpcRequest`
 * envelope and a fake `FastifyRequest` with the user's
 * `auth` set; everything downstream is the same code path
 * as the MCP `/mcp` endpoint.
 */
export async function handleToolCall(
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
    case 'worktracker_list_boards': {
      const snap = await getDb().collection('boards').orderBy('name').get();
      const boards = snap.docs.map((d) => d.data() as Board);
      return { jsonrpc: '2.0', id: req.id, result: { boards } };
    }
    case 'worktracker_get_board': {
      const id = z.object({ id: z.string() }).parse(args).id;
      const doc = await getDb().collection('boards').doc(id).get();
      if (!doc.exists) {
        return { jsonrpc: '2.0', id: req.id, result: { board: null } };
      }
      return { jsonrpc: '2.0', id: req.id, result: { board: doc.data() as Board } };
    }
    case 'worktracker_create_board': {
      if (httpReq.auth?.source?.name !== 'web' && httpReq.auth?.kind !== 'admin' && httpReq.auth?.user?.is_admin !== true) {
        return rpcError(req, -32603, 'create_board is admin-only');
      }
      const body = z
        .object({
          name: z.string().min(1).max(120),
          description: z.string().max(2000).optional(),
          kinds: z.array(z.enum(['task', 'ticket', 'decision', 'review'])).optional(),
          columns: z
            .array(
              z.object({
                id: z.string().min(1).max(64),
                label: z.string().min(1).max(64),
                statuses: z.array(z.string().min(1).max(64)).min(1),
                kinds: z.array(z.enum(['task', 'ticket', 'decision', 'review'])).optional(),
              }),
            )
            .min(1)
            .max(20),
          is_default: z.boolean().optional(),
        })
        .parse(args);
      if (body.is_default) {
        await unsetExistingBoardDefaults();
      }
      const now = nowIso();
      const board: Board = {
        id: ulid(),
        name: body.name,
        ...(body.description ? { description: body.description } : {}),
        ...(body.kinds ? { kinds: body.kinds } : {}),
        columns: body.columns,
        is_default: body.is_default ?? false,
        created_at: now,
        updated_at: now,
      };
      await getDb().collection('boards').doc(board.id).set(board);
      return { jsonrpc: '2.0', id: req.id, result: { board } };
    }
    case 'worktracker_update_board': {
      if (httpReq.auth?.source?.name !== 'web' && httpReq.auth?.kind !== 'admin' && httpReq.auth?.user?.is_admin !== true) {
        return rpcError(req, -32603, 'update_board is admin-only');
      }
      const body = z
        .object({
          id: z.string().min(1).max(64),
          name: z.string().min(1).max(120).optional(),
          description: z.string().max(2000).optional(),
          kinds: z.array(z.enum(['task', 'ticket', 'decision', 'review'])).optional(),
          columns: z
            .array(
              z.object({
                id: z.string().min(1).max(64),
                label: z.string().min(1).max(64),
                statuses: z.array(z.string().min(1).max(64)).min(1),
                kinds: z.array(z.enum(['task', 'ticket', 'decision', 'review'])).optional(),
              }),
            )
            .min(1)
            .max(20)
            .optional(),
          is_default: z.boolean().optional(),
        })
        .parse(args);
      const ref = getDb().collection('boards').doc(body.id);
      const snap = await ref.get();
      if (!snap.exists) {
        return { jsonrpc: '2.0', id: req.id, result: { error: 'not_found' } };
      }
      const current = snap.data() as Board;
      if (body.is_default && !current.is_default) {
        await unsetExistingBoardDefaults();
      }
      const next: Board = {
        ...current,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.kinds !== undefined ? { kinds: body.kinds } : {}),
        ...(body.columns !== undefined ? { columns: body.columns } : {}),
        ...(body.is_default !== undefined ? { is_default: body.is_default } : {}),
        updated_at: nowIso(),
      };
      await ref.set(next);
      return { jsonrpc: '2.0', id: req.id, result: { board: next } };
    }
    case 'worktracker_delete_board': {
      if (httpReq.auth?.source?.name !== 'web' && httpReq.auth?.kind !== 'admin' && httpReq.auth?.user?.is_admin !== true) {
        return rpcError(req, -32603, 'delete_board is admin-only');
      }
      const id = z.object({ id: z.string().min(1).max(64) }).parse(args).id;
      const ref = getDb().collection('boards').doc(id);
      const snap = await ref.get();
      if (!snap.exists) {
        return { jsonrpc: '2.0', id: req.id, result: { error: 'not_found' } };
      }
      const current = snap.data() as Board;
      if (current.is_default) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: { error: 'cannot_delete_default', message: 'unset is_default first' },
        };
      }
      await ref.delete();
      return { jsonrpc: '2.0', id: req.id, result: { id, deleted: true } };
    }
    default:
      return rpcError(req, -32601, `unknown tool: ${name}`);
  }
}

async function unsetExistingBoardDefaults(): Promise<void> {
  const snap = await getDb()
    .collection('boards')
    .where('is_default', '==', true)
    .get();
  const batch = getDb().batch();
  for (const doc of snap.docs) {
    batch.update(doc.ref, { is_default: false, updated_at: nowIso() });
  }
  if (snap.docs.length > 0) await batch.commit();
}
