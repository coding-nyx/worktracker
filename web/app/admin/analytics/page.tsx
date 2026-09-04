'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { Pill } from '../../../components/Pill';
import { EmptyState } from '../../../components/EmptyState';

type Window = '24h' | '7d' | '30d';

/**
 * /admin/analytics — slice 12.
 *
 * Header strip: total calls + success rate + p50/p95 latency
 * over the active window.
 *
 * Time-series chart: per-day stacked counts over the last
 * 14 days, rendered as inline SVG (no chart library).
 *
 * Per-agent cards: top 10 agents by call volume in the window,
 * with success rate and p95.
 *
 * Trace list: the existing 200-row table, paginated by outcome.
 *
 * CSV export: download the active window as a CSV file.
 *
 * Admin only. Refetched every 10 seconds.
 */
export default function AnalyticsPage() {
  const auth = useAuth();
  const [window, setWindow] = useState<Window>('7d');
  const [outcome, setOutcome] = useState<string>('');

  const enabled = !!auth.firebaseUser && !!auth.isAdmin;

  const { data: summary, isLoading: sLoading } = useQuery({
    queryKey: ['analytics', 'summary', window],
    queryFn: () => api.analyticsSummary({ window }),
    enabled,
    refetchInterval: 10_000,
  });
  const { data: series, isLoading: seriesLoading } = useQuery({
    queryKey: ['analytics', 'series'],
    queryFn: () => api.analyticsSeries({ days: 14 }),
    enabled,
    refetchInterval: 30_000,
  });
  const { data: agents, isLoading: agentsLoading } = useQuery({
    queryKey: ['analytics', 'agents', window],
    queryFn: () => api.analyticsAgents({ window }),
    enabled,
    refetchInterval: 30_000,
  });
  const { data, isLoading, error } = useQuery({
    queryKey: ['analytics', 'traces', outcome],
    queryFn: () => api.listCallTraces({ outcome: outcome || undefined, limit: 200 }),
    enabled,
    refetchInterval: 10_000,
  });

  if (!auth.firebaseUser) {
    return <p className="text-[13px] text-ink-3">Sign in to view analytics.</p>;
  }
  if (!auth.isAdmin) {
    return (
      <div className="card space-y-2 p-5">
        <h1 className="text-[15px] font-semibold text-ink-1">Analytics</h1>
        <p className="text-[13px] text-ink-2">Admin only.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">// analytics</p>
          <h1 className="text-2xl font-bold tracking-tight text-ink-1">Call traces</h1>
          <p className="text-[13px] text-ink-2">
            The last 30 days of MCP tool calls. One row per <code className="rounded bg-bg-sunken px-1 py-0.5 font-mono text-[11.5px]">tools/call</code>; 30-day TTL.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-border-subtle bg-bg-sunken/40 p-0.5">
            {(['24h', '7d', '30d'] as const).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWindow(w)}
                className={`rounded-md px-2.5 py-1 text-[12px] transition-colors ${
                  window === w
                    ? 'bg-bg-surface text-ink-1 shadow-sm'
                    : 'text-ink-3 hover:text-ink-1'
                }`}
              >
                {w}
              </button>
            ))}
          </div>
          <a
            href={api.analyticsCsvUrl({})}
            className="btn-secondary focus-ring"
            download
          >
            Export CSV
          </a>
        </div>
      </header>

      {/* Header strip */}
      {summary ? (
        <SummaryStrip
          total={summary.total}
          success={summary.success}
          success_rate={summary.success_rate}
          p50={summary.p50_latency_ms}
          p95={summary.p95_latency_ms}
          window={window}
          isLoading={sLoading}
        />
      ) : sLoading ? (
        <div className="card-inset px-4 py-3 text-[13px] text-ink-3">Loading summary…</div>
      ) : null}

      {/* Time-series chart */}
      {series ? (
        <div className="card p-5">
          <header className="mb-3 flex items-baseline justify-between">
            <h2 className="text-[13px] font-semibold uppercase tracking-wider text-ink-2">Volume</h2>
            <p className="text-[11px] text-ink-3">last 14 days · total / success / error per day</p>
          </header>
          <TimeSeriesChart points={series.points} loading={seriesLoading} />
        </div>
      ) : null}

      {/* Per-agent breakdown */}
      {agents ? (
        <div className="card p-5">
          <header className="mb-3 flex items-baseline justify-between">
            <h2 className="text-[13px] font-semibold uppercase tracking-wider text-ink-2">By agent</h2>
            <p className="text-[11px] text-ink-3">top 10 by call volume · window: {window}</p>
          </header>
          {agents.agents.length === 0 ? (
            <p className="text-[12.5px] text-ink-3">No calls in this window.</p>
          ) : (
            <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {agents.agents.map((a) => {
                const rate = a.total === 0 ? 0 : a.success / a.total;
                return (
                  <li key={a.agent} className="card-inset space-y-1.5 p-3.5">
                    <p className="truncate font-mono text-[12px] text-ink-1">{a.agent}</p>
                    <div className="flex items-baseline gap-3 text-[11px] text-ink-3">
                      <span>
                        <span className="text-[18px] font-semibold text-ink-1">{a.total}</span> calls
                      </span>
                      <span>·</span>
                      <span className="text-ink-2">{(rate * 100).toFixed(0)}% ok</span>
                    </div>
                    <p className="font-mono text-[10.5px] text-ink-4">p95 {a.p95_latency_ms}ms</p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : agentsLoading ? (
        <div className="card-inset px-4 py-3 text-[13px] text-ink-3">Loading agents…</div>
      ) : null}

      {/* Existing trace list with outcome filter */}
      <div className="flex items-center gap-2">
        <label className="text-[12px] text-ink-3">Filter trace list:</label>
        <select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          className="field pr-8 text-[13px]"
          aria-label="Filter by outcome"
        >
          <option value="">all outcomes</option>
          <option value="success">success</option>
          <option value="auth_failed">auth_failed</option>
          <option value="server_error">server_error</option>
          <option value="client_error">client_error</option>
          <option value="unreachable">unreachable</option>
        </select>
      </div>

      {isLoading ? (
        <div className="card-inset px-4 py-3 text-[13px] text-ink-3">Loading…</div>
      ) : error ? (
        <div role="alert" className="card-inset border-status-blocked-500/40 bg-status-blocked-500/5 px-3.5 py-2.5 text-[12.5px] text-status-blocked-600">
          {(error as Error).message}
        </div>
      ) : data && data.traces.length === 0 ? (
        <EmptyState
          title="No traces yet"
          body="Traces appear here once an MCP client makes its first call."
        />
      ) : data ? (
        <div className="overflow-hidden rounded-lg border border-border-subtle">
          <table className="w-full text-[12.5px]">
            <thead className="bg-bg-sunken/60 font-mono text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-3 py-2 text-left font-medium">ts</th>
                <th className="px-3 py-2 text-left font-medium">agent</th>
                <th className="px-3 py-2 text-left font-medium">bearer</th>
                <th className="px-3 py-2 text-left font-medium">tool</th>
                <th className="px-3 py-2 text-left font-medium">outcome</th>
                <th className="px-3 py-2 text-right font-medium">latency</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {data.traces.map((t) => (
                <tr key={t.id} className="bg-bg-base/30">
                  <td className="px-3 py-2 font-mono text-[11px] text-ink-3">{formatTs(t.ts)}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-ink-2">{t.agent}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-ink-3">{t.bearer_id}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-ink-1">{t.tool ?? '—'}</td>
                  <td className="px-3 py-2"><OutcomePill outcome={t.outcome} /></td>
                  <td className="px-3 py-2 text-right font-mono text-[11px] text-ink-2">
                    {t.response?.latency_ms != null ? `${t.response.latency_ms}ms` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function SummaryStrip({
  total,
  success,
  success_rate,
  p50,
  p95,
  window,
  isLoading,
}: {
  total: number;
  success: number;
  success_rate: number;
  p50: number;
  p95: number;
  window: Window;
  isLoading: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      <Stat label={`total (${window})`} value={total.toLocaleString()} tone="backlog" />
      <Stat label="success" value={success.toLocaleString()} tone="ready" />
      <Stat
        label="success rate"
        value={total === 0 ? '—' : `${(success_rate * 100).toFixed(1)}%`}
        tone={success_rate >= 0.99 ? 'ready' : success_rate >= 0.95 ? 'progress' : 'blocked'}
      />
      <Stat
        label="p50 latency"
        value={p50 ? `${p50}ms` : '—'}
        tone="backlog"
      />
      <Stat
        label="p95 latency"
        value={p95 ? `${p95}ms` : '—'}
        tone={p95 > 5000 ? 'blocked' : p95 > 1000 ? 'progress' : 'ready'}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'ready' | 'progress' | 'blocked' | 'backlog';
}) {
  return (
    <div className="card-inset space-y-1 px-3.5 py-2.5">
      <p className="font-mono text-[10px] uppercase tracking-wider text-ink-3">{label}</p>
      <p className="flex items-baseline gap-2">
        <span className="text-[22px] font-semibold tracking-tight text-ink-1">{value}</span>
        <Pill kind={tone} dot={false}>
          {tone === 'ready' ? 'ok' : tone === 'progress' ? 'warn' : tone === 'blocked' ? '!' : '·'}
        </Pill>
      </p>
    </div>
  );
}

function TimeSeriesChart({
  points,
  loading,
}: {
  points: { date: string; total: number; success: number; error: number }[];
  loading: boolean;
}) {
  if (loading && points.length === 0) {
    return <div className="card-inset h-32 animate-pulse" />;
  }
  if (points.every((p) => p.total === 0)) {
    return <p className="text-[12.5px] text-ink-3">No calls in the last 14 days.</p>;
  }
  const W = 720;
  const H = 120;
  const padX = 8;
  const padY = 12;
  const max = Math.max(1, ...points.map((p) => p.total));
  const stepX = (W - padX * 2) / Math.max(1, points.length - 1);
  const x = (i: number) => padX + i * stepX;
  const y = (v: number) => H - padY - (v / max) * (H - padY * 2);
  const path = (key: 'success' | 'error') =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');
  const area = (key: 'success' | 'error') => {
    const start = `M ${x(0).toFixed(1)} ${H - padY}`;
    const line = points.map((p, i) => `L ${x(i).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');
    const end = `L ${x(points.length - 1).toFixed(1)} ${H - padY} Z`;
    return `${start} ${line} ${end}`;
  };
  return (
    <div className="space-y-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-32 w-full"
        role="img"
        aria-label="Call volume per day, last 14 days"
      >
        <defs>
          <linearGradient id="success-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgb(16, 185, 129)" stopOpacity="0.4" />
            <stop offset="100%" stopColor="rgb(16, 185, 129)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="error-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgb(244, 63, 94)" stopOpacity="0.4" />
            <stop offset="100%" stopColor="rgb(244, 63, 94)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area('success')} fill="url(#success-fill)" />
        <path d={area('error')} fill="url(#error-fill)" />
        <path d={path('success')} fill="none" stroke="rgb(16, 185, 129)" strokeWidth="1.5" />
        <path d={path('error')} fill="none" stroke="rgb(244, 63, 94)" strokeWidth="1.5" />
      </svg>
      <div className="flex items-center gap-4 text-[10.5px] text-ink-3">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500/80" /> success
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-rose-500/80" /> error
        </span>
        <span className="ml-auto font-mono">{points[0]?.date} → {points[points.length - 1]?.date}</span>
      </div>
    </div>
  );
}

function OutcomePill({ outcome }: { outcome: string }) {
  if (outcome === 'success')      return <Pill kind="done"     dot={false}>success</Pill>;
  if (outcome === 'auth_failed')  return <Pill kind="blocked"  dot={false}>auth</Pill>;
  if (outcome === 'server_error') return <Pill kind="blocked"  dot={false}>5xx</Pill>;
  if (outcome === 'client_error') return <Pill kind="review"   dot={false}>4xx</Pill>;
  return <Pill kind="backlog" dot={false}>{outcome}</Pill>;
}

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
