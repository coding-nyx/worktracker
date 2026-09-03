/**
 * Analytics routes — slice 6 + 7.
 *
 * The collection `analytics/call_traces/{id}` is written by the
 * dispatcher (see analytics.ts). This route reads it back for
 * the admin analytics page. 30-day TTL on each doc; the page
 * pages backward from `now`.
 *
 * Admin only — these traces include the bearer_id, which the
 * bearer sees in their own introspect response, but the
 * broader surface (which calls came from which agent) is an
 * operator concern.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { getDb } from '../firestore.js';
import type { CallTraceDoc } from '../analytics.js';

const ListQuery = z.object({
  outcome: z.enum(['success', 'auth_failed', 'unreachable', 'server_error', 'client_error']).optional(),
  agent: z.string().optional(),
  tool: z.string().optional(),
  bearer_id: z.string().optional(),
  /** 'true' to include error details; default is summary only. */
  with_errors: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export interface ListCallTracesResponse {
  traces: CallTraceDoc[];
  next_cursor: string | null;
  /** Cheap aggregate counts so the page can render a header without a second call. */
  summary: {
    total: number;
    success: number;
    auth_failed: number;
    server_error: number;
    client_error: number;
  };
}

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/analytics/call-traces', { preHandler: requireAdmin }, async (req) => {
    const q = ListQuery.parse(req.query);
    let ref = getDb()
      .collection('analytics/call_traces')
      .orderBy('ts', 'desc')
      .limit(q.limit);
    if (q.outcome) ref = ref.where('outcome', '==', q.outcome) as never;
    if (q.agent) ref = ref.where('agent', '==', q.agent) as never;
    if (q.tool) ref = ref.where('tool', '==', q.tool) as never;
    if (q.bearer_id) ref = ref.where('bearer_id', '==', q.bearer_id) as never;
    if (q.cursor) {
      const cursorSnap = await getDb()
        .collection('analytics/call_traces')
        .doc(q.cursor)
        .get();
      if (cursorSnap.exists) ref = ref.startAfter(cursorSnap) as never;
    }
    const snap = await ref.get();
    const traces: CallTraceDoc[] = snap.docs.map((d) => d.data() as CallTraceDoc);
    if (!q.with_errors) {
      // Strip the request body so the list view doesn't echo
      // full MCP call payloads back to the admin browser. The
      // detail drill-in (a future slice) can fetch one doc by
      // id and surface the full body.
      for (const t of traces) {
        if (t.request?.body) t.request.body = '[truncated]';
      }
    }
    const next_cursor = traces.length === q.limit ? traces[traces.length - 1]?.id ?? null : null;
    // Aggregate summary: count by outcome over the same window.
    // We do this with a second query that scans up to 500 docs;
    // a real Firestore deployment would use a counter doc, but
    // v0 stays in a single collection read.
    const allSnap = await getDb()
      .collection('analytics/call_traces')
      .orderBy('ts', 'desc')
      .limit(500)
      .get();
    const summary = { total: 0, success: 0, auth_failed: 0, server_error: 0, client_error: 0 };
    for (const d of allSnap.docs) {
      const t = d.data() as CallTraceDoc;
      summary.total += 1;
      if (t.outcome === 'success') summary.success += 1;
      else if (t.outcome === 'auth_failed') summary.auth_failed += 1;
      else if (t.outcome === 'server_error') summary.server_error += 1;
      else if (t.outcome === 'client_error') summary.client_error += 1;
    }
    return { traces, next_cursor, summary } satisfies ListCallTracesResponse;
  });

  app.get('/api/analytics/call-traces/summary', { preHandler: requireAdmin }, async () => {
    const snap = await getDb()
      .collection('analytics/call_traces')
      .orderBy('ts', 'desc')
      .limit(500)
      .get();
    const summary = { total: 0, success: 0, auth_failed: 0, server_error: 0, client_error: 0 };
    for (const d of snap.docs) {
      const t = d.data() as CallTraceDoc;
      summary.total += 1;
      if (t.outcome === 'success') summary.success += 1;
      else if (t.outcome === 'auth_failed') summary.auth_failed += 1;
      else if (t.outcome === 'server_error') summary.server_error += 1;
      else if (t.outcome === 'client_error') summary.client_error += 1;
    }
    return { summary };
  });
}
