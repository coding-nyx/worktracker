'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type ApiTokenScope, type Client, type ClientManifest } from '../../lib/api';
import { Modal } from '../../components/Modal';
import { EmptyState } from '../../components/EmptyState';
import { Pill } from '../../components/Pill';

/**
 * /clients — every authenticated identity that calls the API.
 *
 * Two shapes coexist in one list, distinguished by `kind`:
 *   - `kind: 'agent'`  — a system integration (Hermes, Claude Code,
 *                        Codex, OpenClaw). Bearer is `<name>.<key>`,
 *                        scrypt-hashed on the server.
 *   - `kind: 'user'`   — a personal access token minted by a signed-in
 *                        operator. Bearer is `wt_<bearer_id>`; the id
 *                        IS the credential (256 bits of entropy).
 *
 * Slice 2 replaces the old `sources` list. The webhook / bridge config
 * that previously lived on the same doc is now a separate `Connector`
 * record at `/connectors` — clients are pure credentials, connectors
 * are the integration config.
 */
export default function ClientsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.listClients(),
  });
  const [showCreate, setShowCreate] = useState(false);

  const clients = data?.clients ?? [];
  const agents = clients.filter((c) => c.kind === 'agent');
  const users = clients.filter((c) => c.kind === 'user');

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
            // credentials
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-ink-1">Clients</h1>
          <p className="text-[13px] text-ink-2">
            Every authenticated identity that calls the API. Agents are system integrations; users are personal access tokens.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="btn-primary focus-ring"
        >
          Register agent
        </button>
      </header>

      {isLoading ? (
        <ul className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2].map((i) => (
            <li key={i} className="skeleton h-28" />
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="text-[13px] text-status-blocked-600">Failed to load clients.</p>
      ) : null}

      {data ? (
        <>
          <Section
            title="Agents"
            count={agents.length}
            empty="No agent clients registered."
            emptyAction={
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="btn-primary focus-ring"
              >
                Register agent
              </button>
            }
          >
            {agents.map((c) => (
              <ClientCard key={c.name} client={c} />
            ))}
          </Section>

          <Section
            title="Personal clients"
            count={users.length}
            empty="No personal clients. Mint one from the Settings page."
            emptyAction={null}
          >
            {users.map((c) => (
              <ClientCard key={c.name} client={c} />
            ))}
          </Section>

          {clients.length === 0 ? (
            <EmptyState
              title="No clients yet"
              body="Click Register agent to add one. The manifest reference is in the next step."
              action={
                <button
                  type="button"
                  onClick={() => setShowCreate(true)}
                  className="btn-primary focus-ring"
                >
                  Register agent
                </button>
              }
            />
          ) : null}
        </>
      ) : null}

      {showCreate ? <RegisterAgentModal onClose={() => setShowCreate(false)} /> : null}
    </div>
  );
}

function Section({
  title, count, empty, emptyAction, children,
}: {
  title: string;
  count: number;
  empty: string;
  emptyAction: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="text-[11.5px] font-semibold uppercase tracking-mono-wide text-ink-3">
          {title}
          <span className="ml-2 font-mono text-[11px] text-ink-4">·</span>
          <span className="ml-1 font-mono text-[11px] text-ink-4">{count}</span>
        </h2>
      </header>
      {count === 0 ? (
        <div className="card-inset flex items-center justify-between gap-3 p-4">
          <p className="text-[12.5px] text-ink-3">{empty}</p>
          {emptyAction}
        </div>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">{children}</ul>
      )}
    </section>
  );
}

function ClientCard({ client: c }: { client: Client }) {
  const qc = useQueryClient();
  const [patchError, setPatchError] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.patchClient(c.name, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['clients'] }),
    onError: (err) => setPatchError((err as Error).message),
  });

  return (
    <li className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="truncate text-[15px] font-semibold tracking-tight text-ink-1">
              {c.display_name}
            </h3>
            <Pill
              kind="backlog"
              dot={false}
              className="!ring-border-subtle !bg-bg-sunken !text-ink-2"
            >
              {c.kind}
            </Pill>
            <Pill
              kind={c.scope === 'admin' ? 'ready' : c.scope === 'read_write' ? 'progress' : 'backlog'}
              dot={false}
            >
              {c.scope}
            </Pill>
            {c.enabled ? (
              <Pill
                kind="done"
                dot={false}
                className="!ring-status-done-500/30 !bg-status-done-500/10 !text-status-done-600"
              >
                enabled
              </Pill>
            ) : (
              <Pill
                kind="blocked"
                dot={false}
                className="!ring-status-blocked-500/30 !bg-status-blocked-500/10 !text-status-blocked-600"
              >
                disabled
              </Pill>
            )}
            {c.revoked_at ? (
              <Pill
                kind="blocked"
                dot={false}
                className="!ring-status-blocked-500/30 !bg-status-blocked-500/10 !text-status-blocked-600"
              >
                revoked
              </Pill>
            ) : null}
          </div>
          <p className="break-all font-mono text-[11px] text-ink-3">{c.name}</p>
          <div className="flex flex-wrap gap-1">
            {c.capabilities.length > 0 ? (
              c.capabilities.map((cap) => (
                <Pill
                  key={cap}
                  kind="backlog"
                  dot={false}
                  className="!ring-border-subtle !bg-bg-sunken !text-ink-3"
                >
                  {cap}
                </Pill>
              ))
            ) : (
              <span className="text-[12px] text-ink-4">no capabilities</span>
            )}
          </div>
          {patchError ? (
            <p className="text-[11.5px] text-status-blocked-600">{patchError}</p>
          ) : null}
        </div>
        <div className="shrink-0 space-y-1 text-right text-[11px] text-ink-3">
          <p>
            last used:{' '}
            <span className="text-ink-2">
              {c.last_used_at ? new Date(c.last_used_at).toLocaleString() : 'never'}
            </span>
          </p>
          <p>
            created:{' '}
            <span className="text-ink-2">{new Date(c.created_at).toLocaleString()}</span>
          </p>
          <button
            type="button"
            disabled={toggle.isPending}
            onClick={() => toggle.mutate(!c.enabled)}
            className="btn-ghost focus-ring text-[11.5px] text-ink-2 disabled:opacity-50"
          >
            {c.enabled ? 'Disable' : 'Enable'}
          </button>
        </div>
      </div>
    </li>
  );
}

function RegisterAgentModal({ onClose }: { onClose: () => void }) {
  const [manifestText, setManifestText] = useState(
    JSON.stringify(
      {
        name: 'my-agent',
        display_name: 'My Agent',
        kind: 'agent',
        capabilities: ['create', 'update', 'transition', 'comment', 'link'],
        webhook_url: null,
        version: '1.0.0',
      },
      null,
      2,
    ),
  );
  const [scope, setScope] = useState<ApiTokenScope>('read_write');
  const [bearer, setBearer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      const manifest: ClientManifest = JSON.parse(manifestText);
      const res = await api.registerClient({ manifest, scope });
      setBearer(res.bearer);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Register agent client"
      size="lg"
      footer={
        bearer ? (
          <button type="button" onClick={onClose} className="btn-primary focus-ring">
            Done
          </button>
        ) : (
          <>
            <button type="button" onClick={onClose} className="btn-secondary focus-ring">
              Cancel
            </button>
            <button type="button" onClick={submit} className="btn-primary focus-ring">
              Register
            </button>
          </>
        )
      }
    >
      <p className="text-[13px] text-ink-2">
        Paste a <code className="rounded bg-bg-sunken px-1.5 py-0.5 text-ink-1">manifest.json</code>.
        The bearer is shown once after creation — copy it then.
      </p>

      <div className="mt-3 space-y-3">
        <ScopeField value={scope} onChange={setScope} />
        {bearer ? (
          <div className="space-y-2">
            <p className="text-[13px] font-medium text-status-done-600">Client registered.</p>
            <p className="text-[12px] text-ink-3">Bearer (save this — it is shown only once):</p>
            <pre className="card-inset overflow-x-auto p-3 font-mono text-[12px] text-status-done-600">
              {bearer}
            </pre>
          </div>
        ) : (
          <div className="space-y-2">
            <textarea
              value={manifestText}
              onChange={(e) => setManifestText(e.target.value)}
              className="field h-64 font-mono text-[12px] leading-5"
            />
            {error ? <p className="text-[12px] text-status-blocked-600">{error}</p> : null}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ScopeField({
  value, onChange,
}: { value: ApiTokenScope; onChange: (v: ApiTokenScope) => void }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[11px] font-medium uppercase tracking-wider text-ink-3">
        Scope
      </label>
      <div className="flex gap-2">
        {(['read', 'read_write', 'admin'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onChange(s)}
            className={`flex-1 rounded-lg border px-3 py-2 text-left text-[12.5px] transition-colors ${
              value === s
                ? 'border-brand-500/60 bg-brand-500/10 text-ink-1'
                : 'border-border-subtle bg-bg-sunken/30 text-ink-2 hover:bg-bg-sunken/60'
            }`}
          >
            <div className="font-medium">{s}</div>
            <div className="mt-0.5 text-[11px] text-ink-3">
              {s === 'read'
                ? 'List and get items and boards.'
                : s === 'read_write'
                  ? 'Create, update, transition, comment, link.'
                  : 'Full access, including board admin.'}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
