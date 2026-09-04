/**
 * Analytics routes — slice 6 + 7 + 12.
 *
 *   GET    /api/analytics/call-traces                  paginated list
 *   GET    /api/analytics/call-traces/summary          single counter rollup
 *   GET    /api/analytics/call-traces/series           day-bucketed counts
 *   GET    /api/analytics/call-traces/agents            per-agent breakdown
 *   GET    /api/analytics/call-traces.csv              CSV export
 *
 * All endpoints are admin-only. The collection
 * `analytics/call_traces/{id}` is written by the dispatcher
 * (see analytics.ts). 30-day TTL on each doc; the page pages
 * backward from `now`.
 *
 * The page surface goes wide: list + summary rollup + per-day
 * time series + per-agent breakdown + CSV export. The list
 * includes the full request body when `with_errors=true`;
 * otherwise request bodies are stripped to `[truncated]` so
 * the operator doesn't accidentally echo a 1 MB MCP payload
 * into a list response.
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

const SummaryWindow = z.enum(['24h', '7d', '30d']).default('7d');

const SummaryQuery = z.object({
  window: SummaryWindow.optional(),
});

const SeriesQuery = z.object({
  /** Number of days to roll up. Default 14, max 30. */
  days: z.coerce.number().int().min(1).max(30).default(14),
});

const CsvQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  outcome: z.enum(['success', 'auth_failed', 'unreachable', 'server_error', 'client_error']).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
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

export interface AnalyticsSummary {
  window: '24h' | '7d' | '30d';
  total: number;
  success: number;
  success_rate: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  outcomes: {
    success: number;
    auth_failed: number;
    server_error: number;
    client_error: number;
    unreachable: number;
  };
  by_agent: { agent: string; total: number; success: number }[];
}

export interface AnalyticsSeriesPoint {
  date: string; // YYYY-MM-DD
  total: number;
  success: number;
  error: number;
}

export interface AnalyticsSeries {
  days: number;
  points: AnalyticsSeriesPoint[];
}

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/analytics/call-traces', { preHandler: requireAdmin }, async (req) => {
    const q = ListQuery.parse(req.query);
    let ref = getDb()
      .collection('analytics')
      .orderBy('ts', 'desc')
      .limit(q.limit);
    if (q.outcome) ref = ref.where('outcome', '==', q.outcome) as never;
    if (q.agent) ref = ref.where('agent', '==', q.agent) as never;
    if (q.tool) ref = ref.where('tool', '==', q.tool) as never;
    if (q.bearer_id) ref = ref.where('bearer_id', '==', q.bearer_id) as never;
    if (q.cursor) {
      const cursorSnap = await getDb()
        .collection('analytics')
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
      .collection('analytics')
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

  // Slice 12: rollup over a time window. The window bounds the
  // query (Firestore `ts >= cutoff`); outcomes are counted
  // client-side over the result set. Latency percentiles are
  // computed the same way. The whole thing is bounded by 1000
  // docs (Firestore in-memory sort) — for a real production
  // deployment we'd back this with a counter doc or BigQuery
  // export; v0 stays inside a single collection read.
  app.get('/api/analytics/summary', { preHandler: requireAdmin }, async (req) => {
    const q = SummaryQuery.parse(req.query);
    const windowMs = q.window === '24h' ? 24 * 3600_000 : q.window === '7d' ? 7 * 86_400_000 : 30 * 86_400_000;
    const cutoff = new Date(Date.now() - windowMs);
    const snap = await getDb()
      .collection('analytics')
      .where('ts', '>=', cutoff.toISOString())
      .orderBy('ts', 'desc')
      .limit(1000)
      .get();
    const docs = snap.docs.map((d) => d.data() as CallTraceDoc);
    const total = docs.length;
    const success = docs.filter((t) => t.outcome === 'success').length;
    const success_rate = total === 0 ? 0 : success / total;
    const latencies = docs
      .map((t) => t.response?.latency_ms)
      .filter((n): n is number => typeof n === 'number')
      .sort((a, b) => a - b);
    const pct = (p: number): number => {
      if (latencies.length === 0) return 0;
      const idx = Math.min(latencies.length - 1, Math.floor(p * latencies.length));
      return latencies[idx];
    };
    const outcomes = {
      success,
      auth_failed: docs.filter((t) => t.outcome === 'auth_failed').length,
      server_error: docs.filter((t) => t.outcome === 'server_error').length,
      client_error: docs.filter((t) => t.outcome === 'client_error').length,
      unreachable: docs.filter((t) => t.outcome === 'unreachable').length,
    };
    // Per-agent rollup: only the top 10 by total volume.
    const byAgentMap = new Map<string, { agent: string; total: number; success: number }>();
    for (const t of docs) {
      const cur = byAgentMap.get(t.agent) ?? { agent: t.agent, total: 0, success: 0 };
      cur.total += 1;
      if (t.outcome === 'success') cur.success += 1;
      byAgentMap.set(t.agent, cur);
    }
    const by_agent = Array.from(byAgentMap.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);
    return {
      window: q.window ?? '7d',
      total,
      success,
      success_rate,
      p50_latency_ms: pct(0.5),
      p95_latency_ms: pct(0.95),
      outcomes,
      by_agent,
    } satisfies AnalyticsSummary;
  });

  // Slice 12: per-day time series. Each point is one day; the
  // page renders this as a stacked area (inline SVG, no chart
  // lib). The series is bounded to `days` so it stays cheap.
  app.get('/api/analytics/series', { preHandler: requireAdmin }, async (req) => {
    const q = SeriesQuery.parse(req.query);
    const cutoff = new Date(Date.now() - q.days * 86_400_000);
    const snap = await getDb()
      .collection('analytics')
      .where('ts', '>=', cutoff.toISOString())
      .orderBy('ts', 'desc')
      .limit(2000)
      .get();
    const docs = snap.docs.map((d) => d.data() as CallTraceDoc);
    const buckets = new Map<string, AnalyticsSeriesPoint>();
    // Pre-fill so every day in the window shows up even if
    // there were zero calls that day.
    for (let i = q.days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      buckets.set(key, { date: key, total: 0, success: 0, error: 0 });
    }
    for (const t of docs) {
      const key = (t.ts ?? '').slice(0, 10);
      if (!key) continue;
      const cur = buckets.get(key) ?? { date: key, total: 0, success: 0, error: 0 };
      cur.total += 1;
      if (t.outcome === 'success') cur.success += 1;
      else cur.error += 1;
      buckets.set(key, cur);
    }
    const points = Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
    return { days: q.days, points } satisfies AnalyticsSeries;
  });

  // Slice 12: per-agent drilldown. Same shape as the by_agent
  // field in /summary, but as a top-level response so the
  // page can show it independently.
  app.get('/api/analytics/agents', { preHandler: requireAdmin }, async (req) => {
    const q = SummaryQuery.parse(req.query);
    const windowMs = q.window === '24h' ? 24 * 3600_000 : q.window === '7d' ? 7 * 86_400_000 : 30 * 86_400_000;
    const cutoff = new Date(Date.now() - windowMs);
    const snap = await getDb()
      .collection('analytics')
      .where('ts', '>=', cutoff.toISOString())
      .orderBy('ts', 'desc')
      .limit(2000)
      .get();
    const docs = snap.docs.map((d) => d.data() as CallTraceDoc);
    const byAgent = new Map<string, { agent: string; total: number; success: number; error: number; p95_latency_ms: number }>();
    for (const t of docs) {
      const cur = byAgent.get(t.agent) ?? { agent: t.agent, total: 0, success: 0, error: 0, p95_latency_ms: 0 };
      cur.total += 1;
      if (t.outcome === 'success') cur.success += 1;
      else cur.error += 1;
      byAgent.set(t.agent, cur);
    }
    // Compute p95 per agent from the same doc set.
    const latenciesByAgent = new Map<string, number[]>();
    for (const t of docs) {
      if (typeof t.response?.latency_ms === 'number') {
        const list = latenciesByAgent.get(t.agent) ?? [];
        list.push(t.response.latency_ms);
        latenciesByAgent.set(t.agent, list);
      }
    }
    for (const [agent, list] of latenciesByAgent) {
      list.sort((a, b) => a - b);
      const cur = byAgent.get(agent);
      if (!cur) continue;
      const idx = Math.min(list.length - 1, Math.floor(0.95 * list.length));
      cur.p95_latency_ms = list[idx] ?? 0;
    }
    return {
      window: q.window,
      agents: Array.from(byAgent.values()).sort((a, b) => b.total - a.total),
    };
  });

  // Slice 12: CSV export. The body is plain text/csv with the
  // usual fields. `from` / `to` are ISO date filters; `outcome`
  // narrows by outcome. Capped at 5000 rows so a single click
  // doesn't pull a million docs into memory.
  app.get('/api/analytics/call-traces.csv', { preHandler: requireAdmin }, async (req, reply) => {
    const q = CsvQuery.parse(req.query);
    let ref = getDb().collection('analytics').orderBy('ts', 'desc').limit(q.limit);
    if (q.outcome) ref = ref.where('outcome', '==', q.outcome) as never;
    if (q.from) ref = ref.where('ts', '>=', q.from) as never;
    if (q.to) ref = ref.where('ts', '<=', q.to) as never;
    const snap = await ref.get();
    const rows: string[] = [
      'ts,agent,bearer_id,tool,outcome,method,path,status,latency_ms,error_code,error_message',
    ];
    for (const d of snap.docs) {
      const t = d.data() as CallTraceDoc;
      const cells = [
        t.ts,
        t.agent,
        t.bearer_id,
        t.tool ?? '',
        t.outcome,
        t.request?.method ?? '',
        t.request?.path ?? '',
        t.response?.status?.toString() ?? '',
        t.response?.latency_ms?.toString() ?? '',
        t.error?.code?.toString() ?? '',
        t.error?.message ?? '',
      ].map(csvCell);
      rows.push(cells.join(','));
    }
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="worktracker-call-traces.csv"');
    return reply.send(rows.join('\n'));
  });

  app.get('/api/analytics/call-traces/summary', { preHandler: requireAdmin }, async () => {
    const snap = await getDb()
      .collection('analytics')
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

/**
 * RFC-4180-ish CSV cell: wrap in quotes if the value contains
 * a comma, quote, or newline; double-up any embedded quotes.
 */
function csvCell(v: string): string {
  if (/[",\n\r]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}
