/**
 * Call-trace analytics (slice 6).
 *
 * Every MCP tool call writes a row to
 * `analytics/call_traces/{trace_id}` with a 30-day TTL.
 * The collection is the data source for the /admin/analytics
 * page (slice 7): a list of recent calls with their agent,
 * bearer, latency, and outcome, sortable by status code.
 *
 * Document shape (architecture §3.7):
 *   {
 *     id:         ULID,
 *     ts:         iso,
 *     agent:      'claude-code' | 'codex' | '...' | 'unknown',
 *     bearer_id:  string,                 // 'clients/{name}' or 'users/{uid}', never the secret
 *     context:    'mcp_call' | 'mcp_list' | 'webhook_in' | 'webhook_out' | 'wizard_test',
 *     request:  { method, path, body, headers },
 *     response: { status, body, latency_ms },  // on success
 *     error:    { code, message, retryable },  // on failure
 *     outcome:  'success' | 'auth_failed' | 'unreachable' | 'server_error' | 'client_error',
 *   }
 *
 * The 30-day TTL is set on each doc write (firestore `expireAt`
 * field). The 30 days cover the standard "what happened last
 * week / last month" debugging window; older traces fall off.
 */

import { ulid, nowIso } from './ids.js';
import { getDb } from './firestore.js';

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type TraceContext = 'mcp_call' | 'mcp_list' | 'webhook_in' | 'webhook_out' | 'wizard_test';
export type TraceOutcome = 'success' | 'auth_failed' | 'unreachable' | 'server_error' | 'client_error';

export interface CallTraceDoc {
  id: string;
  ts: string;
  /** A short tag the analytics page filters by. */
  agent: string;
  /** The bearer's stable id, never the secret. */
  bearer_id: string;
  context: TraceContext;
  tool?: string;
  request: { method: string; path: string; body?: unknown };
  response?: { status: number; latency_ms: number };
  error?: { code: number; message: string; retryable: boolean };
  outcome: TraceOutcome;
  /** When the doc expires (Firestore TTL field). */
  expireAt: Date;
}

/**
 * Record a call trace. `outcome` decides which side of the
 * (response | error) union is populated; the other is omitted.
 *
 * The Firestore `expireAt` field is a Date — the Cloud
 * Functions / scheduled job that enforces TTLs picks it up
 * and deletes the doc at that time.
 */
export async function recordCallTrace(input: {
  agent: string;
  bearer_id: string;
  context: TraceContext;
  tool?: string;
  request: { method: string; path: string; body?: unknown };
  outcome: TraceOutcome;
  response?: { status: number; latency_ms: number };
  error?: { code: number; message: string; retryable: boolean };
}): Promise<void> {
  const id = ulid();
  const now = nowIso();
  const doc: CallTraceDoc = {
    id,
    ts: now,
    agent: input.agent,
    bearer_id: input.bearer_id,
    context: input.context,
    ...(input.tool ? { tool: input.tool } : {}),
    request: input.request,
    ...(input.response ? { response: input.response } : {}),
    ...(input.error ? { error: input.error } : {}),
    outcome: input.outcome,
    expireAt: new Date(Date.now() + TTL_MS),
  };
  await getDb().collection('analytics/call_traces').doc(id).set(doc);
}

/**
 * Map a dispatch result to a (outcome, error) pair. The
 * dispatcher returns `ok: true` for any tool that the catalog
 * advertised to the caller; anything else is one of:
 *   - 401 / scope mismatch → auth_failed
 *   - -32601 (unknown tool) → client_error
 *   - -32602 (bad args) → client_error
 *   - -32603 (handler throw) → server_error
 */
export function mapDispatchOutcome(
  ok: boolean,
  code: number | undefined,
  errMessage?: string,
): { outcome: TraceOutcome; error?: { code: number; message: string; retryable: boolean } } {
  if (ok) return { outcome: 'success' };
  const c = code ?? -32603;
  if (c === -32601 || c === -32602) {
    return { outcome: 'client_error', error: { code: c, message: errMessage ?? 'client error', retryable: false } };
  }
  if (c === 401 || c === 403) {
    return { outcome: 'auth_failed', error: { code: c, message: errMessage ?? 'unauthenticated', retryable: false } };
  }
  return { outcome: 'server_error', error: { code: c, message: errMessage ?? 'internal error', retryable: true } };
}
