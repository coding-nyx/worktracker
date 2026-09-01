/**
 * Unit tests for `getEffectiveScope` / `hasScopeAtLeast` /
 * `requireScopeAtLeast`. Pure functions over `req.auth` — no
 * Firestore needed.
 *
 * Run with:
 *   cd apps/api && npx tsx tests/scope.test.ts
 *
 * Or under the project test runner:
 *   npm --workspace=@worktracker/api test
 *
 * Why this test: the legacy-source allowlist is the security
 * boundary between "unknown MCP client with a stale bearer" and
 * "an MCP client we explicitly trust". A regression here means
 * either we lock out a real client OR we let an attacker escalate.
 * Both classes of bug are silent — they only show up at the call
 * site. Test it directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyRequest } from 'fastify';

// `loadConfig` reads env at import time. Set defaults before the
// import so the allowlist is stable across runs.
process.env.WORKTRACKER_ENV ??= 'local';
// Default allowlist when WORKTRACKER_ADMIN_SOURCES is unset:
// ['hermes', 'claude', 'codex']. Don't override here.

import { getEffectiveScope, hasScopeAtLeast } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();
console.log(`allowlist in effect for this test run: ${cfg.adminSources.join(', ')}`);

function reqWith(auth: unknown): FastifyRequest {
  // The auth helpers only read `req.auth`, so a barebones stub
  // is enough. Cast through `unknown` to bypass Fastify's strict
  // request typing.
  return { auth } as unknown as FastifyRequest;
}

test('admin token -> admin', () => {
  assert.equal(getEffectiveScope(reqWith({ kind: 'admin' })), 'admin');
  assert.equal(hasScopeAtLeast(reqWith({ kind: 'admin' }), 'admin'), true);
});

test('web source -> admin', () => {
  assert.equal(
    getEffectiveScope(reqWith({ kind: 'source', source: { name: 'web', enabled: true } })),
    'admin',
  );
});

test('firebase user with is_admin=true -> admin', () => {
  assert.equal(
    getEffectiveScope(reqWith({ kind: 'user', user: { is_admin: true } } as any)),
    'admin',
  );
});

test('legacy source bearer on allowlist -> admin', () => {
  // The whole reason this test exists.
  for (const name of cfg.adminSources) {
    const scope = getEffectiveScope(reqWith({ kind: 'source', source: { name, enabled: true } }));
    assert.equal(scope, 'admin', `expected ${name} -> admin, got ${scope}`);
  }
});

test('legacy source bearer NOT on allowlist -> read_write', () => {
  const scope = getEffectiveScope(reqWith({ kind: 'source', source: { name: 'unknown-bot', enabled: true } }));
  assert.equal(scope, 'read_write', `unknown-bot must be read_write, got ${scope}`);
});

test('disabled source on allowlist -> read_write (belt + braces)', () => {
  // Even an allowlisted source that someone disabled should not
  // silently get admin scope back; requireSource would 403 it
  // upstream but if that gate fails we want this check to fail
  // closed.
  for (const name of cfg.adminSources) {
    const scope = getEffectiveScope(reqWith({ kind: 'source', source: { name, enabled: false } }));
    assert.equal(scope, 'read_write', `disabled ${name} must NOT be admin, got ${scope}`);
  }
});

test('api token with explicit scope -> that scope', () => {
  assert.equal(
    getEffectiveScope(reqWith({ kind: 'source', source: { name: 'random', enabled: true }, scope: 'read' })),
    'read',
  );
  assert.equal(
    getEffectiveScope(reqWith({ kind: 'source', source: { name: 'random', enabled: true }, scope: 'admin' })),
    'admin',
  );
});

test('rank ordering: read < read_write < admin', () => {
  const read = reqWith({ kind: 'source', source: { name: 'unknown', enabled: true }, scope: 'read' });
  const rw = reqWith({ kind: 'source', source: { name: 'unknown', enabled: true }, scope: 'read_write' });
  const admin = reqWith({ kind: 'admin' });
  assert.equal(hasScopeAtLeast(read, 'read'), true);
  assert.equal(hasScopeAtLeast(read, 'read_write'), false);
  assert.equal(hasScopeAtLeast(read, 'admin'), false);
  assert.equal(hasScopeAtLeast(rw, 'read'), true);
  assert.equal(hasScopeAtLeast(rw, 'read_write'), true);
  assert.equal(hasScopeAtLeast(rw, 'admin'), false);
  assert.equal(hasScopeAtLeast(admin, 'admin'), true);
});

test('WORKTRACKER_ADMIN_SOURCES override is honored', () => {
  // Mutate env and reload config; the parser is the only thing
  // being tested here (the override path is in config.ts, not
  // auth.ts — auth.ts just reads `loadConfig().adminSources`).
  process.env.WORKTRACKER_ADMIN_SOURCES = 'custom-bot,other-bot,hermes';
  const cfg2 = loadConfig();
  assert.deepEqual(cfg2.adminSources, ['custom-bot', 'other-bot', 'hermes']);
  delete process.env.WORKTRACKER_ADMIN_SOURCES;
  const cfg3 = loadConfig();
  assert.deepEqual(cfg3.adminSources, ['hermes', 'claude', 'codex']);
});
