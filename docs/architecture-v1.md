# WorkTracker — Architecture v1

**Status:** Plan locked. No code has been written yet. Implementation begins on your go.
**Philosophy:** Wrecking ball. The new system is the only system. No compat shims, no migration scripts, no backward-compat aliases.
**Visual layer:** Cyberpunk minimalist (cyan + magenta on near-black, hairline grid, mono labels, Avenir Next + JetBrains Mono). Already shipped on `worktracker-nyx.web.app` for the v0.1 design; v1 builds on the same tokens.

---

## 0. TL;DR

| | |
|---|---|
| **Backend** | Fastify on Cloud Run, 23 MCP tools, single source of truth for the state machine, scope filter on `tools/list`, Streamable HTTP for the standard clients, webhooks for OS agents |
| **Frontend** | Next.js 15, cyberpunk design, live `onSnapshot` subscription, Clients page with a 4-step agent-connection wizard, Connectors page, Conflicts page, Dead-letter page, Analytics page |
| **Data** | `work_items` with rich fields (`data`, `data_map`, `plan_file_id`, `analysis`, `files`, `board_id`), per-kind state machine, append-only `events`, `boards`, `clients` (replaces `api_tokens` + `sources`), `connectors`, `analytics/call_traces` |
| **Admin model** | `WORKTRACKER_ADMIN_TOKEN` is the operator genesis. The first web sign-in auto-mints a `kind: 'user', scope: 'admin'` client bound to the user's Firebase uid. All subsequent admin operations go through a client |
| **Connect** | 8 protocol modules (claude-code, codex, cline, copilot, cursor, openclaw, hermes, custom). Each declares its own `transport` (json-rpc / http-webhook / etc.) and its own `endpoint`. The same registry powers the wizard, the docs page, and the "Add an agent" CTA |
| **Implementation** | 7 PRs, in order, ~4,000 lines total |

---

## 1. The new model

### 1.1 The admin model

There is exactly **one** source of admin authority: `WORKTRACKER_ADMIN_TOKEN`, the operator's env var. It is the genesis. The token never appears in the `clients` collection; it never rotates; it is the only credential the system trusts without a database lookup.

Every other admin action flows through a `clients/{name}` row with `scope: 'admin'`. The first time a human signs in to the web UI, the system auto-mints them a `kind: 'user', scope: 'admin'` client bound to their Firebase uid. They use that client for all subsequent operations. The operator's env var becomes "break glass" — for offline recovery, the next operator, the next deployment.

A user is "admin" iff they own a `kind: 'user', scope: 'admin'` client. The `users/{firebase_uid}.is_admin` flag is a derived cache.

### 1.2 The clients model (replaces `api_tokens` and `sources`)

One collection. Two `kind` values. One mint operation.

```
clients/{name}
  name:           string
  kind:           'user' | 'agent'
  display_name:   string
  owner_uid:      string | null       // firebase_uid; null for system agents
  scope:          'read' | 'read_write' | 'admin'
  manifest:       { name, display_name, kind, capabilities[], version } | null
  capabilities:   string[]
  enabled:        boolean
  created_at:     iso
  last_used_at:   iso | null
  rotated_at:     iso | null
  revoked_at:     iso | null
  // Auth shape differs by kind:
  api_key_hash:   string | null      // scrypt($name.$random_key), only for kind=agent (legacy shape)
  bearer_id:      string | null      // random 32 bytes; bearer = "wt_<bearer_id>"; only for kind=user
```

Two auth shapes because they have different entropy needs:
- `kind: 'agent'` — bearer is `<name>.<random_key>`, scrypt-hashed. The name is human-meaningful (Claude, Hermes); the random key is 32 bytes; the bearer survives a name change.
- `kind: 'user'` — bearer is `wt_<random_32byte_id>`, the id IS the credential (Stripe / GitHub PAT model — 256 bits of entropy, no hash needed).

The auth middleware (`apps/api/src/auth.ts:requireSource`) handles both shapes. Path 3 (`if (token.startsWith('wt_'))`) reads from `clients`; path 4 (`<name>.<key>`) reads from `clients` with `kind: 'agent'`. One collection, one lookup table, two verification paths.

### 1.3 The connectors model (new)

A connector is an integration the API talks to. A client is an authenticated identity. Hermes is both — `clients/hermes` is its bearer, `connectors/hermes` is its integration config.

```
connectors/{name}
  name:         string
  kind:         'mirror' | 'webhook-in' | 'webhook-out' | 'bridge' | ...
  protocol:     'hermes-cli-v1' | 'webhook-json-v1' | 'openclaw-bridge-v1' | ...
  config:       Record<string, unknown>      // kind-specific
  enabled:      boolean
  last_run_at:  iso | null
  last_status:  'ok' | 'error' | null
  last_error:   string | null
  created_at:   iso
  updated_at:   iso
```

The connector code (e.g. `apps/api/src/connectors/hermes.ts`) becomes a config-driven implementation. The class becomes `HermesConnectorImpl`; a thin `ConnectorRegistry` reads `connectors/{name}` from Firestore and dispatches. The admin UI shows `last_run_at`, `last_status`, a "test" action that calls the connector's `test` op.

### 1.4 The protocol module registry (new)

Eight protocol modules. One per supported agent. The same registry powers the wizard, the docs page, and the "Add an agent" CTA.

```ts
// apps/api/src/connectors/protocols/index.ts
export interface AgentProtocol {
  name: string;                                      // 'claude-code'
  displayName: string;                               // 'Claude Code'
  category: 'mcp-client' | 'os-agent';
  transport: {
    request:  'json-rpc-2.0' | 'http-webhook' | 'http-form' | 'custom';
    response: 'json-rpc-2.0' | 'http-200' | 'stream-sse' | 'custom';
    contentType?: string;
  };
  endpoint: { method: 'GET' | 'POST' | 'PUT'; path: string };
  configSnippet: (input: { bearer: string; apiBase: string }) => {
    filePath: string;
    fileFormat: 'json' | 'toml' | 'shell';
    content: string;
  };
  installSteps: (input: { bearer: string; apiBase: string }) => string[];
  verifyStep: (input: { bearer: string; apiBase: string }) => string;
}
```

| Agent | category | transport.request | transport.response | endpoint |
|-------|----------|-------------------|--------------------|----------|
| claude-code | mcp-client | json-rpc-2.0 | stream-sse | POST /mcp/stream |
| codex | mcp-client | json-rpc-2.0 | stream-sse | POST /mcp/stream |
| cline | mcp-client | json-rpc-2.0 | stream-sse | POST /mcp/stream |
| copilot | mcp-client | json-rpc-2.0 | stream-sse | POST /mcp/stream |
| cursor | mcp-client | json-rpc-2.0 | stream-sse | POST /mcp/stream |
| openclaw | mcp-client | json-rpc-2.0 | stream-sse | POST /mcp/stream |
| hermes | os-agent | http-webhook | http-200 | POST /api/webhooks/hermes |
| custom | mcp-client | json-rpc-2.0 | json-rpc-2.0 | POST /mcp |

---

## 2. The 23 tools, namespaced, scope-filtered

`tools/list` returns only the tools the bearer's effective scope allows. A `read` token sees 7; `read_write` sees 16; `admin` sees 23. The "no tool will fail" promise: every tool in your `tools/list` succeeds for its advertised purpose. An out-of-scope call returns `-32603` with a clear debuggable message (e.g. `"tool worktracker.boards.create requires admin scope (effective: read_write)"`).

| Namespace | Tool | Scope | Purpose |
|-----------|------|-------|---------|
| items | `list` | read | List with kind/status/source/board/owner/q/limit/include_archived filters |
| items | `get` | read | One item + events + files |
| items | `create` | read_write | Create (data, data_map, plan_file_id, analysis, files[], board_id=null for backlog) |
| items | `update` | read_write | Patch fields with `expected_version`; validates status against state machine, data against kind schema, board_id exists |
| items | `comment` | read_write | Append a comment event |
| items | `link` | read_write | Create a typed relationship (depends_on, blocks, related, mirrors, parent_of) |
| items | `unlink` | read_write | Remove a link by id |
| boards | `list` | read | All boards, ordered by name |
| boards | `get` | read | One board by id |
| boards | `create` | admin | Create; `is_default: true` unsets the previous default in the same batch |
| boards | `update` | admin | Patch fields; re-assigning default unsets the previous |
| boards | `delete` | admin | Delete by id; default board returns `cannot_delete_default` |
| files | `list` | read | List files for an item (metadata) |
| files | `get` | read | Download a file by id (base64) |
| files | `upload` | read_write | Multipart upload to an item; returns `file_id` |
| clients | `list` | admin | All clients with scope + last_seen + last_used_at |
| clients | `mint` | admin | Create a new client (name, kind, scope). Returns the bearer once |
| clients | `rotate` | admin | Rotate a client's bearer; old bearer invalidated immediately |
| clients | `introspect` | read | "Who am I" — returns `{ name, kind, scope, owner_uid, last_used_at, capabilities, server_version, visible_tools }` |
| connectors | `list` | admin | All connectors with kind, protocol, last_run, last_status |
| connectors | `get` | admin | One connector with config and run history |
| dispatch | `run` | read_write | Pre-flight + missing enrichment + transition. Extended: can move backlog → board (item_id + board_id + to_status) |
| enrich | `run` | read_write | Standalone Grill / Wayfind run |

**Scope counts:**
- `read`: 7 tools (list, get × 2; clients.introspect; files.list, files.get)
- `read_write`: 9 tools (items.create, items.update, items.comment, items.link, items.unlink; files.upload; dispatch.run, enrich.run; items.list is read)
- `admin`: 7 tools (boards.create, boards.update, boards.delete; clients.list, clients.mint, clients.rotate; connectors.list, connectors.get)

---

## 3. The data model

### 3.1 `work_items/{id}`

```ts
{
  id:             ULID,
  kind:           'task' | 'ticket' | 'decision' | 'review',
  title:          string,
  body:           string | null,
  status:         WorkItemStatus,
  board_id:       string | null,           // null = backlog
  source:         string,                   // 'clients/{name}'
  source_id:      string | null,            // external id (Hermes task_id, etc.)
  source_meta:    Record<string, unknown>,

  owner:          string | null,            // @handle or email
  priority:       'low' | 'medium' | 'high' | null,
  severity:       'low' | 'medium' | 'high' | 'critical' | null,
  due_at:         iso | null,
  archived_at:    iso | null,

  // Slice 3 — rich data
  data:           Record<string, unknown>,  // strict per-kind Zod schema
  data_map:       Record<string, string | number | boolean | null>,  // free-form kv
  plan_file_id:   string | null,             // pointer into files/
  analysis:       { summary: string; sections: AnalysisSection[] } | null,
  files:          WorkItemFile[],            // attachments (≤1 MB each, ≤10 MB per item)

  enrichment_state: { grill: EnrichmentRun | null, wayfind: EnrichmentRun | null },

  version:        number,                    // optimistic concurrency
  created_at:     iso,
  updated_at:     iso,
}
```

### 3.2 `work_items/{id}/events/{eid}` — append-only

```ts
{
  id:           ULID,
  work_item_id: ULID,
  kind:         'created' | 'updated' | 'transition' | 'comment' | 'linked' | 'unlinked'
              | 'enriched' | 'dispatched' | 'archived' | 'unarchived' | 'mirrored_back',
  actor:        string,                       // 'clients/{name}' or 'users/{uid}'
  body:         string | null,                 // for comments
  from_status:  WorkItemStatus | null,
  to_status:    WorkItemStatus | null,
  from_value:   unknown,                      // for updates
  to_value:     unknown,
  link:         { kind, other_id } | null,     // for linked/unlinked
  created_at:   iso,
  source_event_id: string | null,             // idempotency
}
```

### 3.3 `item_links/{id}` — typed relationships

```ts
{
  id:         ULID,
  from_id:    ULID,                           // 'parent'
  to_id:      ULID,                           // 'child'
  kind:       'depends_on' | 'blocks' | 'related' | 'mirrors' | 'parent_of',
  created_at: iso,
  created_by: string,
}
```

### 3.4 `boards/{id}`

```ts
{
  id:          ULID,
  name:        string,
  description: string | null,
  columns:     [{ id: string, label: string, statuses: WorkItemStatus[], color: string }],
  kinds:       WorkItemKind[] | null,          // null = all kinds
  is_default:  boolean,
  created_at:  iso,
  updated_at:  iso,
}
```

### 3.5 `clients/{name}` — see §1.2

### 3.6 `connectors/{name}` — see §1.3

### 3.7 `analytics/call_traces/{trace_id}` — 30-day TTL

```ts
{
  id:         ULID,
  ts:         iso,
  agent:      'claude-code' | 'codex' | 'cline' | 'copilot' | 'cursor' | 'openclaw' | 'hermes' | 'wizard' | 'unknown',
  bearer_id:  string,                          // 'clients/{name}', not the secret
  context:    'wizard_test' | 'mcp_call' | 'mcp_list' | 'webhook_in' | 'webhook_out',
  request:  { method, path, headers, body },
  response: { status, body, latency_ms },      // on success
  error:    { code, message, retryable },      // on failure
  outcome:  'success' | 'auth_failed' | 'unreachable' | 'server_error' | 'client_error',
}
```

### 3.8 `commands/{id}` and `conflicts/{id}` — unchanged

The brain's input queue and the rejection log. Internal to the API; surfaced in the Conflicts and Dead-letter admin pages.

---

## 4. The state machine — single source of truth

`apps/api/src/state-machine.ts` exports `canTransition(from, to, kind)`. The page imports it for column-greyout hints. The brain imports it for the actual gate. One file, one graph per kind.

```ts
const EDGES: Record<Kind, Record<Status, Status[]>> = {
  task: {
    open:        ['ready', 'in_progress', 'blocked', 'done', 'cancelled'],
    ready:       ['open', 'in_progress', 'blocked', 'done', 'cancelled'],
    in_progress: ['ready', 'blocked', 'done', 'cancelled'],
    blocked:     ['ready', 'in_progress', 'done', 'cancelled'],
    done:        ['ready', 'in_progress'],
    cancelled:   ['open'],
  },
  ticket:   { /* ... */ },
  decision: { /* ... */ },
  review:   { /* ... */ },
};
```

This is the fix for the broken drag-drop in v0.1. The page, the brain, and the MCP tool all read the same graph; the failure mode "drop did nothing, silently" goes away.

---

## 5. Per-kind `data` schemas (strict Zod)

`work_items.{kind}.data` is validated against a per-kind Zod schema on every write. The detail view relies on the typed shape; lenient validation is a footgun.

```ts
// task
{ estimate_minutes?: number; acceptance_criteria?: string[]; tags?: string[] }

// ticket
{ severity: 'low'|'medium'|'high'|'critical'; customer?: string; reproduction?: string }

// decision
{ options: DecisionOption[]; chosen_option_id?: string; rationale?: string }

// review
{ reviewer?: string; rubric?: string; verdict?: 'approve'|'request_changes'|'comment' }
```

The detail view renders the typed shape in the `Data` tab. The free-form `data_map` is the "everything else" bucket (sprint, team, capacity, etc.).

---

## 6. The site map

```
/                       Kanban home (board view or Backlog view)
/clients                All clients + Connect an agent wizard
/clients/:name         One client: rotate, test-connection, activity timeline
/connectors             All connectors (admin)
/connectors/:name       One connector: config, run history, test action
/admin                  Tabs: Connectors / Boards / Enrichers
/admin/boards           Boards CRUD
/admin/users            Users + is_admin toggle (admin only)
/admin/conflicts        Open conflicts (admin only)
/admin/dead-letter      Replay failed commands (admin only)
/admin/analytics        Call traces + per-agent summary (admin only)
/docs                   Updated for slices 1-6
/settings               Per-user: account, change password, MCP ID token, link to /clients?kind=user
/login                  Brand stage (cyberpunk redesign, shipped)
/mcp.md                 Public markdown on-ramp
```

The TopBar reflects the user's role:
- `Kanban | Clients | Connectors | Docs | Settings | Sign out` for a normal user
- `Kanban | Clients | Connectors | Admin ▼ | Docs | Settings | Sign out` for an admin (Admin ▼ expands to Boards / Users / Conflicts / Dead-letter / Analytics)

---

## 7. The wizard — 4 steps

The "Connect an agent" CTA on `/clients` opens this:

1. **Pick an agent** — claude-code / codex / cline / copilot / cursor / openclaw / hermes / custom
2. **Bearer** — paste a `wt_…` token, or click "Generate a new client" to mint one inline
3. **Test** — calls `clients.introspect` with the bearer; shows the visible tools and the effective scope; surfaces failures as a mono `[err] bearer invalid (HTTP 401)` block
4. **Install** — config snippet (with the bearer inlined), OS-detected file path, numbered install steps, copy-able verify command

For Hermes specifically, step 4 is two-sided: the `hermes webhook subscribe …` shell command (run on the user's box) plus a "POST /api/connectors/hermes" form (run by the admin). The wizard generates both; the user pastes the shell command and the admin posts the connector.

---

## 8. The 7 slices, condensed

### Slice 1 — Tool segregation + Streamable HTTP

- Add `required_scope` to every `TOOLS` entry
- `tools/list` filters by `getEffectiveScope(httpReq)` — the one-line fix for "no tool will fail"
- `tools/call` returns `-32603` with a clear debuggable message when scope is insufficient
- Add a thin **Streamable HTTP** handler at `POST /mcp/stream` that wraps the same `handleRpc` and returns `Mcp-Session-Id` headers

### Slice 2 — Sources vs Connectors → `clients` + `connectors`

- Rename `Source` → `Client` (drop the `MCP` prefix; everything is MCP-shaped)
- Add `scope` to `Client`; `getEffectiveScope` reads `client.scope` directly
- Add `Connector` type + collection
- `HermesConnector` class becomes `HermesConnectorImpl`; a thin `ConnectorRegistry` reads `connectors/{name}` and dispatches
- Drop the `adminSources` env allowlist (no compat shim)
- Merge `api_tokens` into `clients/{name}` with `kind: 'user'`
- Add REST routes `/api/clients` (renamed from `/api/sources`) and `/api/connectors` (new)

### Slice 3 — Kanban data model + state machine + rich data + backlog

- Add `data`, `data_map`, `plan_file_id`, `analysis`, `files`, `board_id` to `WorkItem`
- `apps/api/src/state-machine.ts` (new) — per-kind transition graph, the only source
- `apps/api/src/brain.ts` calls `canTransition`; invalid moves reject with a clear reason
- Per-kind Zod schemas for `data`, strict validation on write
- Backlog = `board_id IS NULL`; kanban has a Backlog view when no board is active
- Page imports `canTransition` to grey out invalid columns; surfaces brain errors in the mono `[err]` block (the drag-drop fix)
- Files in Firestore: `files/{file_id}` collection, base64 bytes inline, 1 MB per file, 10 MB per item

### Slice 4 — Final list of 23 tools, namespaced

- Dotted namespaces: `worktracker.items.*`, `worktracker.boards.*`, `worktracker.files.*`, `worktracker.clients.*`, `worktracker.connectors.*`, `worktracker.dispatch.*`, `worktracker.enrich.*`
- `transition`, `set_reminder`, `archive` fold into `items.update` with field-level validation
- New: `items.unlink`, `files.upload`, `clients.mint`, `clients.rotate`, `clients.introspect`
- `clients.introspect` returns `visible_tools` so clients render their own palette
- Drop the old flat `worktracker_*` names (wrecking ball, no aliases)

### Slice 5 — Data flow

- One request traced end to end: `POST /mcp/stream` → `requireSource` → Zod validate → write `commands/{ulid}` → brain trigger → Firestore transaction → `onSnapshot` listener → web UI re-render
- The brain uses `runTransaction` for atomicity
- `commands/{ulid}` queue is internal; the `conflicts/{id}` and `dead-letter` admin pages surface failures
- The "no tool will fail" promise is preserved end to end: every tool a client can see, it can call; calls fail only for real reasons (version conflict, network, item not found)

### Slice 6 — User connects various agents

- 8 protocol modules: claude-code, codex, cline, copilot, cursor, openclaw, hermes, custom
- Each declares its own `transport` (json-rpc / http-webhook) and its own `endpoint`
- The same registry powers the wizard, the docs page, and the "Add an agent" CTA
- Hermes install is two-sided: shell command locally + admin posts the connector
- Wizard flow: pick → bearer → test (real `clients.introspect` call) → install (snippet + steps + verify)
- Call traces written to `analytics/call_traces/{id}` with 30-day TTL

### Slice 7 — Web page for connected tokens + analytics

- `/clients` — the Clients page (replaces Sources). Top: "Connect an agent" CTA. Middle: `kind: 'agent'` table. Bottom: `kind: 'user'` table (the "Your API tokens" view, filtered)
- `/clients/:name` — detail view: rotate, test-connection, last 24h activity, install steps re-runnable
- `/connectors` — admin: kind, protocol, last_run, last_status, test action
- `/admin/conflicts` — admin: open conflicts with ours/theirs/merge per row
- `/admin/dead-letter` — admin: failed commands, replay button
- `/admin/analytics` — admin: recent call traces (filter by agent, outcome, time range) + per-agent summary (5-min stale badge)
- `/docs` — updated with per-scope tool table, protocol modules, admin model, data model
- `/settings` — thin shell, links to `/clients?kind=user&owner=me` for token management
- Conflicts, Dead-letter, Analytics are admin-only
- Archive on `kind: 'user'` sets `revoked_at` immediately; bearer invalidated
- The wizard's test-connection is a real call, recorded in call traces

---

## 9. The implementation roadmap — 7 PRs

| PR | Slice | Approx size | Notes |
|----|-------|-------------|-------|
| PR 1 | Slice 1 | ~150 lines | Tool registry + scope filter + Streamable HTTP. The smallest PR and the most impactful change. |
| PR 2 | Slice 2 | ~600 lines | `clients` + `connectors` + new admin pages + seed. The data model swap. |
| PR 3 | Slice 3 | ~400 lines | Rich data fields + state machine + backlog view. The drag-drop fix. |
| PR 4 | Slice 4 | ~800 lines | Dotted namespaces + `clients` mint/rotate/introspect + 23 tools. The surface. |
| PR 5 | Slice 5 | ~200 lines | Data flow wiring (mostly already there) + brain uses `canTransition`. Mostly verification. |
| PR 6 | Slice 6 | ~500 lines | 8 protocol modules + wizard + call traces. The onboarding. |
| PR 7 | Slice 7 | ~1,500 lines | All the new pages + the wizard + analytics. The UI surface. |

Total: ~4,000 lines. Sequential is fine; PR 1 and PR 7 are the headline and the wrap, respectively.

---

## 10. What's out of scope (deferred)

- OAuth for agents that support it (Codex can do it; bearer is the v1 surface)
- Email / Slack notifications
- Real-time analytics dashboard (WebSocket); the 5-min stale badge is enough
- File storage larger than 1 MB (would need Firebase Storage as a secondary path)
- Multi-tenant support
- Per-user themes / accessibility beyond the cyberpunk aesthetic
- Mobile app
- API token rate limiting (Cloud Run + Firestore quotas are the v1 limit)

---

## 11. Open questions to revisit at implementation time

These were the 5-question batches at the end of each slice. The decisions are all locked; this is a checklist for the implementer.

- **PR 1:** confirm `SCOPE_RANK` ordering matches the per-tool `required_scope` table; confirm Streamable HTTP `Mcp-Session-Id` round-trip format with the MCP spec
- **PR 2:** confirm the seed script runs idempotently (re-running shouldn't duplicate the operator client); confirm `connectors/{name}` and `clients/{name}` are independent (no FK)
- **PR 3:** confirm the per-kind Zod schemas match the README's intent; confirm the `canTransition` graph matches the existing `isValidTransition` in `app/page.tsx:707-734` (one round of cleanup)
- **PR 4:** confirm the `visible_tools` ordering is deterministic (alphabetical? by-namespace-then-name?); confirm the admin client mint happens on the first sign-in without a separate UI action
- **PR 5:** confirm the call trace volume is acceptable (Firestore writes per MCP call); add TTL policy before launch
- **PR 6:** confirm each protocol module's `verifyStep` runs against the actual API and surfaces a useful result
- **PR 7:** confirm the wizard is reachable from every page that needs it; confirm the analytics page is fast on first load (Firestore aggregation cached, not per-render)

---

## 12. Sources of truth

- This document: the architecture plan, locked
- `docs/redesign-cyberpunk-plan.md`: the visual design, already shipped
- `packages/types/src/index.ts`: the type definitions
- `apps/api/src/state-machine.ts`: the only transition graph
- `apps/api/src/auth.ts`: the only auth middleware
- `apps/api/src/connectors/protocols/index.ts`: the only protocol registry
- `apps/api/src/brain.ts`: the only write path
- `web/app/docs/page.tsx`: the user-facing reference (rendered from the protocol registry + this plan)
