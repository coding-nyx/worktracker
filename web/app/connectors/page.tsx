'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Connector, type ConnectorKind } from '../../lib/api';
import { Modal } from '../../components/Modal';
import { EmptyState } from '../../components/EmptyState';
import { Pill } from '../../components/Pill';
import { useAuth } from '../../lib/auth';

/**
 * /connectors — admin-only.
 *
 * A connector is an integration the API talks to (mirror, webhook-in,
 * webhook-out, bridge). A `Client` is who calls us; a `Connector` is
 * what we call. They are independent: registering a connector does
 * not auto-create a client.
 *
 * Slice 2: this is the first slice where Connectors are addressable
 * as a separate REST surface. The actual `protocol` impl (Hermes
 * daemon, OpenClaw bridge, GitHub mirror) is wired in slice 3+.
 */
export default function ConnectorsPage() {
  const auth = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: ['connectors'],
    queryFn: () => api.listConnectors(),
    enabled: !!auth.firebaseUser,
  });
  const [showRegister, setShowRegister] = useState(false);

  if (!auth.firebaseUser) {
    return (
      <p className="text-[13px] text-ink-3">Sign in to view connectors.</p>
    );
  }
  if (!auth.isAdmin) {
    return (
      <div className="card space-y-2 p-5">
        <h1 className="text-[15px] font-semibold text-ink-1">Connectors</h1>
        <p className="text-[13px] text-ink-2">
          Admin only. Sign in as an admin to manage integrations.
        </p>
      </div>
    );
  }

  const connectors = data?.connectors ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
            // integrations
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-ink-1">Connectors</h1>
          <p className="text-[13px] text-ink-2">
            Outbound integrations the API talks to — mirrors, webhooks, bridges. Each is a separate
            doc from its <a href="/clients" className="text-brand-500 underline">client</a> credential.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowRegister(true)}
          className="btn-primary focus-ring"
        >
          Register connector
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
        <p className="text-[13px] text-status-blocked-600">Failed to load connectors.</p>
      ) : null}

      {data ? (
        connectors.length === 0 ? (
          <EmptyState
            title="No connectors yet"
            body="Register a connector to wire an external integration (Hermes, OpenClaw, GitHub mirror)."
            action={
              <button
                type="button"
                onClick={() => setShowRegister(true)}
                className="btn-primary focus-ring"
              >
                Register connector
              </button>
            }
          />
        ) : (
          <ul className="grid gap-4 md:grid-cols-2">
            {connectors.map((c) => (
              <ConnectorCard key={c.name} connector={c} />
            ))}
          </ul>
        )
      ) : null}

      {showRegister ? (
        <RegisterConnectorModal onClose={() => setShowRegister(false)} />
      ) : null}
    </div>
  );
}

function ConnectorCard({ connector: c }: { connector: Connector }) {
  const qc = useQueryClient();
  const [patchError, setPatchError] = useState<string | null>(null);
  const [testNote, setTestNote] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.patchConnector(c.name, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connectors'] }),
    onError: (err) => setPatchError((err as Error).message),
  });

  const test = useMutation({
    mutationFn: () => api.testConnector(c.name),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['connectors'] });
      setTestNote(res.note ?? 'ok');
    },
    onError: (err) => setPatchError((err as Error).message),
  });

  return (
    <li className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="truncate text-[15px] font-semibold tracking-tight text-ink-1">
              {c.name}
            </h3>
            <Pill
              kind="backlog"
              dot={false}
              className="!ring-border-subtle !bg-bg-sunken !text-ink-2"
            >
              {c.kind}
            </Pill>
            <Pill
              kind="backlog"
              dot={false}
              className="!ring-border-subtle !bg-bg-sunken !text-ink-3"
            >
              {c.protocol}
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
                paused
              </Pill>
            )}
            {c.last_status === 'ok' ? (
              <Pill
                kind="done"
                dot={false}
                className="!ring-status-done-500/30 !bg-status-done-500/10 !text-status-done-600"
              >
                ok
              </Pill>
            ) : c.last_status === 'error' ? (
              <Pill
                kind="blocked"
                dot={false}
                className="!ring-status-blocked-500/30 !bg-status-blocked-500/10 !text-status-blocked-600"
              >
                error
              </Pill>
            ) : null}
          </div>
          <div className="space-y-1">
            {Object.keys(c.config).length > 0 ? (
              <pre className="card-inset overflow-x-auto p-2 font-mono text-[10.5px] text-ink-2">
                {JSON.stringify(c.config, null, 2)}
              </pre>
            ) : (
              <p className="text-[12px] text-ink-4">no config</p>
            )}
          </div>
          {c.last_error ? (
            <p className="text-[11.5px] text-status-blocked-600">last error: {c.last_error}</p>
          ) : null}
          {testNote ? (
            <p className="text-[11.5px] text-ink-3">// test: {testNote}</p>
          ) : null}
          {patchError ? (
            <p className="text-[11.5px] text-status-blocked-600">{patchError}</p>
          ) : null}
        </div>
        <div className="shrink-0 space-y-1 text-right text-[11px] text-ink-3">
          <p>
            last run:{' '}
            <span className="text-ink-2">
              {c.last_run_at ? new Date(c.last_run_at).toLocaleString() : 'never'}
            </span>
          </p>
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              disabled={test.isPending}
              onClick={() => { setTestNote(null); test.mutate(); }}
              className="btn-secondary focus-ring px-2.5 py-1 text-[11px] disabled:opacity-50"
            >
              {test.isPending ? 'Testing…' : 'Test'}
            </button>
            <button
              type="button"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(!c.enabled)}
              className="btn-ghost focus-ring text-[11.5px] text-ink-2 disabled:opacity-50"
            >
              {c.enabled ? 'Pause' : 'Enable'}
            </button>
          </div>
        </div>
      </div>
    </li>
  );
}

function RegisterConnectorModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ConnectorKind>('bridge');
  const [protocol, setProtocol] = useState('hermes-cli-v1');
  const [configText, setConfigText] = useState('{}');
  const [error, setError] = useState<string | null>(null);

  const register = useMutation({
    mutationFn: () => {
      let config: Record<string, unknown> = {};
      try {
        config = JSON.parse(configText);
      } catch (err) {
        throw new Error(`config is not valid JSON: ${(err as Error).message}`);
      }
      return api.registerConnector({ name, kind, protocol, config });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connectors'] });
      onClose();
    },
    onError: (err) => setError((err as Error).message),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Register connector"
      size="lg"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-secondary focus-ring">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { setError(null); register.mutate(); }}
            disabled={register.isPending || !name.trim() || !protocol.trim()}
            className="btn-primary focus-ring disabled:opacity-50"
          >
            {register.isPending ? 'Registering…' : 'Register'}
          </button>
        </>
      }
    >
      <p className="text-[13px] text-ink-2">
        Connectors are admin-only. The <code className="rounded bg-bg-sunken px-1.5 py-0.5 text-ink-1">protocol</code> field picks which impl runs in
        slice 3+; today only the placeholder test op is wired.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. hermes"
            className="field w-full text-[13px]"
            maxLength={64}
          />
        </Field>
        <Field label="Kind">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ConnectorKind)}
            className="field w-full text-[13px]"
          >
            {(['mirror', 'webhook-in', 'webhook-out', 'bridge'] as const).map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </Field>
        <Field label="Protocol" className="sm:col-span-2">
          <input
            type="text"
            value={protocol}
            onChange={(e) => setProtocol(e.target.value)}
            placeholder="e.g. hermes-cli-v1"
            className="field w-full text-[13px]"
            maxLength={120}
          />
        </Field>
        <Field label="Config (JSON)" className="sm:col-span-2">
          <textarea
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
            className="field h-40 font-mono text-[12px] leading-5"
            spellCheck={false}
          />
        </Field>
      </div>
      {error ? <p className="mt-2 text-[12px] text-status-blocked-600">{error}</p> : null}
    </Modal>
  );
}

function Field({
  label, className, children,
}: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`space-y-1.5 ${className ?? ''}`}>
      <label className="block text-[11px] font-medium uppercase tracking-wider text-ink-3">
        {label}
      </label>
      {children}
    </div>
  );
}
