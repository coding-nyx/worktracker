'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { Pill } from '../../../components/Pill';
import { EmptyState } from '../../../components/EmptyState';

/**
 * /admin/analytics — slice 7. Lists the last 200 call traces
 * from the `analytics/call_traces/` collection (30-day TTL).
 * Header summary shows the last 500 by outcome so an operator
 * can see at a glance whether something is on fire.
 *
 * Admin only. Operators can also use this page to drill into a
 * specific bearer / agent when an end user reports "the agent
 * keeps failing" — the trace ID is right there.
 */
export default function AnalyticsPage() {
  const auth = useAuth();
  const [outcome, setOutcome] = useState<string>('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['analytics', 'traces', outcome],
    queryFn: () => api.listCallTraces({ outcome: outcome || undefined, limit: 200 }),
    enabled: !!auth.firebaseUser && !!auth.isAdmin,
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
      </header>

      {data ? <SummaryCards summary={data.summary} /> : null}

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

function SummaryCards({ summary }: { summary: { total: number; success: number; auth_failed: number; server_error: number; client_error: number } }) {
  const items = [
    { label: 'total',       value: summary.total,         tone: 'backlog' as const },
    { label: 'success',     value: summary.success,       tone: 'ready' as const },
    { label: 'auth_failed', value: summary.auth_failed,   tone: 'blocked' as const },
    { label: 'server_error',value: summary.server_error,  tone: 'blocked' as const },
    { label: 'client_error',value: summary.client_error,  tone: 'review' as const },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {items.map((it) => (
        <div key={it.label} className="card-inset space-y-1 px-3.5 py-2.5">
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-3">{it.label}</p>
          <p className="flex items-baseline gap-2">
            <span className="text-[22px] font-semibold tracking-tight text-ink-1">{it.value}</span>
            <Pill kind={it.tone} dot={false}>{it.tone === 'blocked' ? '!' : it.tone}</Pill>
          </p>
        </div>
      ))}
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
