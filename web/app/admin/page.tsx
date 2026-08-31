'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../../lib/api';

export default function AdminPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['sources'],
    queryFn: () => api.listSources(),
  });

  const [showManifest, setShowManifest] = useState(false);
  const [showEnricherPool, setShowEnricherPool] = useState(false);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Connector Admin</h1>
        <p className="text-sm text-slate-500">Manage sources, the enricher pool, and webhook deliveries.</p>
      </header>

      <section className="card p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Enricher pool</h2>
          <button
            type="button"
            onClick={() => setShowEnricherPool((v) => !v)}
            className="rounded border border-slate-300 px-3 py-1 text-sm"
          >
            {showEnricherPool ? 'Hide' : 'Edit'}
          </button>
        </div>
        <p className="mt-1 text-sm text-slate-600">
          Sources with <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">enrich:grill</code> or{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">enrich:wayfind</code> in their
          capabilities can run the dispatch enrichment pipeline. Drag a source to set it as the
          preferred grill or wayfind runner; the chain falls back to others if the preferred is
          unreachable.
        </p>
        {showEnricherPool ? (
          <ul className="mt-3 space-y-2">
            {(data?.sources ?? []).map((s) => (
              <li
                key={s.name}
                className="flex items-center justify-between rounded border border-slate-200 px-3 py-2 text-sm"
              >
                <div>
                  <p className="font-medium">{s.display_name}</p>
                  <p className="text-xs text-slate-500">
                    grill: {s.capabilities.includes('enrich:grill') ? '✓' : '—'} · wayfind:{' '}
                    {s.capabilities.includes('enrich:wayfind') ? '✓' : '—'}
                  </p>
                </div>
                <span className="text-xs text-slate-400">v0 stretch</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="card p-4">
        <h2 className="font-semibold">Webhook deliveries</h2>
        <p className="mt-1 text-sm text-slate-600">
          Incoming and outgoing webhook traffic is logged on the Sources view. The last 100 commands
          and conflicts are visible there too.
        </p>
      </section>

      <section className="card p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Sources</h2>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => refetch()}
              className="rounded border border-slate-300 px-3 py-1 text-sm"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setShowManifest(true)}
              className="rounded bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              Register new
            </button>
          </div>
        </div>
        {isLoading ? <p className="mt-2 text-sm text-slate-500">Loading…</p> : null}
        {error ? <p className="mt-2 text-sm text-rose-600">Failed to load sources.</p> : null}
        {data ? (
          <ul className="mt-3 space-y-2">
            {data.sources.map((s) => (
              <li key={s.name} className="rounded border border-slate-200 px-3 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <p className="font-medium">{s.display_name}</p>
                  <span className="text-xs text-slate-500">{s.kind}</span>
                </div>
                <p className="mt-0.5 text-xs text-slate-500">{s.name}</p>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {showManifest ? <ManifestHelp onClose={() => setShowManifest(false)} /> : null}

      <section className="card p-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold">Boards</h2>
            <p className="mt-1 text-sm text-slate-600">
              Saved kanban views — columns, kind filter, default flag. Each user picks
              a board from the picker at the top of the kanban.
            </p>
          </div>
          <a
            href="/admin/boards"
            className="rounded border border-slate-300 px-3 py-1.5 text-sm"
          >
            Manage boards →
          </a>
        </div>
      </section>

      <DeadLetterPanel />
    </div>
  );
}

/**
 * Dead-letter queue. Lists every command in `failed` or `rejected`
 * status, lets the operator inspect the recorded failure sub-docs
 * (from `GET /api/commands/:id/failures`) and replay the command
 * back onto the brain queue (`POST /api/commands/:id/replay`).
 *
 * The brain trigger is `onDocumentWritten` so the replay's
 * `update` re-fires it; the brain's `status !== 'queued'` guard
 * keeps it from looping on its own status updates.
 */
function DeadLetterPanel() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['commands', 'dead'],
    queryFn: () =>
      api.listCommands({ limit: 200 }).then((r) =>
        r.commands.filter((c) => c.status === 'failed' || c.status === 'rejected'),
      ),
    refetchInterval: 5000,
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: failures, isLoading: isLoadingFailures } = useQuery({
    queryKey: ['command-failures', selectedId],
    queryFn: () => api.listCommandFailures(selectedId!),
    enabled: !!selectedId,
  });
  const replay = useMutation({
    mutationFn: (id: string) => api.replayCommand(id),
    onSuccess: () => refetch(),
  });

  return (
    <section className="card p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Dead-letter queue</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Commands the brain gave up on. Replay to re-queue after fixing the cause.
          </p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="rounded border border-slate-300 px-3 py-1 text-sm"
        >
          Refresh
        </button>
      </div>
      {isLoading ? <p className="mt-2 text-sm text-slate-500">Loading…</p> : null}
      {error ? <p className="mt-2 text-sm text-rose-600">Failed to load.</p> : null}
      {data && data.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No dead-lettered commands. 🎉</p>
      ) : null}
      {data && data.length > 0 ? (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <ul className="space-y-1">
            {data.map((c) => {
              const isSelected = c.id === selectedId;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(c.id)}
                    className={
                      'w-full rounded border px-3 py-2 text-left text-sm transition ' +
                      (isSelected
                        ? 'border-brand-500 bg-brand-50'
                        : 'border-slate-200 hover:border-slate-300')
                    }
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs text-slate-700">{c.id}</span>
                      <span
                        className={
                          'rounded px-1.5 py-0.5 text-xs ' +
                          (c.status === 'failed'
                            ? 'bg-rose-100 text-rose-700'
                            : 'bg-amber-100 text-amber-700')
                        }
                      >
                        {c.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {c.op} · {c.source} · failures: {c.failure_count}
                    </p>
                    <p className="text-xs text-slate-400">
                      {c.failed_at ? `failed ${formatRel(c.failed_at)}` : null}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
          <div>
            {selectedId ? (
              <div className="rounded border border-slate-200 p-3">
                <div className="flex items-center justify-between">
                  <p className="font-mono text-xs text-slate-700">{selectedId}</p>
                  <button
                    type="button"
                    onClick={() => replay.mutate(selectedId)}
                    disabled={replay.isPending}
                    className="rounded bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                  >
                    {replay.isPending ? 'Replaying…' : 'Replay'}
                  </button>
                </div>
                {replay.isSuccess ? (
                  <p className="mt-2 text-xs text-emerald-700">
                    Re-queued. The brain trigger will pick it up.
                  </p>
                ) : null}
                {replay.isError ? (
                  <p className="mt-2 text-xs text-rose-600">Replay failed: {String(replay.error)}</p>
                ) : null}
                <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Failure history
                </h3>
                {isLoadingFailures ? (
                  <p className="mt-2 text-xs text-slate-500">Loading…</p>
                ) : failures && failures.failures.length > 0 ? (
                  <ul className="mt-2 space-y-1 text-xs">
                    {failures.failures.map((f) => (
                      <li key={f.id} className="rounded bg-slate-50 px-2 py-1">
                        <p className="font-mono text-slate-500">
                          attempt {f.attempt} · {f.code}
                        </p>
                        <p className="mt-0.5 text-slate-700">{f.message}</p>
                        <p className="text-slate-400">{f.occurred_at}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs text-slate-500">
                    No recorded failures (rejected before brain could record one).
                  </p>
                )}
              </div>
            ) : (
              <p className="rounded border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">
                Select a command to see its failure history.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function formatRel(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diff = Date.now() - then;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function ManifestHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div className="card w-full max-w-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">Source manifest reference</h2>
        <pre className="mt-3 overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
{`{
  "name": "hermes",
  "display_name": "Hermes",
  "kind": "agent",
  "capabilities": [
    "create", "update", "transition", "comment", "link",
    "enrich:grill", "enrich:wayfind"
  ],
  "webhook_url": null,
  "icon": null,
  "version": "1.0.0",
  "enricher": {
    "grill":   { "kind": "skill", "skill_path": "~/.cline/skills/grill", "command": "grill" },
    "wayfind": { "kind": "skill", "skill_path": "~/.cline/skills/wayfinder", "command": "wayfind" }
  }
}`}
        </pre>
        <button
          type="button"
          onClick={onClose}
          className="mt-4 rounded bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
