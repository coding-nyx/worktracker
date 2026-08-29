'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
    </div>
  );
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
