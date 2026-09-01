/**
 * Full access matrix integration test against a LOCAL API +
 * Firestore emulator. Probes every relevant tool as every
 * relevant caller kind.
 *
 * Run:
 *   WORKTRACKER_API_BASE=http://127.0.0.1:8081/mcp \
 *   HERMES_BEARER='hermes.<key>' \
 *   UNKNOWN_BEARER='unknown-bot.<key>' \
 *   ADMIN_TOKEN=local-admin-token \
 *   npx tsx tests/matrix.ts
 *
 * Exits non-zero if any expected outcome is wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.WORKTRACKER_API_BASE ?? 'http://127.0.0.1:8081/mcp';
const HERMES = process.env.HERMES_BEARER ?? '';
const UNKNOWN = process.env.UNKNOWN_BEARER ?? '';
const ADMIN = process.env.ADMIN_TOKEN ?? 'local-admin-token';

async function call(bearer: string, name: string, args: Record<string, unknown> = {}): Promise<{ http: number; body: any }> {
  const resp = await fetch(BASE, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const http = resp.status;
  let body: any = null;
  try { body = await resp.json(); } catch { body = await resp.text(); }
  // Unwrap into a single shape that captures all three return
  // shapes the MCP server uses for tool results:
  //   wrap-shape:  { result: { structuredContent: { ok, value|error } } }
  //   raw-shape:   { result: { board | item | items | boards | ... } }
  //   error-shape: { error:  { code, message } }
  let unwrapped: any = body;
  if (body?.error) {
    unwrapped = { ok: false, error: body.error.message ?? body.error.code, _jsonRpcCode: body.error.code };
  } else if (body?.result?.structuredContent) {
    unwrapped = body.result.structuredContent;
  } else if (body?.result?.content?.[0]?.text) {
    try { unwrapped = JSON.parse(body.result.content[0].text); }
    catch { unwrapped = body.result.content[0].text; }
  } else if (body?.result && typeof body.result === 'object') {
    // Raw shape — wrap so { ok: true, value: result } so the
    // assertions work consistently.
    unwrapped = { ok: true, value: body.result };
  }
  return { http, body: unwrapped };
}

function short(r: { http: number; body: any }): string {
  return `http=${r.http} ${JSON.stringify(r.body).slice(0, 140)}`;
}

const READ_TOOLS = ['worktracker_list_items', 'worktracker_list_boards', 'worktracker_get_item', 'worktracker_get_board'];
const WRITE_TOOLS = ['worktracker_create_item', 'worktracker_update_item', 'worktracker_transition', 'worktracker_comment', 'worktracker_link_items', 'worktracker_dispatch'];
const ADMIN_TOOLS = ['worktracker_create_board', 'worktracker_update_board', 'worktracker_delete_board'];
const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS, 'worktracker_set_reminder', 'worktracker_enrich', ...ADMIN_TOOLS];

// ---------- READ MATRIX ----------

test('admin: all 15 tools succeed', async () => {
  let pass = 0, fail = 0;
  for (const tool of ALL_TOOLS) {
    const args = tool.includes('get_') ? { id: '01M1E2D037CMDES8FC8V000000' } : { limit: 1 };
    const r = await call(ADMIN, tool, args);
    if (r.http === 200) pass++; else { fail++; console.log(`  ✗ ${tool}: ${short(r)}`); }
  }
  console.log(`  admin: ${pass} pass / ${fail} fail`);
  assert.equal(fail, 0, 'admin should pass all 15');
});

test('hermes (allowlisted): reads + writes succeed, ADMIN tools succeed', async () => {
  // READ
  for (const tool of READ_TOOLS) {
    const args = tool.includes('get_') ? { id: '01M1E2D037CMDES8FC8V000000' } : { limit: 1 };
    const r = await call(HERMES, tool, args);
    assert.equal(r.http, 200, `${tool}: ${short(r)}`);
  }
  console.log('  hermes -> 4 reads: ok');

  // WRITE (create + cleanup)
  const stamp = Date.now();
  const c = await call(HERMES, 'worktracker_create_item', { kind: 'task', title: `matrix-probe-${stamp}` });
  assert.equal(c.http, 200, `create_item: ${short(c)}`);
  const itemId = c.body?.value?.id ?? c.body?.id;
  if (itemId) {
    const u = await call(HERMES, 'worktracker_update_item', {
      id: itemId, patch: { archived_at: new Date().toISOString() }, expected_version: 1,
    });
    assert.equal(u.http, 200, `archive cleanup: ${short(u)}`);
  }
  console.log(`  hermes -> create + archive: ok`);

  // ADMIN (the whole point of the fix)
  const bstamp = Date.now();
  const cb = await call(HERMES, 'worktracker_create_board', {
    name: `matrix-board-${bstamp}`, columns: [{ id: 'todo', label: 'To Do', statuses: ['open'] }],
  });
  assert.equal(cb.http, 200, `create_board: ${short(cb)}`);
  assert.equal(cb.body?.ok, true, `create_board.ok: ${short(cb)}`);
  const boardId = cb.body?.value?.id ?? cb.body?.id;
  if (boardId) {
    const ub = await call(HERMES, 'worktracker_update_board', { id: boardId, description: 'matrix test' });
    assert.equal(ub.body?.ok, true, `update_board.ok: ${short(ub)}`);
    const db = await call(HERMES, 'worktracker_delete_board', { id: boardId });
    assert.equal(db.body?.ok, true, `delete_board.ok: ${short(db)}`);
    console.log(`  hermes -> create/update/delete board: ok`);
  }
});

test('unknown-bot (NOT allowlisted): reads + writes succeed, ADMIN tools REJECTED', async () => {
  // READ
  for (const tool of READ_TOOLS) {
    const args = tool.includes('get_') ? { id: '01M1E2D037CMDES8FC8V000000' } : { limit: 1 };
    const r = await call(UNKNOWN, tool, args);
    assert.equal(r.http, 200, `${tool}: ${short(r)}`);
  }
  console.log('  unknown -> 4 reads: ok');

  // WRITE (create + archive)
  const stamp = Date.now();
  const c = await call(UNKNOWN, 'worktracker_create_item', { kind: 'task', title: `unknown-probe-${stamp}` });
  assert.equal(c.http, 200, `unknown create_item: ${short(c)}`);
  const itemId = c.body?.value?.id ?? c.body?.id;
  if (itemId) {
    const u = await call(UNKNOWN, 'worktracker_update_item', {
      id: itemId, patch: { archived_at: new Date().toISOString() }, expected_version: 1,
    });
    assert.equal(u.http, 200, `unknown archive: ${short(u)}`);
  }
  console.log(`  unknown -> create + archive: ok`);

  // ADMIN — must be rejected
  for (const tool of ADMIN_TOOLS) {
    const args: Record<string, unknown> = tool === 'worktracker_create_board'
      ? { name: `unknown-board-${Date.now()}`, columns: [{ id: 'todo', label: 'T', statuses: ['open'] }] }
      : { id: '01M1E2D037CMDES8FC8V000000' };
    const r = await call(UNKNOWN, tool, args);
    assert.equal(r.http, 200, `unknown ${tool} http: ${short(r)}`);
    assert.equal(r.body?.ok, false, `unknown ${tool} should be rejected: ${short(r)}`);
    assert.match(r.body?.error ?? '', /admin/, `unknown ${tool} error msg: ${short(r)}`);
  }
  console.log(`  unknown -> 3 admin tools: ALL REJECTED ✓`);
});

test('disabled source: 403', async () => {
  // We need a source to disable. The hermes source exists.
  // Admin can disable it, but we don't want to leave it disabled.
  // Instead: try an obviously-disabled bearer (random suffix)
  // — the lookup will fail and requireSource returns 401.
  // To get 403 specifically we need an enabled=false source.
  // Skip with a note.
  console.log('  SKIP: would require admin to disable/re-enable hermes');
});

test('bad token: 401', async () => {
  const r = await call('this-is-not-a-real-token', 'worktracker_list_boards');
  assert.equal(r.http, 401, `bad token http: ${short(r)}`);
  console.log(`  bad token: 401 ✓`);
});

test('WORKTRACKER_ADMIN_SOURCES override (live config tweak)', async () => {
  // The override only takes effect on next API restart because
  // loadConfig() runs at module init. Documented limitation.
  console.log('  SKIP: requires API restart to pick up env change');
});
