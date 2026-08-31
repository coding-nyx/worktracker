'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Pill } from '../../components/Pill';
import { Modal } from '../../components/Modal';
import { EmptyState } from '../../components/EmptyState';

export default function AdminPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['sources'],
    queryFn: () => api.listSources(),
  });

  const [showManifest, setShowManifest] = useState(false);
  const [showEnricherPool, setShowEnricherPool] = useState(false);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-ink-1">Connector Admin</h1>
        <p className="text-[13px] text-ink-2">Manage sources, the enricher pool, and webhook deliveries.</p>
      </header>

      <Section
        title="Enricher pool"
        eyebrow="AI"
        description={
          <>
            Sources with <code className="rounded bg-bg-sunken px-1.5 py-0.5 text-ink-1">enrich:grill</code> or{' '}
            <code className="rounded bg-bg-sunken px-1.5 py-0.5 text-ink-1">enrich:wayfind</code> in their
            capabilities can run the dispatch enrichment pipeline. Drag a source to set it as the
            preferred grill or wayfind runner; the chain falls back to others if the preferred is
            unreachable.
          </>
        }
        action={
          <button
            type="button"
            onClick={() => setShowEnricherPool((v) => !v)}
            className="btn-secondary focus-ring"
          >
            {showEnricherPool ? 'Hide' : 'Edit'}
          </button>
        }
      >
        {showEnricherPool ? (
          <ul className="space-y-2">
            {(data?.sources ?? []).map((s) => (
              <li
                key={s.name}
                className="card-inset flex items-center justify-between px-3.5 py-2.5 text-[13px]"
              >
                <div className="space-y-1">
                  <p className="font-medium text-ink-1">{s.display_name}</p>
                  <p className="text-[11px] text-ink-3">
                    grill: {s.capabilities.includes('enrich:grill') ? (
                      <span className="text-status-done-600">✓ capable</span>
                    ) : (
                      <span className="text-ink-4">—</span>
                    )}{' '}
                    · wayfind:{' '}
                    {s.capabilities.includes('enrich:wayfind') ? (
                      <span className="text-status-done-600">✓ capable</span>
                    ) : (
                      <span className="text-ink-4">—</span>
                    )}
                  </p>
                </div>
                <span className="kbd">v0 stretch</span>
              </li>
            ))}
            {(data?.sources ?? []).length === 0 ? (
              <p className="text-[12px] text-ink-3">No sources registered yet.</p>
            ) : null}
          </ul>
        ) : null}
      </Section>

      <Section
        title="Webhook deliveries"
        eyebrow="live traffic"
        description={
          <>
            Incoming and outgoing webhook traffic is logged on the Sources view. The last 100 commands
            and conflicts are visible there too.
          </>
        }
      />

      <Section
        title="Sources"
        eyebrow="ingest"
        description="Connectors that submit work items to WorkTracker."
        action={
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => refetch()}
              className="btn-secondary focus-ring"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setShowManifest(true)}
              className="btn-primary focus-ring"
            >
              Register new
            </button>
          </div>
        }
      >
        {isLoading ? (
          <ul className="space-y-2">
            {[0, 1, 2].map((i) => (
              <li key={i} className="skeleton h-12" />
            ))}
          </ul>
        ) : null}
        {error ? (
          <p className="text-[13px] text-status-blocked-600">Failed to load sources.</p>
        ) : null}
        {data && data.sources.length > 0 ? (
          <ul className="space-y-2">
            {data.sources.map((s) => (
              <li key={s.name} className="card-inset flex items-center justify-between gap-3 px-3.5 py-2.5 text-[13px]">
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate font-medium text-ink-1">{s.display_name}</p>
                  <p className="truncate font-mono text-[11px] text-ink-3">{s.name}</p>
                </div>
                <Pill kind="ready" dot={false} className="!ring-border-subtle !bg-bg-sunken !text-ink-2">
                  {s.kind}
                </Pill>
              </li>
            ))}
          </ul>
        ) : null}
        {data && data.sources.length === 0 ? (
          <EmptyState
            title="No sources yet"
            body="Sources are the connectors that submit work items — for example, a chat agent, a CI bot, or an inbox watcher."
            action={
              <button type="button" onClick={() => setShowManifest(true)} className="btn-primary focus-ring">
                Register a source
              </button>
            }
          />
        ) : null}
      </Section>

      <Section
        title="Boards"
        eyebrow="multi-board"
        description="Saved kanban views — columns, kind filter, default flag. Each user picks a board from the picker at the top of the kanban."
        action={
          <a
            href="/admin/boards"
            className="btn-secondary focus-ring"
          >
            Manage boards →
          </a>
        }
      />

      <DeadLetterPanel />

      <Modal open={showManifest} onClose={() => setShowManifest(false)} title="Source manifest reference" size="lg">
        <p className="mb-3 text-[13px] text-ink-2">
          POST this JSON to <code className="rounded bg-bg-sunken px-1.5 py-0.5 text-ink-1">/api/sources</code> to register a new source. The
          token in the manifest is the source's bearer — keep it server-side; the web client uses
          the admin token instead.
        </p>
        <pre className="card-inset overflow-x-auto p-3 font-mono text-[11.5px] leading-5 text-ink-1">
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
    "grill":   { "kind": "skill", "skill_path": "~/.cline/skills/grill",     "command": "grill" },
    "wayfind": { "kind": "skill", "skill_path": "~/.cline/skills/wayfinder", "command": "wayfind" }
  }
}`}
        </pre>
      </Modal>
    </div>
  );
}

function Section({
  title,
  eyebrow,
  description,
  action,
  children,
}: {
  title: string;
  eyebrow?: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
        <div className="min-w-0 space-y-1">
          {eyebrow && (
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{eyebrow}</p>
          )}
          <h2 className="text-[15px] font-semibold tracking-tight text-ink-1">{title}</h2>
          {description && <p className="text-[12.5px] leading-5 text-ink-2">{description}</p>}
        </div>
        {action && <div className="flex shrink-0 gap-2">{action}</div>}
      </div>
      {children ? <div className="px-5 py-4">{children}</div> : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Dead-letter queue.                                                         */

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
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
        <div className="min-w-0 space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">resilience</p>
          <h2 className="text-[15px] font-semibold tracking-tight text-ink-1">Dead-letter queue</h2>
          <p className="text-[12.5px] leading-5 text-ink-2">
            Commands the brain gave up on. Replay to re-queue after fixing the cause.
          </p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="btn-secondary focus-ring"
        >
          Refresh
        </button>
      </div>
      <div className="px-5 py-4">
        {isLoading ? <p className="text-[13px] text-ink-3">Loading…</p> : null}
        {error ? <p className="text-[13px] text-status-blocked-600">Failed to load.</p> : null}
        {data && data.length === 0 ? (
          <EmptyState
            icon={<span aria-hidden>🎉</span>}
            title="No dead-lettered commands"
            body="The brain is keeping up. If something fails it will land here automatically."
          />
        ) : null}
        {data && data.length > 0 ? (
          <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
            <ul className="space-y-1.5">
              {data.map((c) => {
                const isSelected = c.id === selectedId;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(c.id)}
                      className={`focus-ring w-full rounded-xl border px-3 py-2 text-left text-[13px] transition-all duration-150 ease-out-quint ${
                        isSelected
                          ? 'border-brand-500/60 bg-brand-500/5 shadow-glow'
                          : 'border-border-subtle bg-bg-surface hover:border-border-default'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-[11px] text-ink-2">{c.id}</span>
                        <Pill kind={c.status === 'failed' ? 'blocked' : 'progress'} dot={false}>
                          {c.status}
                        </Pill>
                      </div>
                      <p className="mt-1 truncate text-[11px] text-ink-3">
                        {c.op} · {c.source} · {c.failure_count} failure{c.failure_count === 1 ? '' : 's'}
                      </p>
                      {c.failed_at ? (
                        <p className="text-[11px] text-ink-4">failed {formatRel(c.failed_at)}</p>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            <div>
              {selectedId ? (
                <div className="card-inset p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate font-mono text-[11px] text-ink-2">{selectedId}</p>
                    <button
                      type="button"
                      onClick={() => replay.mutate(selectedId)}
                      disabled={replay.isPending}
                      className="btn-primary focus-ring"
                    >
                      {replay.isPending ? 'Replaying…' : 'Replay'}
                    </button>
                  </div>
                  {replay.isSuccess ? (
                    <p className="mt-2 text-[12px] text-status-done-600">Re-queued. The brain trigger will pick it up.</p>
                  ) : null}
                  {replay.isError ? (
                    <p className="mt-2 text-[12px] text-status-blocked-600">Replay failed: {String(replay.error)}</p>
                  ) : null}
                  <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                    Failure history
                  </h3>
                  {isLoadingFailures ? (
                    <p className="mt-2 text-[12px] text-ink-3">Loading…</p>
                  ) : failures && failures.failures.length > 0 ? (
                    <ul className="mt-2 space-y-1.5 text-[12px]">
                      {failures.failures.map((f) => (
                        <li key={f.id} className="rounded-md border border-border-subtle bg-bg-sunken px-2.5 py-1.5">
                          <p className="font-mono text-[10.5px] text-ink-3">
                            attempt {f.attempt} · {f.code}
                          </p>
                          <p className="mt-0.5 text-ink-1">{f.message}</p>
                          <p className="text-[10.5px] text-ink-4">{f.occurred_at}</p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-[12px] text-ink-3">
                      No recorded failures (rejected before brain could record one).
                    </p>
                  )}
                </div>
              ) : (
                <div className="card-inset flex items-center justify-center px-4 py-10 text-center text-[12px] text-ink-3">
                  Select a command to see its failure history.
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
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
