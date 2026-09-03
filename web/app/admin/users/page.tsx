'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorktrackerUser } from '@worktracker/types';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { Pill } from '../../../components/Pill';
import { Modal } from '../../../components/Modal';

export default function AdminUsersPage() {
  const auth = useAuth();
  const qc = useQueryClient();
  const [showInvite, setShowInvite] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api.listUsers(),
  });
  const users = data?.users ?? [];
  const selfUid = auth.worktrackerUser?.firebase_uid ?? null;

  const update = useMutation({
    mutationFn: ({ uid, patch }: { uid: string; patch: Parameters<typeof api.updateUser>[1] }) =>
      api.updateUser(uid, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      qc.invalidateQueries({ queryKey: ['item', 'auth', 'me'] });
    },
    onError: (err) => setPageError((err as Error).message),
  });

  const invite = useMutation({
    mutationFn: (body: Parameters<typeof api.inviteUser>[0]) => api.inviteUser(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      setShowInvite(false);
    },
    onError: (err) => setPageError((err as Error).message),
  });

  if (!auth.isAdmin) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-12 text-center">
        <h1 className="text-xl font-semibold text-ink-1">Admins only</h1>
        <p className="mt-2 text-[13px] text-ink-2">
          You need <code className="rounded bg-bg-sunken px-1.5 py-0.5">is_admin: true</code> to manage users.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-5 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-ink-1">Users</h1>
          <p className="text-[13px] text-ink-2">
            Manage who can sign in. The first user to sign in is auto-promoted to admin; everyone else needs an invite.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setPageError(null); setShowInvite(true); }}
          className="btn-primary focus-ring inline-flex items-center gap-1.5 px-3.5 py-2 text-[13px] font-medium"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 5v14" /><path d="M5 12h14" />
          </svg>
          Invite user
        </button>
      </header>

      {pageError ? (
        <div
          role="alert"
          className="rounded-lg border border-status-blocked/40 bg-status-blocked/10 px-3 py-2 font-mono text-[11.5px] tracking-mono-wide text-status-blocked"
        >
          {pageError}
          <button onClick={() => setPageError(null)} className="ml-3 underline">dismiss</button>
        </div>
      ) : null}

      {isLoading ? (
        <div className="text-[13px] text-ink-3">Loading users…</div>
      ) : error ? (
        <div className="rounded-lg border border-status-blocked/40 bg-status-blocked/10 px-3 py-2 font-mono text-[11.5px] tracking-mono-wide text-status-blocked">
          {(error as Error).message}
        </div>
      ) : users.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-subtle bg-bg-sunken/40 px-6 py-10 text-center text-[13px] text-ink-3">
          No users yet.
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-[13px]">
            <thead className="bg-bg-sunken/60 text-[11px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">Email</th>
                <th className="px-4 py-2.5 text-left font-medium">Name</th>
                <th className="px-4 py-2.5 text-left font-medium">Role</th>
                <th className="px-4 py-2.5 text-left font-medium">Status</th>
                <th className="px-4 py-2.5 text-left font-medium">Last seen</th>
                <th className="px-4 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {users.map((u) => (
                <UserRow
                  key={u.firebase_uid}
                  user={u}
                  isSelf={u.firebase_uid === selfUid}
                  busy={update.isPending && update.variables?.uid === u.firebase_uid}
                  onToggleAdmin={() =>
                    update.mutate({ uid: u.firebase_uid, patch: { is_admin: !u.is_admin } })
                  }
                  onToggleEnabled={() =>
                    update.mutate({ uid: u.firebase_uid, patch: { enabled: !u.enabled } })
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <InviteModal
        open={showInvite}
        onClose={() => { if (!invite.isPending) setShowInvite(false); }}
        onSubmit={(body) => invite.mutate(body)}
        pending={invite.isPending}
        error={invite.error ? (invite.error as Error).message : null}
      />
    </div>
  );
}

function UserRow({
  user, isSelf, busy, onToggleAdmin, onToggleEnabled,
}: {
  user: WorktrackerUser;
  isSelf: boolean;
  busy: boolean;
  onToggleAdmin: () => void;
  onToggleEnabled: () => void;
}) {
  return (
    <tr className="bg-bg-base/30">
      <td className="px-4 py-3 text-ink-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{user.email || <span className="italic text-ink-3">no email</span>}</span>
          {isSelf ? (
            <Pill kind="ready" dot={false} className="!ring-status-ready/30 !bg-status-ready/10 !text-status-ready">
              you
            </Pill>
          ) : null}
        </div>
        <div className="mt-0.5 font-mono text-[10.5px] text-ink-3">{user.firebase_uid}</div>
      </td>
      <td className="px-4 py-3 text-ink-2">{user.display_name ?? '—'}</td>
      <td className="px-4 py-3">
        {user.is_admin ? (
          <Pill kind="ready" dot={false}>admin</Pill>
        ) : (
          <Pill kind="backlog" dot={false}>member</Pill>
        )}
      </td>
      <td className="px-4 py-3">
        {user.enabled ? (
          <Pill kind="ready" dot={false}>active</Pill>
        ) : (
          <Pill kind="blocked" dot={false}>disabled</Pill>
        )}
      </td>
      <td className="px-4 py-3 text-ink-3">
        {user.last_seen_at ? new Date(user.last_seen_at).toLocaleString() : '—'}
      </td>
      <td className="px-4 py-3 text-right">
        <div className="inline-flex items-center gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={onToggleAdmin}
            className="btn-ghost focus-ring text-[12px] disabled:opacity-50"
          >
            {user.is_admin ? 'Demote' : 'Promote'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onToggleEnabled}
            className="btn-ghost focus-ring text-[12px] disabled:opacity-50"
          >
            {user.enabled ? 'Disable' : 'Enable'}
          </button>
        </div>
      </td>
    </tr>
  );
}

function InviteModal({
  open, onClose, onSubmit, pending, error,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (body: { email: string; password: string; display_name?: string; is_admin?: boolean }) => void;
  pending: boolean;
  error: string | null;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (!email.trim() || !password) {
      setLocalError('Email and password are required.');
      return;
    }
    if (password.length < 8) {
      setLocalError('Password must be at least 8 characters.');
      return;
    }
    onSubmit({
      email: email.trim(),
      password,
      display_name: displayName.trim() || undefined,
      is_admin: isAdmin,
    });
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!pending) { onClose(); } }}
      title="Invite user"
      size="md"
    >
      <form onSubmit={submit} className="space-y-3.5" noValidate>
        <p className="text-[12.5px] text-ink-2">
          Creates a Firebase Auth account and the matching worktracker user record. The user signs in with the email and password you set here — share them out of band.
        </p>
        <Field label="Email">
          <input
            type="email"
            autoFocus
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="field w-full text-[14px]"
            disabled={pending}
          />
        </Field>
        <Field label="Temp password">
          <input
            type="text"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="field w-full font-mono text-[13px]"
            placeholder="at least 8 characters"
            disabled={pending}
          />
        </Field>
        <Field label="Display name (optional)">
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="field w-full text-[14px]"
            disabled={pending}
          />
        </Field>
        <label className="flex items-center gap-2 text-[13px] text-ink-2">
          <input
            type="checkbox"
            checked={isAdmin}
            onChange={(e) => setIsAdmin(e.target.checked)}
            className="h-4 w-4 rounded border-border-subtle bg-bg-raised text-brand-500 focus:ring-brand-500"
            disabled={pending}
          />
          Promote to admin on creation
        </label>
        {(localError || error) ? (
          <div
            role="alert"
            className="rounded-lg border border-status-blocked/40 bg-status-blocked/10 px-3 py-2 font-mono text-[11.5px] tracking-mono-wide text-status-blocked"
          >
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
            {pending ? 'Creating…' : 'Create user'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[11.5px] font-medium uppercase tracking-wider text-ink-3">{label}</label>
      {children}
    </div>
  );
}
