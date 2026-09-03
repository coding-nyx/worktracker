/**
 * Local seed: populates the Firestore emulator with a small set
 * of clients, work items, and events. Run with:
 *
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 \
 *   GCLOUD_PROJECT=worktracker-local \
 *   npx tsx scripts/seed.ts
 *
 * Uses the Firestore REST API (the v1 endpoint) directly so we
 * don't need any credentials — the emulator accepts any project
 * ID and skips auth.
 *
 * Slice 2: every client is written with an explicit `scope` so
 * `getEffectiveScope` resolves deterministically. The old
 * `adminSources` allowlist is gone — the only admin path is
 * WORKTRACKER_ADMIN_TOKEN, plus any client doc with
 * `scope: 'admin'`.
 */

import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';

const HOST = process.env.FIRESTORE_EMULATOR_HOST ?? 'localhost:8080';
const PROJECT = process.env.GCLOUD_PROJECT ?? 'worktracker-local';
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

async function fy(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Firestore ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : null;
}

function fyDoc(fields: Record<string, FirestoreValue>): { fields } {
  return { fields: flatten(fields) };
}

type FirestoreValue =
  | { stringValue: string }
  | { integerValue: string }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { timestampValue: string }
  | { mapValue: { fields: Record<string, FirestoreValue> } }
  | { arrayValue: { values: FirestoreValue[] } };

function flatten(obj: Record<string, unknown>): Record<string, FirestoreValue> {
  const out: Record<string, FirestoreValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = toFirestoreValue(v);
  }
  return out;
}

function toFirestoreValue(v: unknown): FirestoreValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return { integerValue: String(Math.trunc(v)) };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'object') {
    return { mapValue: { fields: flatten(v as Record<string, unknown>) } };
  }
  return { stringValue: String(v) };
}

const now = () => new Date().toISOString();
const id = () => Date.now().toString(36) + randomBytes(4).toString('hex');

type ClientKind = 'agent' | 'user';
type ApiTokenScope = 'read' | 'read_write' | 'admin';

/**
 * Seed a single agent client. Slice 2: the `scope` field is
 * written explicitly; `getEffectiveScope` reads it and gates
 * MCP tool visibility. Default scope is `read_write`; pass
 * `admin` for clients that need board admin tools.
 */
async function seedClient(input: {
  name: string;
  displayName: string;
  capabilities: string[];
  scope: ApiTokenScope;
}): Promise<string> {
  const apiKey = randomBytes(24).toString('base64url');
  const hash = await bcrypt.hash(apiKey, 8);
  const manifest = {
    name: input.name,
    display_name: input.displayName,
    kind: 'agent' as ClientKind,
    capabilities: input.capabilities,
    webhook_url: null,
    icon: null,
    version: '1.0.0',
  };
  const ts = now();
  await fy(`/sources/${input.name}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(fyDoc({
      name: input.name,
      display_name: input.displayName,
      kind: 'agent' as ClientKind,
      scope: input.scope,
      owner_uid: null,
      manifest,
      capabilities: input.capabilities,
      api_key_hash: hash,
      webhook_secret: null,
      enabled: true,
      created_at: ts,
      updated_at: ts,
      last_used_at: null,
      rotated_at: null,
      revoked_at: null,
    })),
  });
  console.log(`  ✓ client "${input.name}" created (scope: ${input.scope}, api_key: ${apiKey})`);
  return apiKey;
}

async function seedItem(partial: {
  kind: 'task' | 'ticket' | 'decision' | 'review';
  title: string;
  body?: string;
  status: string;
  severity?: 'low' | 'medium' | 'high' | 'critical' | null;
  priority?: 'low' | 'medium' | 'high' | null;
  source: string;
  owner?: string | null;
  due_at?: string | null;
  // Slice 3 — board + rich data.
  board_id?: string | null;
  data?: Record<string, unknown>;
  data_map?: Record<string, string | number | boolean | null>;
}): Promise<string> {
  const itemId = `item-${Math.random().toString(36).slice(2, 10)}`;
  const ts = now();
  await fy(`/work_items/${itemId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(fyDoc({
      id: itemId,
      kind: partial.kind,
      title: partial.title,
      body: partial.body ?? null,
      status: partial.status,
      severity: partial.severity ?? null,
      priority: partial.priority ?? null,
      source: partial.source,
      source_id: null,
      source_meta: {},
      owner: partial.owner ?? null,
      enricher: null,
      enrichment_state: null,
      due_at: partial.due_at ?? null,
      parent_id: null,
      group_id: null,
      archived_at: null,
      // Slice 3 — board + rich data. The default is Backlog
      // (board_id: null); seeded items below pin a real board
      // once `seedBoards` runs.
      board_id: partial.board_id ?? null,
      data: partial.data ?? {},
      data_map: partial.data_map ?? {},
      plan_file_id: null,
      analysis: null,
      files: [],
      created_at: ts,
      updated_at: ts,
      version: 1,
    })),
  });
  await fy(`/work_items/${itemId}/events/evt-${itemId}-created`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(fyDoc({
      id: `evt-${itemId}-created`,
      item_id: itemId,
      kind: 'created',
      actor: `source:${partial.source}`,
      body: null,
      from_status: null,
      to_status: partial.status,
      field: null,
      from_value: null,
      to_value: null,
      command_id: null,
      source_event_id: null,
      enrichment_stage: null,
      created_at: ts,
    })),
  });
  console.log(`  ✓ item "${itemId}" created (${partial.title})`);
  return itemId;
}

async function main(): Promise<void> {
  console.log('Seeding WorkTracker local Firestore…');

  // 1. Clients (slice 2). Scope is explicit. Admin scope is reserved
  // for the operator; agent clients get read_write by default; a
  // single test client gets `read` to exercise the read-only path.
  const hermesKey = await seedClient({
    name: 'hermes',
    displayName: 'Hermes',
    capabilities: ['create', 'update', 'transition', 'comment', 'link'],
    scope: 'read_write',
  });
  await seedClient({
    name: 'mavis',
    displayName: 'Mavis / Claude Code',
    capabilities: ['create', 'update', 'transition', 'comment', 'link', 'enrich:grill', 'enrich:wayfind'],
    scope: 'read_write',
  });
  await seedClient({
    name: 'codex',
    displayName: 'Codex CLI',
    capabilities: ['create', 'update', 'transition', 'comment'],
    scope: 'read_write',
  });
  await seedClient({
    name: 'cline',
    displayName: 'Cline',
    capabilities: ['create', 'update', 'transition', 'comment'],
    scope: 'read_write',
  });
  await seedClient({
    name: 'web',
    displayName: 'WorkTracker Web UI',
    capabilities: ['create', 'update', 'transition', 'comment', 'link'],
    // The web UI is a logged-in Firebase user, but the legacy
    // `web` source still shows up in dashboards and event actors.
    // The web UI itself authenticates with a Firebase ID token,
    // not this bearer; the scope just keeps the legacy record
    // consistent.
    scope: 'admin',
  });
  await seedClient({
    name: 'read-only-test',
    displayName: 'Read-only test client',
    capabilities: [],
    scope: 'read',
  });

  // 2. Boards. Slice 3 — items are owned by a board (or the
  // Backlog, when board_id is null). Seed one default board so
  // the seeded items can land somewhere; the operator can create
  // more from /admin/boards.
  const defaultBoardId = `board-${Math.random().toString(36).slice(2, 10)}`;
  await fy(`/boards/${defaultBoardId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(fyDoc({
      id: defaultBoardId,
      name: 'Today',
      description: 'Default work board. Tasks and tickets together.',
      columns: [
        { id: 'doing',   label: 'Doing',   statuses: ['in_progress', 'triaged'] },
        { id: 'ready',   label: 'Ready',   statuses: ['ready', 'proposed', 'pending'] },
        { id: 'review',  label: 'Review',  statuses: ['changes_requested', 'approved', 'merged'] },
        { id: 'done',    label: 'Done',    statuses: ['done', 'resolved', 'accepted', 'closed'] },
        { id: 'block',   label: 'Blocked', statuses: ['blocked'] },
        { id: 'back',    label: 'Backlog', statuses: ['open'] },
      ],
      kinds: null,
      is_default: true,
      created_at: now(),
      updated_at: now(),
    })),
  });
  console.log(`  ✓ board "${defaultBoardId}" created (Today, default)`);

  // 3. Work items. Slice 3 — most pin to the default board;
  // a couple stay in the Backlog (board_id: null) to exercise
  // the backlog view.
  const today = new Date();
  const inDays = (n: number) =>
    new Date(today.getTime() + n * 24 * 60 * 60 * 1000).toISOString();

  await seedItem({
    kind: 'task',
    title: 'Wire Hermes connector for v0 round-trip',
    body: 'The Hermes connector should mirror work items bidirectionally with the local Hermes kanban.',
    status: 'in_progress',
    priority: 'high',
    source: 'hermes',
    owner: 'worktracker',
    due_at: inDays(2),
    board_id: defaultBoardId,
    data: { estimate_minutes: 240, tags: ['hermes', 'mirror', 'v0'] },
    data_map: { sprint: 'v0.5', team: 'integrations' },
  });
  await seedItem({
    kind: 'task',
    title: 'Build the Kanban view with dnd-kit + Firestore onSnapshot',
    body: 'Drag-drop between columns; live updates as items move.',
    status: 'ready',
    priority: 'high',
    source: 'web',
    due_at: inDays(1),
    board_id: defaultBoardId,
    data: { estimate_minutes: 480, tags: ['web', 'kanban'] },
    data_map: { sprint: 'v0.5', team: 'web' },
  });
  await seedItem({
    kind: 'task',
    title: 'Document the brain conflict-resolution policy',
    body: 'The brain logs every rejected command to the conflicts collection with our_value, their_value, and a reason.',
    status: 'open',
    priority: 'medium',
    source: 'mavis',
    due_at: inDays(5),
    // No board_id — lives in the Backlog.
    data: { estimate_minutes: 60, tags: ['docs', 'brain'] },
    data_map: { sprint: 'v0.5' },
  });
  await seedItem({
    kind: 'task',
    title: 'Apple Reminders direct-send via Mac daemon',
    status: 'open',
    priority: 'low',
    source: 'web',
    due_at: inDays(14),
    // No board_id — lives in the Backlog.
    data: { tags: ['mac-daemon', 'reminders'] },
  });
  await seedItem({
    kind: 'task',
    title: 'Add Connector Admin Enricher Pool config',
    status: 'blocked',
    priority: 'medium',
    source: 'mavis',
    board_id: defaultBoardId,
    data: { estimate_minutes: 120, tags: ['connectors', 'enrichment'] },
  });
  await seedItem({
    kind: 'task',
    title: 'Document REST + MCP API surface',
    status: 'done',
    source: 'codex',
    board_id: defaultBoardId,
    data: { estimate_minutes: 90, tags: ['docs', 'mcp'] },
  });
  await seedItem({
    kind: 'ticket',
    title: 'Optimistic-concurrency bug: 409 surfaces generic message',
    body: 'When expected_version mismatches, the API returns version_conflict but the message could be more actionable (include actual version).',
    status: 'triaged',
    severity: 'medium',
    source: 'cline',
    board_id: defaultBoardId,
    // ticket.data requires `severity` (the per-kind strict schema).
    data: { severity: 'medium', customer: 'internal', reproduction: 'POST /api/items with stale expected_version' },
  });
  await seedItem({
    kind: 'decision',
    title: 'Use Zoho Catalyst as the WorkTracker host? — rejected',
    body: 'Discussion: separate project from AXUIKit, no Cliq usage, want tight DX. Picked Firebase.',
    status: 'accepted',
    source: 'mavis',
    board_id: defaultBoardId,
    // decision.data requires at least one option.
    data: {
      options: [
        { id: 'firebase',  title: 'Firebase / Cloud Run' },
        { id: 'catalyst',  title: 'Zoho Catalyst' },
      ],
      chosen_option_id: 'firebase',
      rationale: 'Tighter DX, separate from AXUIKit, no Cliq usage.',
    },
  });
  await seedItem({
    kind: 'review',
    title: 'Review FCM push-notification path for v0.5',
    status: 'pending',
    source: 'codex',
    board_id: defaultBoardId,
    // review.data has all fields optional.
    data: { reviewer: 'nyx', verdict: 'comment' },
  });

  // 4. Save the hermes api key for downstream smoke tests.
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    new URL('../.local-secrets.json', import.meta.url),
    JSON.stringify({ hermesApiKey: hermesKey, adminToken: 'local-admin-token' }, null, 2),
    'utf8',
  );
  console.log('  ✓ saved .local-secrets.json with the Hermes api key');

  console.log('Seed complete.');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
