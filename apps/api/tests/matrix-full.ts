/**
 * Full access matrix — every tool, every caller kind.
 *
 * Requires the local API + Firestore emulator to be running
 * (see tests/local-server.ts and `firebase emulators:start
 * --only firestore`). Seed the world with two sources
 * (hermes + unknown-bot) before running.
 *
 * Run:
 *   source /tmp/matrix-env.sh
 *   npx tsx tests/matrix-full.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.WORKTRACKER_API_BASE ?? 'http://127.0.0.1:8081/mcp';
const HERMES = process.env.HERMES_BEARER ?? '';
const UNKNOWN = process.env.UNKNOWN_BEARER ?? '';
const ADMIN = process.env.ADMIN_TOKEN ?? 'local-admin-token';
const SEED_BOARD_ID = process.env.SEED_BOARD_ID ?? '';

async function call(bearer: string, name: string, args: Record<string, unknown> = {}): Promise<{ http: number; body: any }> {
  const resp = await fetch(BASE, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const http = resp.status;
  let body: any = null;
  try { body = await resp.json(); } catch { body = await resp.text(); }
  let unwrapped: any = body;
  if (body?.error) {
    unwrapped = { ok: false, error: body.error.message ?? body.error.code, _jsonRpcCode: body.error.code };
  } else if (body?.result?.structuredContent) {
    unwrapped = body.result.structuredContent;
  } else if (body?.result?.content?.[0]?.text) {
    try { unwrapped = JSON.parse(body.result.content[0].text); }
    catch { unwrapped = body.result.content[0].text; }
  } else if (body?.result && typeof body.result === 'object') {
    unwrapped = { ok: true, value: body.result };
  }
  return { http, body: unwrapped };
}

function short(r: { http: number; body: any }): string {
  return `http=${r.http} ${JSON.stringify(r.body).slice(0, 140)}`;
}

// Track every tool tested for the summary
const tested: string[] = [];
const skipped: string[] = [];

// ===== READ TOOLS (6) =====
test('read: list_items (admin, hermes, unknown)', async () => {
  for (const [label, b] of [['admin', ADMIN], ['hermes', HERMES], ['unknown', UNKNOWN]] as const) {
    const r = await call(b, 'worktracker_list_items', { limit: 1 });
    assert.equal(r.http, 200, `[${label}] list_items http: ${short(r)}`);
    assert.ok(r.body?.items !== undefined || r.body?.value?.items !== undefined, `[${label}] list_items shape: ${short(r)}`);
  }
  tested.push('list_items');
});

test('read: get_item (admin, hermes, unknown) — need an existing id', async () => {
  // Create a fresh item and wait for the brain to apply so we
  // have a known id to fetch. (Race: when the test starts at
  // the top of the file, the work_items collection is empty.)
  const stamp = Date.now();
  await call(HERMES, 'worktracker_create_item', { kind: 'task', title: `get-item-fixture-${stamp}` });
  // Poll for it to materialize (brain async apply).
  let id: string | undefined;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 250));
    const list = await call(ADMIN, 'worktracker_list_items', { limit: 50 });
    const items = list.body?.items ?? list.body?.value?.items ?? [];
    const hit = items.find((it: any) => it.title === `get-item-fixture-${stamp}`);
    if (hit) { id = hit.id; break; }
  }
  if (!id) {
    console.log('  brain did not materialize fixture within 5s — skip');
    skipped.push('get_item');
    return;
  }
  for (const [label, b] of [['admin', ADMIN], ['hermes', HERMES], ['unknown', UNKNOWN]] as const) {
    const r = await call(b, 'worktracker_get_item', { id });
    assert.equal(r.http, 200, `[${label}] get_item http: ${short(r)}`);
    assert.ok(r.body?.item ?? r.body?.value?.item, `[${label}] get_item has item: ${short(r)}`);
  }
  tested.push('get_item');
});

test('read: list_boards (admin, hermes, unknown)', async () => {
  for (const [label, b] of [['admin', ADMIN], ['hermes', HERMES], ['unknown', UNKNOWN]] as const) {
    const r = await call(b, 'worktracker_list_boards');
    assert.equal(r.http, 200, `[${label}] list_boards: ${short(r)}`);
  }
  tested.push('list_boards');
});

test('read: get_board (admin, hermes, unknown)', async () => {
  if (!SEED_BOARD_ID) {
    console.log('  no seed board — skipping get_board');
    skipped.push('get_board');
    return;
  }
  for (const [label, b] of [['admin', ADMIN], ['hermes', HERMES], ['unknown', UNKNOWN]] as const) {
    const r = await call(b, 'worktracker_get_board', { id: SEED_BOARD_ID });
    assert.equal(r.http, 200, `[${label}] get_board: ${short(r)}`);
  }
  tested.push('get_board');
});

// ===== WRITE TOOLS (6) =====
test('write: create_item (admin, hermes) + update_item round-trip + archive', async () => {
  const stamp = Date.now();
  for (const [label, b] of [['admin', ADMIN], ['hermes', HERMES]] as const) {
    const c = await call(b, 'worktracker_create_item', { kind: 'task', title: `matrix-${label}-${stamp}` });
    assert.equal(c.http, 200, `[${label}] create_item: ${short(c)}`);
    const cmd = c.body?.command_id ?? c.body?.value?.command_id;
    assert.ok(cmd, `[${label}] create_item returned command_id: ${short(c)}`);
  }
  tested.push('create_item');

  // update_item round-trip on a fresh item
  const c = await call(HERMES, 'worktracker_create_item', { kind: 'task', title: `matrix-update-${Date.now()}` });
  const cid = c.body?.command_id ?? c.body?.value?.command_id;
  // need an item id, not a command_id — list to get it
  await new Promise(r => setTimeout(r, 1000));
  const list = await call(HERMES, 'worktracker_list_items', { limit: 50 });
  const items = list.body?.items ?? list.body?.value?.items ?? [];
  const target = items.find((i: any) => i.title?.includes(`matrix-update-`));
  if (target) {
    const u = await call(HERMES, 'worktracker_update_item', {
      id: target.id, patch: { archived_at: new Date().toISOString() }, expected_version: target.version ?? 1,
    });
    assert.equal(u.http, 200, `update_item: ${short(u)}`);
  } else {
    console.log('  could not find created item to update (timing?) — archive path skipped');
  }
  tested.push('update_item');
});

test('write: transition (hermes) — move an item forward', async () => {
  const c = await call(HERMES, 'worktracker_create_item', { kind: 'task', title: `matrix-transition-${Date.now()}` });
  const cmd = c.body?.command_id ?? c.body?.value?.command_id;
  // list to get id
  await new Promise(r => setTimeout(r, 1000));
  const list = await call(HERMES, 'worktracker_list_items', { limit: 50 });
  const items = list.body?.items ?? list.body?.value?.items ?? [];
  const target = items.find((i: any) => i.title?.includes(`matrix-transition-`));
  if (!target) {
    console.log('  no item to transition (timing?) — skip');
    skipped.push('transition');
    return;
  }
  const t = await call(HERMES, 'worktracker_transition', {
    id: target.id, to_status: 'task.in_progress', expected_version: target.version ?? 1,
  });
  assert.equal(t.http, 200, `transition: ${short(t)}`);
  tested.push('transition');
});

test('write: comment (hermes)', async () => {
  // Create a fixture + wait for it to materialize, then comment.
  const stamp = Date.now();
  await call(HERMES, 'worktracker_create_item', { kind: 'task', title: `comment-fixture-${stamp}` });
  let target: any;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 250));
    const list = await call(HERMES, 'worktracker_list_items', { limit: 50 });
    const items = list.body?.items ?? list.body?.value?.items ?? [];
    target = items.find((it: any) => it.title === `comment-fixture-${stamp}`);
    if (target) break;
  }
  if (!target) {
    console.log('  fixture did not materialize — skip');
    skipped.push('comment');
    return;
  }
  const r = await call(HERMES, 'worktracker_comment', {
    id: target.id, body: `matrix comment ${stamp}`, expected_version: target.version ?? 1,
  });
  assert.equal(r.http, 200, `comment: ${short(r)}`);
  tested.push('comment');
});

test('write: link_items (hermes)', async () => {
  // create two items then link them
  const stamp = Date.now();
  const a = await call(HERMES, 'worktracker_create_item', { kind: 'task', title: `link-a-${stamp}` });
  const b = await call(HERMES, 'worktracker_create_item', { kind: 'task', title: `link-b-${stamp}` });
  await new Promise(r => setTimeout(r, 1000));
  const list = await call(HERMES, 'worktracker_list_items', { limit: 50 });
  const items = list.body?.items ?? list.body?.value?.items ?? [];
  const ia = items.find((i: any) => i.title === `link-a-${stamp}`);
  const ib = items.find((i: any) => i.title === `link-b-${stamp}`);
  if (!ia || !ib) {
    console.log(`  link items not found in list (timing?) — skip`);
    skipped.push('link_items');
    return;
  }
  const r = await call(HERMES, 'worktracker_link_items', {
    parent_id: ia.id, child_id: ib.id, kind: 'related',
  });
  assert.equal(r.http, 200, `link_items: ${short(r)}`);
  // Wait for brain to apply the link, then verify a `linked` event
  // shows up on BOTH items (parent + child). This is the bug that
  // was hidden by the stub `return null` — the command returned
  // `applied` but no event was ever written.
  await new Promise(r => setTimeout(r, 1500));
  const parent = await call(HERMES, 'worktracker_get_item', { id: ia.id });
  const child = await call(HERMES, 'worktracker_get_item', { id: ib.id });
  // get_item returns the raw shape { item, events } under
  // `result` (not wrapped in structuredContent). The unwrap helper
  // wraps raw shapes as {ok: true, value: <result>}, so dig two
  // levels deep.
  const unwrap = (r: any) => r.body?.value ?? r.body;
  const p = unwrap(parent);
  const c = unwrap(child);
  const pEvents = p.events ?? p.item?.events ?? [];
  const cEvents = c.events ?? c.item?.events ?? [];
  assert.ok(pEvents.some((e: any) => e.kind === 'linked'), `parent item has no 'linked' event: ${short(parent)}`);
  assert.ok(cEvents.some((e: any) => e.kind === 'linked'), `child item has no 'linked' event: ${short(child)}`);
  tested.push('link_items');
});

test('write: dispatch (hermes) — heaviest single tool', async () => {
  const c = await call(HERMES, 'worktracker_create_item', { kind: 'task', title: `matrix-dispatch-${Date.now()}` });
  const cmd = c.body?.command_id ?? c.body?.value?.command_id;
  await new Promise(r => setTimeout(r, 1000));
  const list = await call(HERMES, 'worktracker_list_items', { limit: 50 });
  const items = list.body?.items ?? list.body?.value?.items ?? [];
  const target = items.find((i: any) => i.title?.includes(`matrix-dispatch-`));
  if (!target) {
    console.log('  dispatch target not found — skip');
    skipped.push('dispatch');
    return;
  }
  const r = await call(HERMES, 'worktracker_dispatch', { id: target.id });
  assert.equal(r.http, 200, `dispatch: ${short(r)}`);
  tested.push('dispatch');
});

test('write: set_reminder (hermes) — v0.5 stub expected', async () => {
  const stamp = Date.now();
  await call(HERMES, 'worktracker_create_item', { kind: 'task', title: `reminder-fixture-${stamp}` });
  let target: any;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 250));
    const list = await call(HERMES, 'worktracker_list_items', { limit: 50 });
    const items = list.body?.items ?? list.body?.value?.items ?? [];
    target = items.find((it: any) => it.title === `reminder-fixture-${stamp}`);
    if (target) break;
  }
  if (!target) {
    console.log('  fixture did not materialize — skip');
    skipped.push('set_reminder');
    return;
  }
  const r = await call(HERMES, 'worktracker_set_reminder', {
    item_id: target.id, remind_at: '2026-12-31T00:00:00.000Z', channel: 'telegram', target: 'me',
  });
  assert.equal(r.http, 200, `set_reminder: ${short(r)}`);
  if (!r.body?.accepted) {
    console.log(`  set_reminder returned ${short(r)} (expected v0.5 stub)`);
  }
  tested.push('set_reminder');
});

test('write: enrich (hermes) — v0 stretch', async () => {
  const stamp = Date.now();
  await call(HERMES, 'worktracker_create_item', { kind: 'task', title: `enrich-fixture-${stamp}` });
  let target: any;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 250));
    const list = await call(HERMES, 'worktracker_list_items', { limit: 50 });
    const items = list.body?.items ?? list.body?.value?.items ?? [];
    target = items.find((it: any) => it.title === `enrich-fixture-${stamp}`);
    if (target) break;
  }
  if (!target) {
    console.log('  fixture did not materialize — skip');
    skipped.push('enrich');
    return;
  }
  const r = await call(HERMES, 'worktracker_enrich', {
    id: target.id, stage: 'grill', enricher: 'default',
  });
  assert.equal(r.http, 200, `enrich: ${short(r)}`);
  tested.push('enrich');
});

// ===== ADMIN TOOLS (3) =====
test('admin: create_board / update_board / delete_board (hermes allowlisted)', async () => {
  const stamp = Date.now();
  const c = await call(HERMES, 'worktracker_create_board', {
    name: `full-matrix-${stamp}`, columns: [{ id: 'todo', label: 'T', statuses: ['open'] }],
  });
  assert.equal(c.http, 200, `create_board: ${short(c)}`);
  const boardId = c.body?.board?.id ?? c.body?.value?.board?.id;
  if (boardId) {
    const u = await call(HERMES, 'worktracker_update_board', { id: boardId, description: 'matrix' });
    assert.equal(u.http, 200, `update_board: ${short(u)}`);
    const d = await call(HERMES, 'worktracker_delete_board', { id: boardId });
    assert.equal(d.http, 200, `delete_board: ${short(d)}`);
  }
  tested.push('create_board', 'update_board', 'delete_board');
});

// ===== NEGATIVE PATHS =====
test('negative: unknown source cannot call admin tools', async () => {
  for (const tool of ['worktracker_create_board', 'worktracker_update_board', 'worktracker_delete_board']) {
    const args = tool === 'worktracker_create_board'
      ? { name: `neg-${Date.now()}`, columns: [{ id: 'todo', label: 'T', statuses: ['open'] }] }
      : { id: SEED_BOARD_ID };
    const r = await call(UNKNOWN, tool, args);
    assert.equal(r.body?.ok, false, `unknown ${tool}: ${short(r)}`);
    assert.match(r.body?.error ?? '', /admin/, `unknown ${tool} error: ${short(r)}`);
  }
});

test('negative: bad tool name returns -32601', async () => {
  const r = await call(HERMES, 'worktracker_nonexistent_tool', {});
  assert.equal(r.http, 200, `bad tool http: ${short(r)}`);
  // JSON-RPC error code -32601 = method not found
  assert.equal(r.body?._jsonRpcCode, -32601, `bad tool code: ${short(r)}`);
});

test('negative: invalid params returns -32602', async () => {
  // create_item without required `kind` and `title`
  const r = await call(HERMES, 'worktracker_create_item', { foo: 'bar' });
  assert.equal(r.http, 200, `invalid params http: ${short(r)}`);
  assert.equal(r.body?._jsonRpcCode, -32602, `invalid params code: ${short(r)}`);
});

// ===== SUMMARY =====
test('summary: tool coverage', async () => {
  const all = [
    'list_items', 'get_item', 'list_boards', 'get_board',
    'create_item', 'update_item', 'transition', 'comment', 'link_items', 'dispatch',
    'set_reminder', 'enrich',
    'create_board', 'update_board', 'delete_board',
  ];
  const untested = all.filter(t => !tested.includes(t));
  console.log(`\n  tested (${tested.length}/15): ${tested.join(', ')}`);
  if (skipped.length) console.log(`  skipped (${skipped.length}): ${skipped.join(', ')}`);
  if (untested.length) console.log(`  UNTESTED (${untested.length}): ${untested.join(', ')}`);
  assert.equal(untested.length, 0, `untested tools: ${untested.join(', ')}`);
});
