'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiTokenScope, Client } from '@worktracker/types';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Pill } from './Pill';
import { Modal } from './Modal';

/**
 * "Your personal clients" — slice 2 view of the Settings page.
 *
 * Replaces the old "Personal API tokens" panel. Personal access
 * tokens are now `kind: 'user'` rows in the `sources` collection,
 * minted via `POST /api/clients/mint`. The list is filtered
 * client-side to the signed-in user's `owner_uid`.
 *
 * Scope legend:
 *   - read        list/get items and boards
 *   - read_write  read + create/update/transition/comment/link
 *   - admin       read+write + board admin tools (admins only)
 *
 * The bearer plaintext is never stored. The list endpoint
 * returns the record (name, scope, last_used_at, revoked_at)
 * without the secret. Only the mint endpoint returns the bearer;
 * we surface it once and never again.
 */
export function PersonalClientsSection() {
  const auth = useAuth();
  const qc = useQueryClient();
  const [showMint, setShowMint] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; bearer: string; scope: ApiTokenScope } | null>(null);
  const [copied, setCopied] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['clients', 'mine'],
    queryFn: () => api.listClients(),
    enabled: !!auth.firebaseUser,
  });
  const all = data?.clients ?? [];
  // Filter to the signed-in user's personal clients. The server
  // doesn't have a /api/clients?owner_uid=me shortcut yet, so the
  // client filters. With v0 scale this is fine.
  const mine = auth.firebaseUser
    ? all.filter((c) => c.kind === 'user' && c.owner_uid === auth.firebaseUser?.uid)
    : [];

  const mint = useMutation({
    mutationFn: (body: { name: string; scope: ApiTokenScope }) => {
      if (!auth.firebaseUser) throw new Error('not signed in');
      return api.mintClient({
        name: body.name,
        scope: body.scope,
        owner_uid: auth.firebaseUser.uid,
        owner_email: auth.firebaseUser.email ?? '',
      });
    },
    onSuccess: ({ client, bearer }) => {
      qc.invalidateQueries({ queryKey: ['clients'] });
      setShowMint(false);
      setRevealed({ name: client.display_name, bearer, scope: client.scope });
      setCopied(false);
    },
    onError: (err) => setPageError((err as Error).message),
  });

  const revoke = useMutation({
    mutationFn: (name: string) => api.revokeClient(name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients'] });
    },
    onError: (err) => setPageError((err as Error).message),
  });

  const rotate = useMutation({
    mutationFn: (name: string) => api.rotateClient(name),
    onSuccess: ({ client, bearer }) => {
      qc.invalidateQueries({ queryKey: ['clients'] });
      setRevealed({ name: client.display_name, bearer, scope: client.scope });
      setCopied(false);
    },
    onError: (err) => setPageError((err as Error).message),
  });

  async function copyBearer() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.bearer);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (err) {
      setPageError((err as Error).message);
    }
  }

  if (!auth.firebaseUser) return null;

  return (
    <section className="card space-y-3 p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-[13px] font-semibold uppercase tracking-wider text-ink-3">
            Your personal clients
          </h2>
          <p className="text-[12.5px] text-ink-2">
            Mint a bearer for an external MCP client (Claude Code, Codex, Hermes). Each one is a
            <code className="mx-1 rounded bg-bg-sunken px-1 py-0.5 font-mono text-[11px] text-ink-1">kind: user</code>
            row in the clients collection — see <a href="/clients" className="text-brand-500 underline">/clients</a> for the full
            admin view. Treat each bearer like a password — it can read or mutate your kanban, depending on its scope.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setPageError(null); setShowMint(true); }}
          className="btn-primary focus-ring inline-flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] font-medium"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 5v14" /><path d="M5 12h14" />
          </svg>
          Mint client
        </button>
      </div>

      {pageError ? (
        <div role="alert" className="rounded-lg border border-status-blocked-500/40 bg-status-blocked-500/10 px-3 py-2 text-[12.5px] text-status-blocked-600">
          {pageError}
          <button onClick={() => setPageError(null)} className="ml-3 underline">dismiss</button>
        </div>
      ) : null}

      {isLoading ? (
        <div className="text-[13px] text-ink-3">Loading clients…</div>
      ) : error ? (
        <div className="rounded-lg border border-status-blocked-500/40 bg-status-blocked-500/10 px-3 py-2 text-[12.5px] text-status-blocked-600">
          {(error as Error).message}
        </div>
      ) : mine.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-subtle bg-bg-sunken/40 px-6 py-8 text-center text-[13px] text-ink-3">
          No personal clients yet. Mint one to connect an external MCP client.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border-subtle">
          <table className="w-full text-[13px]">
            <thead className="bg-bg-sunken/60 text-[11px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">Name</th>
                <th className="px-4 py-2.5 text-left font-medium">Scope</th>
                <th className="px-4 py-2.5 text-left font-medium">Created</th>
                <th className="px-4 py-2.5 text-left font-medium">Last used</th>
                <th className="px-4 py-2.5 text-left font-medium">Status</th>
                <th className="px-4 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {mine.map((c) => (
                <ClientRow
                  key={c.name}
                  client={c}
                  busyRevoke={revoke.isPending && revoke.variables === c.name}
                  busyRotate={rotate.isPending && rotate.variables === c.name}
                  onRevoke={() => revoke.mutate(c.name)}
                  onRotate={() => rotate.mutate(c.name)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <MintModal
        open={showMint}
        isAdmin={auth.isAdmin}
        onClose={() => { if (!mint.isPending) setShowMint(false); }}
        onSubmit={(body) => mint.mutate(body)}
        pending={mint.isPending}
        error={mint.error ? (mint.error as Error).message : null}
      />

      <RevealModal
        revealed={revealed}
        onClose={() => setRevealed(null)}
        copied={copied}
        onCopy={copyBearer}
      />
    </section>
  );
}

function ClientRow({
  client: c, busyRevoke, busyRotate, onRevoke, onRotate,
}: {
  client: Client;
  busyRevoke: boolean;
  busyRotate: boolean;
  onRevoke: () => void;
  onRotate: () => void;
}) {
  const isRevoked = !!c.revoked_at;
  return (
    <tr className="bg-bg-base/30">
      <td className="px-4 py-3 text-ink-1">
        <div className="font-medium">{c.display_name}</div>
        <div className="mt-0.5 break-all font-mono text-[10.5px] text-ink-3">{c.name}</div>
      </td>
      <td className="px-4 py-3">
        <ScopePill scope={c.scope} />
      </td>
      <td className="px-4 py-3 text-ink-2">{new Date(c.created_at).toLocaleString()}</td>
      <td className="px-4 py-3 text-ink-3">
        {c.last_used_at ? new Date(c.last_used_at).toLocaleString() : '—'}
      </td>
      <td className="px-4 py-3">
        {isRevoked ? (
          <Pill kind="blocked" dot={false}>revoked</Pill>
        ) : (
          <Pill kind="ready" dot={false}>active</Pill>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        {isRevoked ? (
          <span className="text-[12px] text-ink-3">—</span>
        ) : (
          <div className="inline-flex gap-1.5">
            <button
              type="button"
              disabled={busyRotate}
              onClick={onRotate}
              className="btn-ghost focus-ring text-[12px] text-brand-500 disabled:opacity-50"
            >
              {busyRotate ? 'Rotating…' : 'Rotate'}
            </button>
            <button
              type="button"
              disabled={busyRevoke}
              onClick={onRevoke}
              className="btn-ghost focus-ring text-[12px] text-status-blocked-600 disabled:opacity-50"
            >
              {busyRevoke ? 'Revoking…' : 'Revoke'}
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

function ScopePill({ scope }: { scope: ApiTokenScope }) {
  if (scope === 'admin') return <Pill kind="ready" dot={false}>admin</Pill>;
  if (scope === 'read_write') return <Pill kind="progress" dot={false}>read+write</Pill>;
  return <Pill kind="backlog" dot={false}>read</Pill>;
}

function MintModal({
  open, isAdmin, onClose, onSubmit, pending, error,
}: {
  open: boolean;
  isAdmin: boolean;
  onClose: () => void;
  onSubmit: (body: { name: string; scope: ApiTokenScope }) => void;
  pending: boolean;
  error: string | null;
}) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<ApiTokenScope>('read_write');
  const [localError, setLocalError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (!name.trim()) {
      setLocalError('Name is required.');
      return;
    }
    onSubmit({ name: name.trim(), scope });
  }

  return (
    <Modal open={open} onClose={onClose} title="Mint personal client" size="md">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="text-[12.5px] text-ink-2">
          The bearer is shown exactly once. Copy it into your MCP client config (e.g. Claude Code's
          <code className="rounded bg-bg-sunken px-1 py-0.5 font-mono text-[11px]"> .mcp.json </code>)
          before you close this dialog.
        </p>
        <Field label="Name">
          <input
            type="text"
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Claude Code laptop"
            className="field w-full text-[14px]"
            disabled={pending}
            maxLength={120}
          />
        </Field>
        <Field label="Scope">
          <div className="space-y-1.5">
            <ScopeRadio
              value="read"
              checked={scope === 'read'}
              onChange={() => setScope('read')}
              disabled={pending}
              title="Read"
              hint="List and get items and boards. No mutations."
            />
            <ScopeRadio
              value="read_write"
              checked={scope === 'read_write'}
              onChange={() => setScope('read_write')}
              disabled={pending}
              title="Read + write"
              hint="Create, update, transition, comment, link. No board admin."
              defaultChecked
            />
            <ScopeRadio
              value="admin"
              checked={scope === 'admin'}
              onChange={() => setScope('admin')}
              disabled={pending || !isAdmin}
              title={isAdmin ? 'Admin' : 'Admin (admins only)'}
              hint="Full access, including board admin tools."
            />
          </div>
        </Field>
        {(localError || error) ? (
          <div role="alert" className="rounded-lg border border-status-blocked-500/40 bg-status-blocked-500/10 px-3 py-2 text-[12.5px] text-status-blocked-600">
            {localError || error}
          </div>
        ) : null}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="btn-ghost focus-ring text-[13px] text-ink-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="btn-primary focus-ring px-4 py-2 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'Minting…' : 'Mint client'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ScopeRadio({
  value, checked, onChange, disabled, title, hint, defaultChecked,
}: {
  value: ApiTokenScope;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  title: string;
  hint: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className={`flex items-start gap-2.5 rounded-lg border border-border-subtle bg-bg-sunken/30 p-2.5 ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-bg-sunken/60'}`}>
      <input
        type="radio"
        name="client-scope"
        value={value}
        checked={checked}
        defaultChecked={defaultChecked}
        onChange={onChange}
        disabled={disabled}
        className="mt-1 h-4 w-4 shrink-0 border-border-subtle bg-bg-raised text-brand-500 focus:ring-brand-500"
      />
      <div className="space-y-0.5">
        <div className="text-[13px] font-medium text-ink-1">{title}</div>
        <div className="text-[12px] text-ink-2">{hint}</div>
      </div>
    </label>
  );
}

function RevealModal({
  revealed, onClose, copied, onCopy,
}: {
  revealed: { name: string; bearer: string; scope: ApiTokenScope } | null;
  onClose: () => void;
  copied: boolean;
  onCopy: () => void;
}) {
  if (!revealed) return null;
  return (
    <Modal open onClose={onClose} title="Client minted" size="md">
      <div className="space-y-3.5">
        <div className="rounded-lg border border-status-ready-500/40 bg-status-ready-500/10 p-3 text-[12.5px] text-status-ready-600">
          Copy this bearer now. It will not be shown again.
        </div>
        <Field label="Name"><div className="text-[13.5px] text-ink-1">{revealed.name}</div></Field>
        <Field label="Scope"><ScopePill scope={revealed.scope} /></Field>
        <Field label="Bearer">
          <div className="rounded-lg border border-border-subtle bg-bg-sunken/40 p-2.5">
            <code className="block max-w-full break-all font-mono text-[11.5px] text-ink-1">
              {revealed.bearer}
            </code>
          </div>
        </Field>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCopy}
            className="btn-primary focus-ring px-3.5 py-1.5 text-[12.5px] font-medium"
          >
            {copied ? 'Copied' : 'Copy to clipboard'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost focus-ring text-[12.5px] text-ink-2"
          >
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[11px] font-medium uppercase tracking-wider text-ink-3">{label}</label>
      {children}
    </div>
  );
}

// Re-export the old name so any caller still importing
// `ApiTokensSection` from this file gets a clear message instead
// of a missing symbol.
export { PersonalClientsSection as ApiTokensSection };
