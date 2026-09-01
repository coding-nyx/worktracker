# WorkTracker

A single backend that unifies work items across every tool you work
in — Hermes, Claude Code, Codex, Cline, Grok, the web UI, and any
future connector. One canonical store, one kanban, one place to
track what you actually have to do.

## What it does

- **Multi-source, equal peers.** Every connector (Hermes, Mavis /
  Claude Code, Codex, Cline, Grok, OpenClaw, the web UI) registers
  as a first-class plugin and submits items through the same
  command queue.
- **Single canonical store.** WorkTracker is the source of truth.
  All writes go through the brain; all sources read from the
  same `work_items` collection.
- **Multi-board kanban.** Boards are saved views — each pins a
  list of columns (label + status mapping) and an optional kind
  filter. Users pick a board from the kanban picker; admins CRUD
  them at `/admin/boards` or via the MCP `worktracker_*_board`
  tools. The default board is the first thing every user sees.
- **Dispatch enrichment.** Items moving to "in progress" go through
  a pre-flight check that runs Grill (interrogate gaps) and Wayfind
  (map dependencies + propose solution) via a configured enricher
  source.
- **Plugin SDK.** New connectors ship a `manifest.json` and a
  bearer token; the Connector Admin UI registers them.
- **REST + MCP + webhooks.** Three surfaces; same auth, same brain.
  MCP exposes 15 tools (items CRUD, transitions, comments, links,
  enrich, dispatch, and 5 board tools).
- **Live UI.** Kanban with Firestore `onSnapshot`; the card moves
  on the server and the browser updates the same frame.

## Repo layout

```
worktracker/                       # this monorepo (npm workspaces)
├── apps/
│   └── api/                       # Fastify + Cloud Functions v2 backend
│       ├── src/
│       │   ├── index.ts            # Cloud Functions entry (api + brain)
│       │   ├── app.ts              # Fastify app factory
│       │   ├── firestore.ts        # Admin SDK init
│       │   ├── auth.ts            # Bearer + admin middleware
│       │   ├── errors.ts           # WorkTracker error types
│       │   ├── ids.ts              # ULID generation
│       │   ├── repo.ts             # work_item writes (the only writer)
│       │   ├── brain.ts            # command evaluator (Firestore trigger)
│       │   ├── mcp.ts              # JSON-RPC 2.0 MCP server
│       │   ├── config.ts           # env config
│       │   ├── routes/            # REST routes
│       │   │   ├── health.ts
│       │   │   ├── items.ts
│       │   │   ├── sources.ts
│       │   │   ├── commands.ts
│       │   │   └── webhooks.ts
│       │   └── connectors/
│       │       └── hermes.ts      # Hermes bidirectional sync
│       └── tests/
│           └── brain.test.ts      # e2e brain tests
├── packages/
│   └── types/                      # @worktracker/types — shared contracts
├── web/                            # @worktracker/web — Next.js UI
│   ├── app/
│   │   ├── page.tsx               # Kanban
│   │   ├── sources/page.tsx        # Sources + register
│   │   ├── admin/page.tsx          # Connector Admin + Enricher Pool
│   │   └── layout.tsx              # Avenir Next, brand color
│   ├── lib/
│   │   ├── api.ts                  # REST client
│   │   ├── firebase.ts             # Firebase client SDK init
│   │   └── useItemsSubscription.ts # Live onSnapshot hook
│   └── tailwind.config.ts
├── firebase.json                    # Functions + Hosting + Emulators
├── firestore.rules                  # per-collection access rules
├── firestore.indexes.json           # composite indexes
├── tsconfig.base.json
└── package.json                     # npm workspaces root
```

## Stack

- **Backend** — Node 20+, TypeScript, Fastify, Firebase Admin SDK,
  Cloud Functions v2, Firestore triggers. All writes go through a
  command queue processed by a single Cloud Function.
- **Web UI** — Next.js 15, Tailwind, dnd-kit, TanStack Query,
  Firebase JS SDK for live `onSnapshot`. Avenir Next per user
  preference.
- **MCP** — JSON-RPC 2.0 mounted at `/mcp` on the same Fastify
  process; the same bearer-token auth as the REST surface.
- **LLM** — MiniMax via the OpenAI-compatible API for body
  summarization, smart search, auto-classification, and the
  hosted-Grill fallback. The MCP source enrichment (Cline, Mavis,
  Hermes, Codex) uses the *source's own LLM* — the source agents
  own their enrichment quality.

## Quick start (local dev)

```bash
# 1. Install deps
npm install

# 2. Start the Firestore + Functions + Auth + Hosting emulators
npm run emulators

# 3. In a second terminal, start the API in dev mode (it
#    auto-connects to the emulator via FIRESTORE_EMULATOR_HOST).
WORKTRACKER_ADMIN_TOKEN=local-admin \
WORKTRACKER_ENV=local \
npm run dev:api

# 4. In a third terminal, start the web UI.
NEXT_PUBLIC_API_BASE=http://127.0.0.1:4001 \
NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-worktracker \
npm run dev:web

# 5. Visit http://localhost:3000 and paste the API base + admin
#    token in the Sign-in prompt.
```

## Deployment (Firebase)

```bash
# 1. Log in and pick your project.
firebase login
firebase use --add <your-firebase-project>

# 2. Set the admin token as a function env var.
firebase functions:secrets:set WORKTRACKER_ADMIN_TOKEN
# (paste the token when prompted; pick functions:secrets:allow)

# 3. Build + deploy.
npm run deploy
```

This:
- Deploys the `api` Cloud Function (the Fastify + MCP app).
- Deploys the `brain` Cloud Function (the Firestore trigger).
- Deploys the `web` Next.js app to Firebase Hosting.

### CI secrets (GitHub Actions)

The `live smoke` job in `.github/workflows/ci.yml` runs `scripts/smoke.sh`
against the live API and web after every push to `master`. It needs three
repo secrets set under `Settings → Secrets and variables → Actions`:

| Secret | Purpose |
| --- | --- |
| `SMOKE_API_BASE` | The canonical host the smoke test should hit (e.g. `https://worktracker-nyx.web.app`). |
| `SMOKE_ADMIN_TOKEN` | The `WORKTRACKER_ADMIN_TOKEN` value, so the script can `POST /api/items` and `POST /api/boards` against the live API. |
| `GCP_SA_KEY` | A GCP service-account JSON key with the roles `Cloud Run Invoker` and `Firestore User` on the project. Used by `gcloud auth activate-service-account` so the smoke run can do admin-level Firestore cleanup via `gcloud firestore`. |

Until these are set, the `live smoke` job will fail with
`Could not read json file /tmp/sa.json: Expecting value: line 2 column 1 (char 1)`
and the run will surface as a red ✗ on master, but the API / web / image
builds remain green and production is unaffected.
- Pushes `firestore.rules` and `firestore.indexes.json`.

## Data model

Five v0 must-ship Firestore collections:

- `work_items/{id}` — the canonical record.
- `work_items/{id}/events/{eventId}` — append-only event log
  (sub-collection; cross-item reads use a `collectionGroup` query).
- `sources/{name}` — registered connectors.
- `commands/{id}` — the brain's input queue; the trigger fires
  on `onDocumentCreated`.
- `conflicts/{id}` — every rejected command lands here for review.

Composite indexes on `commands(source, source_event_id)` for
idempotency, and on `work_items(status, updated_at)` /
`work_items(source, updated_at)` for the Kanban view.

## Architecture

The end-to-end flow:

1. A source (REST, MCP, webhook, or UI) submits a command by
   writing a `commands/{id}` document with `status: 'queued'`.
2. The `brain` Cloud Function fires on `onDocumentCreated`. It
   reads the current `work_items/{id}` (if any) in a transaction,
   evaluates the command (field-level validation, invariants,
   conflict check against `version`), and applies or rejects it.
3. On apply: the work item and an event sub-document are written
   in the same transaction, and the command's status flips to
   `applied`.
4. On reject: a `conflicts` document is written and the command
   flips to `rejected` with a human-readable reason.
5. The UI subscribes to `work_items` via Firestore `onSnapshot`
   and re-renders without polling.

WorkTracker is the **only** writer of `work_items`. Every other
write path in the system funnels through the command queue. This
is enforced by the architecture, not by the rules — the rules are
defense-in-depth.

## Hermes integration

The Hermes connector (`apps/api/src/connectors/hermes.ts`) handles
the bidirectional sync. For v0 it shells the `hermes` CLI to talk
to the local kanban; a Cloud Function scheduled ping keeps the
webhook subscription alive.

## Operational runbook

- 50K reads/day, 20K writes/day, 1 GiB storage.
- A single user is well under the limit. A runaway loop in the
  brain could exceed it; the brain has a write-throttle and the
  `conflicts` log surfaces rejections.

### Conflict resolution

When the brain rejects a command, the row lands in `conflicts`
with the rejected value, our value, and the reason. The Sources
view shows un-resolved conflicts; the Connector Admin lets the
user pick "ours" / "theirs" / merge.

### Token rotation

`POST /sources/<name>` with `rotate_api_key: true` rotates a
source's bearer token. The previous token is invalidated
immediately.

## Boards

A board is a saved kanban view — a list of columns (label + status mapping) and an optional kind filter. Items are not duplicated; the same `work_items` collection powers every board, the columns just bucket items by their `status` field.

```json
{
  "id": "01HW...",
  "name": "Daily",
  "description": "Tasks for today",
  "kinds": ["task"],
  "columns": [
    { "id": "todo",  "label": "To Do", "statuses": ["open"] },
    { "id": "doing", "label": "Doing", "statuses": ["in_progress"] },
    { "id": "done",  "label": "Done",  "statuses": ["done", "cancelled"] }
  ],
  "is_default": true
}
```

A column's `statuses` is the set of `WorkItem.status` values that bucket into that column. So a single "Done" column can show both task `done` and ticket `resolved` if you put both in its `statuses`. The kanban renders columns top-to-bottom; drag a card from one column to another to transition it (the first status in the destination column is the new state).

**Reading:** every user can `GET /api/boards` and `GET /api/boards/:id`. The kanban reads these on load and stores the active board id in `localStorage['worktracker.active_board_id']`.

**Writing (admin only):** `POST /api/boards`, `PATCH /api/boards/:id`, `DELETE /api/boards/:id`. The web admin page at `/admin/boards` wraps these in a CRUD UI. Default boards (`is_default: true`) cannot be deleted.

**Out of the box:** a fresh deployment has no boards, so the kanban falls back to a 5-column `Open / Ready / In Progress / Blocked / Done` layout (the v0 behavior). Create a board in `/admin/boards` to take control.

## MCP

The MCP (Model Context Protocol) server lets external clients — Claude Desktop, Cursor, custom agents, anything that speaks JSON-RPC 2.0 — read and write work items and boards through the same surface the web UI uses.

### Endpoint

| Path | Methods | Notes |
| --- | --- | --- |
| `POST /mcp` | JSON-RPC 2.0 | Conventional MCP path. Routed by Firebase Hosting rewrite to Cloud Run. |
| `POST /api/mcp` | JSON-RPC 2.0 | Internal alias; same handler. Use this when calling through `/api/**` rewrites. |
| `GET /mcp` | (405) | MCP is request/response for now; SSE is wired but no server-push events fire yet. |

The transport is **HTTP POST + JSON-RPC 2.0**. The server speaks the `2024-11-05` protocol version. Responses are `Content-Type: application/json` for `tools/list` and `Content-Type: text/event-stream` (`data: {…}\n\n` per JSON-RPC result) for `tools/call` so a future SSE transport drops in without a client change.

### Auth

Every request needs a bearer token:

```
Authorization: Bearer <WORKTRACKER_ADMIN_TOKEN>     # admin (read + write everything)
Authorization: Bearer <source-specific token>        # read + write under that source
```

The same `requireSource` preHandler that guards the REST API guards MCP — there's no separate `requireAdmin` at the transport layer; admin status is inferred from the source's `kind` field on the registered `Source` record (or from the well-known admin token, for ad-hoc admin work). The five board tools (`worktracker_list_boards` / `get_board` / `create_board` / `update_board` / `delete_board`) require admin; reads (`list_boards`, `get_board`) are open to any authenticated source.

### Initialize handshake

```json
{ "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": { "protocolVersion": "2024-11-05",
             "capabilities": {},
             "clientInfo": { "name": "my-agent", "version": "1.0.0" } } }
```

Response:

```json
{ "jsonrpc": "2.0", "id": 1,
  "result": { "protocolVersion": "2024-11-05",
             "serverInfo":   { "name": "worktracker", "version": "0.1.0" },
             "capabilities": { "tools": {} } } }
```

### Discovery

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }
```

Returns an array of 15 tool definitions. The full table:

#### Work items (10)

| Tool | Auth | Purpose |
| --- | --- | --- |
| `worktracker_list_items` | any | List items, optionally filtered by `kind` / `status` / `source` / `owner` / `q` (search), paginated by `limit` (default 50, max 200). Set `include_archived=true` to include archived items. |
| `worktracker_get_item` | any | Fetch one item by id, with its full event timeline. |
| `worktracker_create_item` | any | Queue a `create` command. Returns `{ command_id, status: "queued" }`; the brain materializes the item asynchronously. |
| `worktracker_update_item` | any | Queue an `update` command with a `patch` of allowed fields and `expected_version` for optimistic concurrency. |
| `worktracker_transition` | any | Queue a `transition` command to `to_status`. `expected_version` is required. `comment` is optional. `force_dispatch` skips enrichment if true. |
| `worktracker_comment` | any | Append a comment event to an item's timeline. |
| `worktracker_link_items` | any | Create a typed relationship: `parent_id` → `child_id` with `kind ∈ {depends_on, blocks, related, mirrors, parent_of}`. |
| `worktracker_set_reminder` | any | Attach a reminder at `remind_at` to be delivered on `channel` to `target`. v0.5 stub. |
| `worktracker_enrich` | any | Run Grill or Wayfind on an item. `stage ∈ {grill, wayfind, both}`. v0 stretch. |
| `worktracker_dispatch` | any | High-level: pre-flight + missing enrichment + transition. `options.force` skips gating checks. Returns a job id. |

#### Boards (5)

| Tool | Auth | Purpose |
| --- | --- | --- |
| `worktracker_list_boards` | any | List all boards with full column definitions and the `is_default` flag. |
| `worktracker_get_board` | any | Fetch one board by id. |
| `worktracker_create_board` | admin | Create a board. Pass `is_default: true` to make it the landing view (unsets the existing default in the same batch). |
| `worktracker_update_board` | admin | Update name / description / kinds / columns / `is_default`. Omit a field to keep its current value. |
| `worktracker_delete_board` | admin | Delete a board. The default board cannot be deleted — set another board as default first. |

### End-to-end example

```bash
# 1. Initialize.
curl -sS -X POST https://worktracker-nyx.web.app/mcp \
  -H "Authorization: Bearer $WORKTRACKER_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2024-11-05","capabilities":{},
                 "clientInfo":{"name":"docs","version":"1.0"}}}'

# 2. Discover.
curl -sS -X POST https://worktracker-nyx.web.app/mcp \
  -H "Authorization: Bearer $WORKTRACKER_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3. Create a "Today" board with two columns, as the default.
curl -sS -X POST https://worktracker-nyx.web.app/mcp \
  -H "Authorization: Bearer $WORKTRACKER_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call",
       "params":{"name":"worktracker_create_board",
                 "arguments":{"name":"Today",
                              "columns":[
                                {"id":"doing","label":"Doing","statuses":["in_progress"]},
                                {"id":"done","label":"Done","statuses":["done","cancelled"]}
                              ],
                              "is_default":true}}}'
```

### Connecting an MCP client

The MCP spec expects servers to live at a stable path, so a generic client just needs the URL and the bearer token. For Claude Desktop, point it at `https://<host>/mcp` with the admin token in the headers. For a custom agent, the `tools/list` payload is the full contract.

### Errors

| Code | Meaning |
| --- | --- |
| `-32700` | Parse error (malformed JSON). |
| `-32600` | Invalid request (missing `jsonrpc: "2.0"`, unknown method). |
| `-32601` | Method not found. |
| `-32602` | Invalid params (e.g. `tools/call` with a missing `name`, or `arguments` that fail the tool's JSON-Schema). |
| `-32603` | Internal error (the brain or Firestore returned an unexpected failure). |
| HTTP `401` | Missing or invalid bearer token. |
| HTTP `404` | Request hit a path the service doesn't expose (e.g. you POSTed to `/mcp` on a deployment whose rewrite isn't installed). |
| HTTP `405` | Wrong method (you `GET`ted a `POST`-only path). |

## Tests

```bash
# Run the brain e2e test against the Firestore emulator.
firebase emulators:exec --only firestore \
  "WORKTRACKER_FIRESTORE_EMULATOR_HOST=localhost:8080 \
   WORKTRACKER_ENV=local \
   WORKTRACKER_ADMIN_TOKEN=local-admin \
   npm --workspace=@worktracker/api test"
```

## License

Private project. Not yet open-sourced.
