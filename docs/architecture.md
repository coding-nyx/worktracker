# WorkTracker — Architecture

A snapshot of how the system fits together, intended as a
hand-off document for future agents and humans.

## Goals

- **One canonical work-item store.** Every change funneled through WorkTracker.
- **Multi-source, equal peers.** Hermes, Claude Code / Mavis, Codex,
  Cline, Grok, OpenClaw (v1), the web UI, and any future connector
  each register as a plugin.
- **Two-way sync via a command queue.** WorkTracker is the only
  writer; every other source submits commands that the brain
  evaluates and applies or rejects.
- **Dispatch enrichment pipeline.** Items moving to "in progress"
  get a Grill (interrogate gaps) + Wayfind (map dependencies +
  propose solution) pass before the transition completes.
- **Full UI.** Kanban, Reminder (v0.5), Sources, Connector Admin.
- **Plugin SDK.** Manifest, capabilities, install lifecycle.
- **Notification routing.** Per-item via Hermes `kanban
  notify-subscribe`; global digests + Apple Reminders direct send.

## Components

```
┌──────────────────────────────────────────────────────────────────────┐
│                              WorkTracker                              │
│                                                                       │
│  ┌──────────────┐    ┌────────────────┐    ┌──────────────────────┐   │
│  │  REST API    │    │  MCP Server    │    │  Webhook Ingest      │   │
│  │  (public)    │    │  (AI agents)   │    │  (signed, per-source)│   │
│  └──────┬───────┘    └────────┬───────┘    └──────────┬───────────┘   │
│         │                     │                       │               │
│         └──────────┬──────────┴───────────┬───────────┘               │
│                    │                      │                           │
│             ┌──────▼──────┐      ┌────────▼─────────┐                 │
│             │  Command    │      │  Notification    │                 │
│             │  Queue +    │      │  Router          │                 │
│             │  Brain      │      │                  │                 │
│             └──────┬──────┘      └────────┬─────────┘                 │
│                    │                      │                           │
│             ┌──────▼──────────────────────▼─────────┐                 │
│             │          Storage (Firestore)         │                 │
│             │  work_items, events, sources,         │                 │
│             │  commands, conflicts                 │                 │
│             └──────┬───────────────────────────────┘                 │
│                    │                                                  │
│  ┌─────────────────▼──────────────────┐  ┌──────────────────────┐    │
│  │  Connectors (every source = peer)   │  │  UI (Next.js / Tailwind)│  │
│  │  - hermes, claude-code, codex,      │  │  - Kanban             │    │
│  │    cline, grok, web                 │  │  - Sources            │    │
│  │  - openclaw (v1)                    │  │  - Connector Admin    │    │
│  └─────────────────────────────────────┘  └──────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

## Data flow (end-to-end)

1. A source (REST, MCP, webhook, or UI) writes a `commands/{id}`
   document with `status: 'queued'`.
2. The `brain` Cloud Function fires on `onDocumentCreated`. It
   reads the current `work_items/{id}` (if any) in a transaction.
3. The brain evaluates:
   - field-level validation
   - invariant check
   - conflict check against `version`
4. On accept: writes the new `work_items/{id}` and a
   `work_items/{id}/events/{eventId}` sub-document; updates the
   command's status to `applied`.
5. On reject: writes a `conflicts/{id}` document; updates the
   command's status to `rejected` with a human-readable reason.
6. The UI subscribes to `work_items` via Firestore `onSnapshot`
   and re-renders without polling.

## Data model (Firestore)

### v0 must-ship collections

- `work_items/{itemId}` — the canonical record. Fields: `id`,
  `kind`, `title`, `body`, `status`, `severity`, `priority`,
  `source`, `source_id`, `source_meta`, `owner`, `enricher`,
  `enrichment_state`, `due_at`, `parent_id`, `group_id`,
  `archived_at`, `created_at`, `updated_at`, `version`.
- `work_items/{itemId}/events/{eventId}` — append-only event log
  as a sub-collection. Cross-item reads use a `collectionGroup`
  query.
- `sources/{sourceName}` — registered connectors. Fields: `name`,
  `display_name`, `kind`, `manifest`, `api_key_hash`,
  `capabilities`, `webhook_secret`, `enabled`, `last_sync_at`,
  `last_error`, `created_at`, `updated_at`.
- `commands/{commandId}` — the brain's input queue. Fields: `id`,
  `source`, `source_event_id`, `op`, `item_id`, `payload`,
  `status`, `error`, `applied_event_id`, `created_at`,
  `applied_at`.
- `conflicts/{conflictId}` — every rejected command lands here.
  Fields: `id`, `item_id`, `command_id`, `field`, `our_value`,
  `their_value`, `reason`, `resolved`, `created_at`.

### v0 stretch (added when the channel ships)

- `item_links/{linkId}` — generic link between work items
  (depends_on, blocks, related, mirrors, parent_of).
- `reminders/{reminderId}` — a reminder attached to a work item.
- `notification_groups/{groupId}` — a notification rule.
- `notification_deliveries/{deliveryId}` — audit log for
  notification fan-out.

### Composite indexes

- `commands(source, source_event_id)` — idempotency.
- `work_items(status, updated_at)` — Kanban view.
- `work_items(source, updated_at)` — Sources view.
- `work_items(kind, status, updated_at)` — kind-filtered Kanban.

## Auth

- **Admin token.** `WORKTRACKER_ADMIN_TOKEN` env var. Required for
  source registration and conflict resolution. Single-user v0 — the
  web UI uses the admin token directly.
- **Per-source bearer.** Generated at source registration,
  bcrypt-hashed at rest. Source clients pass `Authorization:
  Bearer <source>.<key>` for fast lookup; the slow path scans
  all sources.
- **Token rotation.** `PATCH /sources/<name>` with
  `rotate_api_key: true` generates a new key, replaces the hash,
  and returns the new plaintext once.

## REST surface

```
GET    /healthz
GET    /readyz

GET    /items
POST   /items
GET    /items/:id
PATCH  /items/:id
DELETE /items/:id
GET    /items/:id/events
POST   /items/:id/transition
POST   /items/:id/comment
POST   /items/:id/link
POST   /items/:id/enrich
GET    /items/:id/enrichment

GET    /sources
POST   /sources
GET    /sources/:name
PATCH  /sources/:name
DELETE /sources/:name

GET    /commands
GET    /commands/:id

POST   /webhooks/:source
```

## MCP surface

JSON-RPC 2.0 over HTTP at `/mcp`. Tools:

- `worktracker_list_items` (filter params)
- `worktracker_get_item` (id)
- `worktracker_create_item`
- `worktracker_update_item`
- `worktracker_transition`
- `worktracker_comment`
- `worktracker_link_items`
- `worktracker_set_reminder` (v0.5)
- `worktracker_enrich` (v0 stretch)
- `worktracker_dispatch` (v0 stretch)
- `worktracker_search`

## Hosting

Firebase. Cloud Functions v2 for the Fastify app and the brain
trigger. Firestore for storage. Firebase Hosting for the Next.js
UI. FCM is available for push but not used in v0.

## Operational notes

- The brain trigger is idempotent on
  `(source, source_event_id)`.
- Optimistic concurrency on writes via `expected_version`.
- Per-source bearer tokens are bcrypt-hashed; the slow path
  scans the sources collection (bounded by single-user v0).
- The `web` source enforces the "all UI actions go through the
  brain" rule: there is no direct-write path from the UI.
