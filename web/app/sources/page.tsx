'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';
import { Modal } from '../../components/Modal';
import { EmptyState } from '../../components/EmptyState';
import { Pill } from '../../components/Pill';

export default function SourcesPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['sources'],
    queryFn: () => api.listSources(),
  });
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">connectors</p>
          <h1 className="text-2xl font-bold tracking-tight text-ink-1">Sources</h1>
          <p className="text-[13px] text-ink-2">Connectors that submit work items to WorkTracker.</p>
        </div>
        <button type="button" onClick={() => setShowCreate(true)} className="btn-primary focus-ring">
          Register source
        </button>
      </header>

      {isLoading ? (
        <ul className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2].map((i) => (
            <li key={i} className="skeleton h-28" />
          ))}
        </ul>
      ) : null}
      {error ? <p className="text-[13px] text-status-blocked-600">Failed to load sources.</p> : null}

      {data ? (
        <ul className="grid gap-4 md:grid-cols-2">
          {data.sources.map((s) => (
            <li key={s.name} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <h2 className="text-[15px] font-semibold tracking-tight text-ink-1">
                      {s.display_name}
                    </h2>
                    <Pill kind="backlog" dot={false} className="!ring-border-subtle !bg-bg-sunken !text-ink-2">
                      {s.kind}
                    </Pill>
                    {s.enabled ? (
                      <Pill kind="done" dot={false} className="!ring-status-done-500/30 !bg-status-done-500/10 !text-status-done-600">
                        enabled
                      </Pill>
                    ) : (
                      <Pill kind="blocked" dot={false} className="!ring-status-blocked-500/30 !bg-status-blocked-500/10 !text-status-blocked-600">
                        disabled
                      </Pill>
                    )}
                  </div>
                  <p className="font-mono text-[11px] text-ink-3">{s.name}</p>
                  <div className="flex flex-wrap gap-1">
                    {s.capabilities.length > 0 ? (
                      s.capabilities.map((c) => (
                        <Pill
                          key={c}
                          kind="backlog"
                          dot={false}
                          className="!ring-border-subtle !bg-bg-sunken !text-ink-3"
                        >
                          {c}
                        </Pill>
                      ))
                    ) : (
                      <span className="text-[12px] text-ink-4">no capabilities</span>
                    )}
                  </div>
                </div>
                <div className="shrink-0 space-y-0.5 text-right text-[11px] text-ink-3">
                  <p>
                    last sync:{' '}
                    <span className="text-ink-2">
                      {s.last_sync_at ? new Date(s.last_sync_at).toLocaleString() : 'never'}
                    </span>
                  </p>
                  {s.last_error ? <p className="text-status-blocked-600">error: {s.last_error}</p> : null}
                </div>
              </div>
            </li>
          ))}
          {data.sources.length === 0 ? (
            <li className="md:col-span-2">
              <EmptyState
                title="No sources yet"
                body="Click Register source to add one. The manifest reference is in the next step."
                action={
                  <button type="button" onClick={() => setShowCreate(true)} className="btn-primary focus-ring">
                    Register source
                  </button>
                }
              />
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
    <Modal
      open
      onClose={onClose}
      title="Register source"
      size="lg"
      footer={
        apiKey ? (
          <button type="button" onClick={onClose} className="btn-primary focus-ring">
            Done
          </button>
        ) : (
          <>
            <button type="button" onClick={onClose} className="btn-secondary focus-ring">
              Cancel
            </button>
            <button type="button" onClick={submit} className="btn-primary focus-ring">
              Create
            </button>
          </>
        )
      }
    >
      <p className="text-[13px] text-ink-2">
        Paste a <code className="rounded bg-bg-sunken px-1.5 py-0.5 text-ink-1">manifest.json</code>. The API key is shown once after creation — copy it then.
      </p>

      {apiKey ? (
        <div className="mt-4 space-y-2">
          <p className="text-[13px] font-medium text-status-done-600">Source created.</p>
          <p className="text-[12px] text-ink-3">API key (save this — it is shown only once):</p>
          <pre className="card-inset overflow-x-auto p-3 font-mono text-[12px] text-status-done-600">
            {apiKey}
          </pre>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <textarea
            value={manifestText}
            onChange={(e) => setManifestText(e.target.value)}
            className="field h-64 font-mono text-[12px] leading-5"
          />
          {error ? <p className="text-[12px] text-status-blocked-600">{error}</p> : null}
        </div>
      )}
    </Modal>
  );
}
