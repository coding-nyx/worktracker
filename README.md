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
| `SMOKE_API_BASE` | The canonical host the smoke test should hit (e.g. `https://worktracker-prod-2026.web.app`). |
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

The MCP server is at `POST /api/mcp` (JSON-RPC 2.0, same per-source bearer auth as REST). It exposes 15 tools, in three groups:

**Work items (10):** `worktracker_list_items`, `worktracker_get_item`, `worktracker_create_item`, `worktracker_update_item`, `worktracker_transition`, `worktracker_comment`, `worktracker_link_items`, `worktracker_set_reminder` (v0.5 stub), `worktracker_enrich`, `worktracker_dispatch`.

**Boards (5):** `worktracker_list_boards`, `worktracker_get_board`, `worktracker_create_board` (admin), `worktracker_update_board` (admin), `worktracker_delete_board` (admin; the default board cannot be deleted).

Quick example:

```json
// List tools
{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }

// Create a "Today" board with two columns
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "worktracker_create_board",
    "arguments": {
      "name": "Today",
      "columns": [
        { "id": "doing", "label": "Doing", "statuses": ["in_progress"] },
        { "id": "done", "label": "Done",  "statuses": ["done", "cancelled"] }
      ],
      "is_default": true
    }}}
```

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
