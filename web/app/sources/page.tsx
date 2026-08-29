'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';

export default function SourcesPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['sources'],
    queryFn: () => api.listSources(),
  });
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Sources</h1>
          <p className="text-sm text-slate-500">Connectors that submit work items to WorkTracker.</p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="rounded bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          Register source
        </button>
      </header>

      {isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {error ? <p className="text-sm text-rose-600">Failed to load sources.</p> : null}

      {data ? (
        <ul className="space-y-3">
          {data.sources.map((s) => (
            <li key={s.name} className="card p-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-semibold text-slate-900">{s.display_name}</h2>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                      {s.kind}
                    </span>
                    {s.enabled ? (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">
                        enabled
                      </span>
                    ) : (
                      <span className="rounded bg-rose-50 px-1.5 py-0.5 text-xs text-rose-700">
                        disabled
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{s.name}</p>
                  <p className="mt-2 text-sm text-slate-600">
                    Capabilities: {s.capabilities.join(', ') || 'none'}
                  </p>
                </div>
                <div className="text-right text-xs text-slate-500">
                  <p>last sync: {s.last_sync_at ? new Date(s.last_sync_at).toLocaleString() : 'never'}</p>
                  {s.last_error ? <p className="text-rose-600">error: {s.last_error}</p> : null}
                </div>
              </div>
            </li>
          ))}
          {data.sources.length === 0 ? (
            <li className="card p-6 text-center text-sm text-slate-500">
              No sources registered yet. Click "Register source" to add one.
            </li>
          ) : null}
        </ul>
      ) : null}

      {showCreate ? <CreateSourceModal onClose={() => setShowCreate(false)} /> : null}
    </div>
  );
}

function CreateSourceModal({ onClose }: { onClose: () => void }) {
  const [manifestText, setManifestText] = useState(
    JSON.stringify(
      {
        name: 'my-source',
        display_name: 'My Source',
        kind: 'agent',
        capabilities: ['create', 'update', 'transition', 'comment', 'link'],
        webhook_url: null,
        version: '1.0.0',
      },
      null,
      2,
    ),
  );
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      const manifest = JSON.parse(manifestText);
      const res = await api.createSource({ manifest });
      setApiKey(res.api_key);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">Register source</h2>
        <p className="mt-1 text-sm text-slate-500">Paste a manifest.json. The API key is shown once.</p>

        {apiKey ? (
          <div className="mt-4 space-y-2">
            <p className="text-sm font-medium text-emerald-700">Source created.</p>
            <p className="text-xs text-slate-600">
              API key (save this — it is shown only once):
            </p>
            <pre className="overflow-x-auto rounded bg-slate-900 p-3 text-xs text-emerald-200">
              {apiKey}
            </pre>
            <button
              type="button"
              onClick={onClose}
              className="rounded bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <textarea
              value={manifestText}
              onChange={(e) => setManifestText(e.target.value)}
              className="h-64 w-full rounded border border-slate-300 p-2 font-mono text-xs"
            />
            {error ? <p className="text-xs text-rose-600">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-slate-300 px-3 py-1.5 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                className="rounded bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
              >
                Create
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
