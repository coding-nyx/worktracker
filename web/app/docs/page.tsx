'use client';

import { useEffect, useState } from 'react';

/**
 * /docs — MCP API reference.
 *
 * The single source of truth for an external client integrating
 * with WorkTracker. The README in the monorepo root mirrors
 * the same content; this is the in-app reference.
 *
 * Sections:
 *   - overview     what the MCP integration is
 *   - endpoint     where to send requests
 *   - auth         the bearer token model
 *   - initialize   the JSON-RPC 2.0 handshake
 *   - discovery    tools/list
 *   - items        7 work-item tools
 *   - boards       5 board tools
 *   - files        3 file tools
 *   - clients      4 client tools (introspect is read, the rest admin)
 *   - connectors   2 admin tools
 *   - dispatch     1 high-level tool
 *   - enrich       1 standalone enrichment tool
 *   - example      end-to-end with curl
 *   - setup        Claude Desktop, Cursor, custom
 *   - errors       JSON-RPC codes + HTTP status
 */
export default function DocsPage() {
  const [active, setActive] = useState<string>('overview');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const ids = ['overview', 'endpoint', 'auth', 'initialize', 'discovery', 'items', 'boards', 'example', 'clients', 'errors'];
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive(e.target.id);
        }
      },
      { rootMargin: '-30% 0px -55% 0px', threshold: 0 },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      {/* === Left rail === */}
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <div className="space-y-1.5">
          <span className="eyebrow">// mcp · v0.1</span>
          <p className="font-mono text-[10.5px] uppercase tracking-mono-wide text-ink-3">
            json-rpc 2.0 · 23 tools
          </p>
        </div>
        <nav className="mt-5 space-y-px" aria-label="Documentation sections">
          {[
            { id: 'overview',    label: 'Overview' },
            { id: 'endpoint',    label: 'Endpoint' },
            { id: 'auth',        label: 'Auth' },
            { id: 'initialize',  label: 'Initialize' },
            { id: 'discovery',   label: 'Discovery' },
            { id: 'items',       label: 'Items (7)' },
            { id: 'boards',      label: 'Boards (5)' },
            { id: 'files',       label: 'Files (3)' },
            { id: 'clients',     label: 'Clients (4)' },
            { id: 'connectors',  label: 'Connectors (2)' },
            { id: 'dispatch',    label: 'Dispatch + Enrich' },
            { id: 'example',     label: 'Example' },
            { id: 'errors',      label: 'Errors' },
          ].map((s) => {
            const isActive = active === s.id;
            return (
              <a
                key={s.id}
                href={`#${s.id}`}
                className={`focus-ring block rounded-sm px-3 py-1.5 font-mono text-[11.5px] uppercase tracking-mono-wide transition-colors ${
                  isActive
                    ? 'border-l-2 border-brand-500 bg-brand-500/10 text-brand-500'
                    : 'border-l-2 border-transparent text-ink-3 hover:bg-bg-raised hover:text-ink-1'
                }`}
              >
                {s.label}
              </a>
            );
          })}
        </nav>
        <p className="mt-6 font-mono text-[10.5px] uppercase tracking-mono-wide text-ink-3">
          // base url
        </p>
        <p className="mt-1 break-all font-mono text-[10.5px] text-ink-2">
          worktracker-nyx.web.app
        </p>
      </aside>

      {/* === Right content === */}
      <article className="space-y-6">
        <header className="space-y-2">
          <span className="eyebrow">// mcp · 2024-11-05</span>
          <h1 className="text-[28px] font-semibold tracking-tight text-ink-1" style={{ letterSpacing: '-0.015em' }}>
            WorkTracker MCP reference
          </h1>
          <p className="max-w-2xl text-[14px] leading-6 text-ink-2">
            The Model Context Protocol integration for WorkTracker. JSON-RPC 2.0 over HTTP POST — the same brain the web UI uses, exposed as 23 dotted-namespace tools (read: 7, read_write: 9, admin: 7) that any MCP client can call.
          </p>
        </header>

        {/* === Overview === */}
        <Section id="overview" eyebrow="// overview" title="What this is">
          <p className="text-[14px] leading-6 text-ink-2">
            The MCP server lives at <code className="rounded-sm bg-bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-1">POST /mcp</code> on the same Fastify process as the REST API. The auth model is identical: a bearer token in the <code className="rounded-sm bg-bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-1">Authorization</code> header. The same work-items and boards collections back every call.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {[
              { k: 'transport', v: 'http · json-rpc 2.0' },
              { k: 'protocol',  v: '2024-11-05' },
              { k: 'tools',     v: '23 (7 read · 9 rw · 7 admin)' },
            ].map((s) => (
              <div key={s.k} className="card-inset px-3 py-2.5">
                <p className="font-mono text-[10px] uppercase tracking-mono-widest text-brand-500">{s.k}</p>
                <p className="mt-1 text-[12.5px] text-ink-2">{s.v}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* === Endpoint === */}
        <Section id="endpoint" eyebrow="// endpoint" title="Where to send requests">
          <p className="text-[14px] leading-6 text-ink-2">
            Two paths hit the same handler. Use <code className="rounded-sm bg-bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-1">/mcp</code> for spec-conformant clients, <code className="rounded-sm bg-bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-1">/api/mcp</code> when you go through the <code className="rounded-sm bg-bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-1">/api/**</code> rewrite.
          </p>
          <CodeBlock
            language="http"
            code={`POST https://worktracker-nyx.web.app/mcp
Content-Type: application/json
Accept: application/json, text/event-stream
Authorization: Bearer <token>`}
          />
          <h3 className="mt-6 font-mono text-[10.5px] font-medium uppercase tracking-mono-widest text-ink-3">
            content negotiation
          </h3>
          <p className="mt-2 text-[13px] text-ink-2">
            <code className="rounded-sm bg-bg-sunken px-1 py-0.5 font-mono text-[11.5px] text-ink-1">tools/list</code> returns <code className="rounded-sm bg-bg-sunken px-1 py-0.5 font-mono text-[11.5px] text-ink-1">application/json</code>; <code className="rounded-sm bg-bg-sunken px-1 py-0.5 font-mono text-[11.5px] text-ink-1">tools/call</code> returns <code className="rounded-sm bg-bg-sunken px-1 py-0.5 font-mono text-[11.5px] text-ink-1">text/event-stream</code> so a future SSE transport drops in without a client change.
          </p>
        </Section>

        {/* === Auth === */}
        <Section id="auth" eyebrow="// auth" title="Bearer token">
          <p className="text-[14px] leading-6 text-ink-2">
            Every request needs a bearer token. The same <code className="rounded-sm bg-bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-1">requireSource</code> preHandler that guards the REST API guards MCP — there's no separate admin gate at the transport layer.
          </p>
          <p className="mt-3 text-[13.5px] leading-6 text-ink-2">
            Three token shapes resolve to the same auth context:
          </p>
          <div className="mt-4 space-y-2">
            <Auth kind="admin"  label="WORKTRACKER_ADMIN_TOKEN"     body="Operator token. Read + write everything. Set in the API service env; not exposed in the UI." />
            <Auth kind="source" label="<name>.<key>  (agent client)" body="System integration: Hermes, Claude Code, Codex, Cline, OpenClaw. The server hashes the key with scrypt; the doc lives at sources/{name}." />
            <Auth kind="source" label="wt_<bearer_id>  (user client)" body="Personal access token minted from the Settings page. The bearer_id IS the credential (256 bits of entropy); no hash is stored. Doc lives at sources/{bearer_id}." />
          </div>
          <p className="mt-4 text-[13.5px] leading-6 text-ink-2">
            Each client carries a <code className="rounded-sm bg-bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-1">scope</code> field: <code className="rounded-sm bg-bg-sunken px-1 py-0.5 font-mono text-[11.5px] text-ink-1">read</code>, <code className="rounded-sm bg-bg-sunken px-1 py-0.5 font-mono text-[11.5px] text-ink-1">read_write</code>, or <code className="rounded-sm bg-bg-sunken px-1 py-0.5 font-mono text-[11.5px] text-ink-1">admin</code>. <code className="rounded-sm bg-bg-sunken px-1 py-0.5 font-mono text-[11.5px] text-ink-1">tools/list</code> is filtered by the caller's scope; <code className="rounded-sm bg-bg-sunken px-1 py-0.5 font-mono text-[11.5px] text-ink-1">tools/call</code> on an out-of-scope tool returns <code className="rounded-sm bg-bg-sunken px-1 py-0.5 font-mono text-[11.5px] text-ink-1">-32603</code> with a debug message. Introspect with <code className="rounded-sm bg-bg-sunken px-1 py-0.5 font-mono text-[11.5px] text-ink-1">GET /api/clients/introspect</code> to see what your current bearer can do.
          </p>
          <CodeBlock
            language="bash"
            code={`# Admin (operator token)
curl -H "Authorization: Bearer $WORKTRACKER_ADMIN_TOKEN" ...

# Agent client (Hermes / Claude Code / Codex / …)
curl -H "Authorization: Bearer $HERMES_BEARER" ...

# User client (personal access token)
curl -H "Authorization: Bearer $WT_TOKEN" ...`}
          />
        </Section>

        {/* === Initialize === */}
        <Section id="initialize" eyebrow="// initialize" title="The handshake">
          <p className="text-[14px] leading-6 text-ink-2">
            Every MCP session starts with an <code className="rounded-sm bg-bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-1">initialize</code> call. The response advertises the protocol version, server identity, and capabilities.
          </p>
          <CodeBlock
            language="json"
            code={`// request
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": { "name": "my-agent", "version": "1.0.0" }
  }
}

// response
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "serverInfo":   { "name": "worktracker", "version": "0.1.0" },
    "capabilities": { "tools": {} }
  }
}`}
          />
        </Section>

        {/* === Discovery === */}
        <Section id="discovery" eyebrow="// discovery" title="tools/list">
          <p className="text-[14px] leading-6 text-ink-2">
            One call returns the full tool catalog with JSON-Schema for each tool's arguments. Cache the result on the client; the server is free to add tools between releases.
          </p>
          <CodeBlock
            language="json"
            code={`// request
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }

// response — abbreviated
{
  "jsonrpc": "2.0", "id": 2,
  "result": {
    "tools": [
      { "name": "worktracker.items.list",   "description": "…", "inputSchema": { … } },
      { "name": "worktracker.items.create", "description": "…", "inputSchema": { … } },
      { "name": "worktracker.items.update", "description": "…", "inputSchema": { … } },
      // … 20 more, namespaced across 7 namespaces
    ]
  }
}`}
          />
        </Section>

        {/* === Items === */}
        <Section id="items" eyebrow="// items · 7 tools" title="Work items">
          <p className="text-[14px] leading-6 text-ink-2">
            <code className="rounded-sm bg-bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-1">worktracker.items.update</code> is the single mutation path: setting <code className="rounded-sm bg-bg-sunken px-1 py-0.5 font-mono text-[11.5px] text-ink-1">status</code> in the patch is folded into a transition (the state machine gates it); setting <code className="rounded-sm bg-bg-sunken px-1 py-0.5 font-mono text-[11.5px] text-ink-1">archived_at</code> is folded into archive. <code className="rounded-sm bg-bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-1">expected_version</code> on every mutation is the optimistic-concurrency token.
          </p>
          <div className="mt-4 space-y-3">
            {ITEM_TOOLS.map((t) => (
              <ToolCard key={t.name} {...t} />
            ))}
          </div>
        </Section>

        {/* === Boards === */}
        <Section id="boards" eyebrow="// boards · 5 tools" title="Boards">
          <p className="text-[14px] leading-6 text-ink-2">
            Boards are saved views — a list of columns (label + status mapping) and an optional kind filter. Reads are open; writes require the admin scope.
          </p>
          <div className="mt-4 space-y-3">
            {BOARD_TOOLS.map((t) => (
              <ToolCard key={t.name} {...t} />
            ))}
          </div>
        </Section>

        {/* === Files === */}
        <Section id="files" eyebrow="// files · 3 tools" title="Files">
          <p className="text-[14px] leading-6 text-ink-2">
            Attachments live in <code className="rounded-sm bg-bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-1">files/{`{file_id}`}</code> as inline base64. 1 MB per file, 10 MB per item. <code className="rounded-sm bg-bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-1">worktracker.files.get</code> returns metadata only — the actual bytes are served by the REST <code className="rounded-sm bg-bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-1">GET /api/files/{`:id`}</code> endpoint, because the MCP JSON-RPC envelope is JSON and can&apos;t carry binary cleanly.
          </p>
          <div className="mt-4 space-y-3">
            {FILE_TOOLS.map((t) => (
              <ToolCard key={t.name} {...t} />
            ))}
          </div>
        </Section>

        {/* === Clients === */}
        <Section id="clients" eyebrow="// clients · 4 tools" title="Clients">
          <p className="text-[14px] leading-6 text-ink-2">
            <code className="rounded-sm bg-bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-1">worktracker.clients.introspect</code> is read-scope; the other three are admin-only. The introspect response includes <code className="rounded-sm bg-bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-1">visible_tools</code> so a client can render its own palette without making a separate <code className="rounded-sm bg-bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-1">tools/list</code> call.
          </p>
          <div className="mt-4 space-y-3">
            {CLIENT_TOOLS.map((t) => (
              <ToolCard key={t.name} {...t} />
            ))}
          </div>
        </Section>

        {/* === Connectors === */}
        <Section id="connectors" eyebrow="// connectors · 2 tools" title="Connectors">
          <p className="text-[14px] leading-6 text-ink-2">
            Admin-only. Connectors are outbound integrations the API talks to (mirror, webhook-in, webhook-out, bridge). The actual <code className="rounded-sm bg-bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-1">protocol</code> impls are wired in slice 5+.
          </p>
          <div className="mt-4 space-y-3">
            {CONNECTOR_TOOLS.map((t) => (
              <ToolCard key={t.name} {...t} />
            ))}
          </div>
        </Section>

        {/* === Dispatch + Enrich === */}
        <Section id="dispatch" eyebrow="// dispatch + enrich" title="Dispatch and enrich">
          <p className="text-[14px] leading-6 text-ink-2">
            <code className="rounded-sm bg-bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-1">worktracker.dispatch.run</code> is the highest-level tool: it enqueues the right sequence of commands (board move, status transition, enrichment) in one call. <code className="rounded-sm bg-bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-1">worktracker.enrich.run</code> is a standalone Grill/Wayfind kick-off.
          </p>
          <div className="mt-4 space-y-3">
            {DISPATCH_TOOLS.map((t) => (
              <ToolCard key={t.name} {...t} />
            ))}
          </div>
        </Section>

        {/* === Example === */}
        <Section id="example" eyebrow="// example" title="End-to-end with curl">
          <p className="text-[14px] leading-6 text-ink-2">
            Three calls — initialize, discover, create a "Today" board with two columns. The admin token is in <code className="rounded-sm bg-bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-1">$WORKTRACKER_ADMIN_TOKEN</code>.
          </p>
          <CodeBlock
            language="bash"
            code={`# 1. Initialize
curl -sS -X POST https://worktracker-nyx.web.app/mcp \\
  -H "Authorization: Bearer $WORKTRACKER_ADMIN_TOKEN" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2024-11-05","capabilities":{},
                 "clientInfo":{"name":"docs","version":"1"}}}'

# 2. Discover
curl -sS -X POST https://worktracker-nyx.web.app/mcp \\
  -H "Authorization: Bearer $WORKTRACKER_ADMIN_TOKEN" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3. Create a board
curl -sS -X POST https://worktracker-nyx.web.app/mcp \\
  -H "Authorization: Bearer $WORKTRACKER_ADMIN_TOKEN" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call",
       "params":{"name":"worktracker.boards.create",
                 "arguments":{"name":"Today",
                              "columns":[
                                {"id":"doing","label":"Doing","statuses":["in_progress"]},
                                {"id":"done","label":"Done","statuses":["done","cancelled"]}
                              ],
                              "is_default":true}}}'`}
          />
        </Section>

        {/* === Clients === */}
        <Section id="clients" eyebrow="// clients" title="Connecting an MCP client">
          <p className="text-[14px] leading-6 text-ink-2">
            The MCP spec expects servers to live at a stable path, so a generic client just needs the URL and the bearer token. Three reference configs.
          </p>
          <div className="mt-5 space-y-4">
            <ClientBlock
              name="Claude Desktop"
              hint="~/Library/Application Support/Claude/claude_desktop_config.json"
              config={`{
  "mcpServers": {
    "worktracker": {
      "url": "https://worktracker-nyx.web.app/mcp",
      "headers": {
        "Authorization": "Bearer \${WORKTRACKER_ADMIN_TOKEN}"
      }
    }
  }
}`}
            />
            <ClientBlock
              name="Cursor"
              hint="~/.cursor/mcp.json"
              config={`{
  "mcpServers": {
    "worktracker": {
      "url": "https://worktracker-nyx.web.app/mcp",
      "headers": {
        "Authorization": "Bearer \${WORKTRACKER_ADMIN_TOKEN}"
      }
    }
  }
}`}
            />
            <ClientBlock
              name="Custom agent"
              hint="any json-rpc 2.0 client"
              config={`POST https://worktracker-nyx.web.app/mcp
Authorization: Bearer <token>
Content-Type: application/json

{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }`}
            />
          </div>
        </Section>

        {/* === Errors === */}
        <Section id="errors" eyebrow="// errors" title="Error model">
          <p className="text-[14px] leading-6 text-ink-2">
            Two layers — JSON-RPC 2.0 application errors and HTTP transport errors. Either may surface, depending on the failure.
          </p>
          <h3 className="mt-5 font-mono text-[10.5px] font-medium uppercase tracking-mono-widest text-ink-3">
            json-rpc 2.0
          </h3>
          <div className="mt-2 space-y-1.5">
            {RPC_ERRORS.map((e) => (
              <CodeRow key={e.code} code={e.code} body={e.body} />
            ))}
          </div>
          <h3 className="mt-6 font-mono text-[10.5px] font-medium uppercase tracking-mono-widest text-ink-3">
            http transport
          </h3>
          <div className="mt-2 space-y-1.5">
            {HTTP_ERRORS.map((e) => (
              <CodeRow key={e.code} code={e.code} body={e.body} />
            ))}
          </div>
        </Section>

        <footer className="border-t border-border-subtle/40 pt-4 font-mono text-[10.5px] uppercase tracking-mono-wide text-ink-3">
          // end of mcp reference · v0.1 · mirrors the monorepo readme
        </footer>
      </article>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Tool catalog — sourced from apps/api/src/mcp.ts. Kept in sync manually.      */

type ToolDef = {
  name: string;
  auth: 'read' | 'read_write' | 'admin' | 'any';
  purpose: string;
  params?: { name: string; kind: string; required: boolean; note?: string }[];
};

const ITEM_TOOLS: ToolDef[] = [
  { name: 'worktracker.items.list',    auth: 'read',       purpose: 'List items, optionally filtered by kind / status / source / owner / board_id (use "backlog" for board_id: null) / q (search) / limit (default 50, max 200). Set include_archived=true to include archived items.' },
  { name: 'worktracker.items.get',     auth: 'read',       purpose: 'Fetch one item by id, with its full event timeline and file pointer list.' },
  { name: 'worktracker.items.create',  auth: 'read_write', purpose: 'Queue a create command. Validates per-kind data strictly (TaskData / TicketData / DecisionData / ReviewData). Returns { command_id, status: "queued" }.' },
  { name: 'worktracker.items.update',  auth: 'read_write', purpose: 'Patch fields with expected_version for optimistic concurrency. A patch that sets status is folded into a transition (state machine gate fires); a patch that sets archived_at is folded into archive.' },
  { name: 'worktracker.items.comment', auth: 'read_write', purpose: 'Append a comment event to an item\u2019s timeline. Does not bump the item version.' },
  { name: 'worktracker.items.link',    auth: 'read_write', purpose: 'Create a typed relationship: parent_id \u2192 child_id with kind \u2208 { depends_on, blocks, related, mirrors, parent_of }.' },
  { name: 'worktracker.items.unlink',  auth: 'read_write', purpose: 'Remove a link by (parent_id, child_id, kind). No-op if no matching link exists.' },
];

const BOARD_TOOLS: ToolDef[] = [
  { name: 'worktracker.boards.list',   auth: 'read',   purpose: 'List all boards, ordered by name, with the is_default flag marking the landing view.' },
  { name: 'worktracker.boards.get',    auth: 'read',   purpose: 'Fetch one board by id, including its column definitions and kind filter.' },
  { name: 'worktracker.boards.create', auth: 'admin',  purpose: 'Create a board. Pass is_default: true to make it the landing view (unsets the existing default in the same batch).' },
  { name: 'worktracker.boards.update', auth: 'admin',  purpose: 'Update name / description / kinds / columns / is_default. Omit a field to keep its current value.' },
  { name: 'worktracker.boards.delete', auth: 'admin',  purpose: 'Delete a board. The default board cannot be deleted \u2014 set another board as default first.' },
];

const FILE_TOOLS: ToolDef[] = [
  { name: 'worktracker.files.list',    auth: 'read',       purpose: 'List file pointers attached to an item (metadata only). Bytes live in files/{file_id}.' },
  { name: 'worktracker.files.get',     auth: 'read',       purpose: 'Fetch a file\u2019s metadata by id. The actual bytes are served by the REST GET /api/files/:id endpoint (the MCP JSON-RPC envelope can\u2019t carry binary).' },
  { name: 'worktracker.files.upload',  auth: 'read_write', purpose: 'Attach a base64-encoded file to an item. 1 MB per file, 10 MB per item. Returns { file_id, file }.' },
];

const CLIENT_TOOLS: ToolDef[] = [
  { name: 'worktracker.clients.introspect', auth: 'read',   purpose: '"Who am I" — returns the caller\u2019s name, kind, scope, owner_uid, last_used_at, capabilities, server_version, and the list of tool names this scope can see.' },
  { name: 'worktracker.clients.list',       auth: 'admin',  purpose: 'List all clients (agents + users) with their scope, last_used_at, and capabilities.' },
  { name: 'worktracker.clients.mint',       auth: 'admin',  purpose: 'Mint a new kind: user client (personal access token). Returns the bearer exactly once.' },
  { name: 'worktracker.clients.rotate',     auth: 'admin',  purpose: 'Rotate a kind: user client\u2019s bearer. The old bearer is invalidated immediately. Returns the new bearer once.' },
];

const CONNECTOR_TOOLS: ToolDef[] = [
  { name: 'worktracker.connectors.list', auth: 'admin', purpose: 'List all connectors (mirror, webhook-in, webhook-out, bridge) with their protocol and last-run status.' },
  { name: 'worktracker.connectors.get',  auth: 'admin', purpose: 'Fetch one connector by name, including its kind-specific config.' },
];

const DISPATCH_TOOLS: ToolDef[] = [
  { name: 'worktracker.dispatch.run', auth: 'read_write', purpose: 'High-level tool: pre-flight + missing enrichment + transition. Extended: can move Backlog \u2192 board (item_id + options.board_id + options.to_status). Returns the queued command ids.' },
  { name: 'worktracker.enrich.run',   auth: 'read_write', purpose: 'Standalone Grill / Wayfind run. Enqueues an enrich command; the brain writes the enrichment_state and an event.' },
];

const RPC_ERRORS = [
  { code: '-32700', body: 'Parse error (malformed JSON).' },
  { code: '-32600', body: 'Invalid request (missing jsonrpc: "2.0", unknown method).' },
  { code: '-32601', body: 'Method not found.' },
  { code: '-32602', body: 'Invalid params (e.g. tools/call with a missing name, or arguments that fail the tool\u2019s JSON-Schema).' },
  { code: '-32603', body: 'Internal error (the brain or Firestore returned an unexpected failure).' },
];

const HTTP_ERRORS = [
  { code: '401', body: 'Missing or invalid bearer token.' },
  { code: '404', body: 'Request hit a path the service doesn\u2019t expose (e.g. POSTed to /mcp on a deployment whose rewrite isn\u2019t installed).' },
  { code: '405', body: 'Wrong method (GETted a POST-only path).' },
];

/* -------------------------------------------------------------------------- */
/* Small subcomponents                                                          */

function Section({
  id, eyebrow, title, children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="card scroll-mt-24 p-5">
      <header className="space-y-1">
        <span className="eyebrow">{eyebrow}</span>
        <h2 className="text-[20px] font-semibold tracking-tight text-ink-1" style={{ letterSpacing: '-0.015em' }}>
          {title}
        </h2>
      </header>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Auth({ kind, label, body }: { kind: 'admin' | 'source'; label: string; body: string }) {
  // Static class maps — Tailwind's JIT can't see runtime-computed
  // class names, so we spell both branches out.
  const toneClass =
    kind === 'admin'
      ? 'text-magenta-500'
      : 'text-brand-500';
  return (
    <div className="card-inset grid grid-cols-[180px_1fr] items-baseline gap-3 p-3">
      <span className={`font-mono text-[11px] uppercase tracking-mono-wide ${toneClass}`}>
        {kind}
      </span>
      <div>
        <p className="font-mono text-[12.5px] text-ink-1">{label}</p>
        <p className="mt-0.5 text-[12.5px] text-ink-2">{body}</p>
      </div>
    </div>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — clipboard may be blocked
    }
  }
  return (
    <div className="relative mt-3 overflow-hidden rounded-md border border-border-subtle/40 bg-bg-sunken">
      <div className="flex items-center justify-between border-b border-border-subtle/30 px-3 py-1.5 font-mono text-[10px] uppercase tracking-mono-widest text-ink-3">
        <span>{language}</span>
        <button
          type="button"
          onClick={copy}
          className="focus-ring rounded-sm px-2 py-0.5 text-ink-3 transition-colors hover:bg-bg-raised hover:text-brand-500"
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-3 font-mono text-[12px] leading-relaxed text-ink-1">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function ClientBlock({ name, hint, config }: { name: string; hint: string; config: string }) {
  return (
    <div className="card-inset p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-mono text-[11.5px] uppercase tracking-mono-wide text-brand-500">{name}</p>
        <p className="font-mono text-[10.5px] text-ink-3">{hint}</p>
      </div>
      <CodeBlock language={name === 'Custom agent' ? 'http' : 'json'} code={config} />
    </div>
  );
}

function ToolCard({ name, auth, purpose }: ToolDef) {
  return (
    <div className="card-inset p-3.5">
      <div className="flex flex-wrap items-baseline gap-3">
        <code className="font-mono text-[12.5px] text-ink-1">{name}</code>
        <span className={`rounded-sm border px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-mono-widest ${
          auth === 'admin'
            ? 'border-magenta-500/40 text-magenta-500'
            : 'border-border-subtle/40 text-ink-3'
        }`}>
          {auth === 'admin' ? 'admin' : 'any auth'}
        </span>
      </div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">{purpose}</p>
    </div>
  );
}

function CodeRow({ code, body }: { code: string; body: string }) {
  return (
    <div className="card-inset grid grid-cols-[80px_1fr] items-baseline gap-3 px-3 py-2">
      <code className="font-mono text-[12px] text-status-blocked">{code}</code>
      <span className="text-[12.5px] text-ink-2">{body}</span>
    </div>
  );
}
