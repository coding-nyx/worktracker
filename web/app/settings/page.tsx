'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { EmailAuthProvider, reauthenticateWithCredential, updatePassword } from 'firebase/auth';
import { useAuth } from '../../lib/auth';
import { getFirebaseAuth } from '../../lib/firebase';
import { Pill } from '../../components/Pill';

/**
 * Personal settings for the signed-in user:
 *   - email + role (read-only, from the worktracker user record)
 *   - "Copy latest ID token" — one-click copy the current Firebase
 *     ID token to the clipboard. Useful for pasting into Claude
 *     Code / Codex / Hermes to authenticate the MCP server.
 *   - Change password — requires the current password because
 *     Firebase Auth's updatePassword() needs a recent
 *     credential for sensitive ops.
 *   - Sign out — same effect as the top-bar sign-out button.
 */
export default function SettingsPage() {
  const auth = useAuth();
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [tokenPreview, setTokenPreview] = useState<string | null>(null);

  // Refresh the ID token on mount so the user always sees a
  // fresh one (Firebase Auth's auto-refresh keeps it valid for
  // an hour, but a tab that's been open all day might show an
  // older one).
  useEffect(() => {
    if (!auth.firebaseUser) return;
    let cancelled = false;
    (async () => {
      try {
        const t = await auth.getIdToken();
        if (!cancelled) setTokenPreview(t ?? null);
      } catch {
        // ignore — the user will see "no token" if it fails
      }
    })();
    return () => { cancelled = true; };
  }, [auth]);

  async function copyToken() {
    setCopyError(null);
    try {
      const t = await auth.getIdToken();
      if (!t) {
        setCopyError('No ID token — sign in again.');
        return;
      }
      setTokenPreview(t);
      await navigator.clipboard.writeText(t);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (err) {
      setCopyError((err as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-5 py-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-ink-1">Settings</h1>
        <p className="text-[13px] text-ink-2">
          Personal account and credentials. Admin settings live under <a href="/admin/users" className="text-brand-500 underline">/admin/users</a>.
        </p>
      </header>

      <section className="card space-y-3 p-5">
        <h2 className="text-[13px] font-semibold uppercase tracking-wider text-ink-3">Account</h2>
        <Row label="Email">{auth.firebaseUser?.email ?? '—'}</Row>
        <Row label="Role">
          {auth.isAdmin ? (
            <Pill kind="ready" dot={false}>admin</Pill>
          ) : (
            <Pill kind="backlog" dot={false}>member</Pill>
          )}
        </Row>
        <Row label="UID">
          <code className="font-mono text-[11.5px] text-ink-2">
            {auth.worktrackerUser?.firebase_uid ?? auth.firebaseUser?.uid ?? '—'}
          </code>
        </Row>
      </section>

      <section className="card space-y-3 p-5">
        <h2 className="text-[13px] font-semibold uppercase tracking-wider text-ink-3">MCP ID token</h2>
        <p className="text-[12.5px] text-ink-2">
          The current Firebase ID token. Paste it into Claude Code, Codex, or Hermes to authenticate
          the WorkTracker MCP server (<code className="rounded bg-bg-sunken px-1 py-0.5 font-mono text-[11.5px]">Authorization: Bearer &lt;token&gt;</code>).
          Tokens expire in one hour; copy a fresh one when needed.
        </p>
        <div className="rounded-lg border border-border-subtle bg-bg-sunken/40 p-2.5">
          <code className="block max-w-full break-all font-mono text-[11.5px] text-ink-2">
            {tokenPreview ? `${tokenPreview.slice(0, 48)}…` : '—'}
          </code>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={copyToken}
            className="btn-primary focus-ring inline-flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] font-medium"
          >
            {copied ? 'Copied' : 'Copy latest ID token'}
          </button>
          {copyError ? <span className="text-[12px] text-status-blocked-600">{copyError}</span> : null}
        </div>
      </section>

      <ChangePasswordSection />

      <section className="card space-y-3 p-5">
        <h2 className="text-[13px] font-semibold uppercase tracking-wider text-ink-3">Session</h2>
        <button
          type="button"
          onClick={async () => {
            await auth.signOut();
            router.replace('/login');
          }}
          className="btn-ghost focus-ring text-[13px] text-ink-2"
        >
          Sign out
        </button>
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-[13px]">
      <span className="w-16 shrink-0 text-[11px] uppercase tracking-wider text-ink-3">{label}</span>
      <span className="text-ink-1">{children}</span>
    </div>
  );
}

function ChangePasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSuccess(false);
    if (next.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (next !== confirm) {
      setError('New password and confirmation do not match.');
      return;
    }
    const user = getFirebaseAuth().currentUser;
    const email = user?.email;
    if (!user || !email) {
      setError('Not signed in.');
      return;
    }
    setSubmitting(true);
    try {
      const credential = EmailAuthProvider.credential(email, current);
      await reauthenticateWithCredential(user, credential);
      await updatePassword(user, next);
      setSuccess(true);
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setError(humanizeAuthError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="card space-y-3 p-5">
      <h2 className="text-[13px] font-semibold uppercase tracking-wider text-ink-3">Change password</h2>
      <form onSubmit={submit} className="space-y-2.5" noValidate>
        <PwdField label="Current password" value={current} onChange={setCurrent} disabled={submitting} autoComplete="current-password" />
        <PwdField label="New password" value={next} onChange={setNext} disabled={submitting} autoComplete="new-password" />
        <PwdField label="Confirm new password" value={confirm} onChange={setConfirm} disabled={submitting} autoComplete="new-password" />
        {error ? (
          <div className="rounded-lg border border-status-blocked-500/40 bg-status-blocked-500/10 px-3 py-2 text-[12.5px] text-status-blocked-600">
            {error}
          </div>
        ) : null}
        {success ? (
          <div className="rounded-lg border border-status-ready-500/40 bg-status-ready-500/10 px-3 py-2 text-[12.5px] text-status-ready-600">
            Password updated. Use the new one next time you sign in.
          </div>
        ) : null}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={submitting || !current || !next || !confirm}
            className="btn-primary focus-ring px-3.5 py-2 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Updating…' : 'Update password'}
          </button>
        </div>
      </form>
    </section>
  );
}

function PwdField({
  label, value, onChange, disabled, autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  autoComplete?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-[11px] uppercase tracking-wider text-ink-3">{label}</label>
      <input
        type="password"
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="field w-full text-[14px]"
        disabled={disabled}
      />
    </div>
  );
}

function humanizeAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  if (code === 'auth/wrong-password' || code === 'auth/invalid-credential' || code === 'auth/invalid-login-credentials') {
    return 'Current password is incorrect.';
  }
  if (code === 'auth/weak-password') {
    return 'New password is too weak.';
  }
  if (code === 'auth/requires-recent-login') {
    return 'For security, sign out and back in before changing your password.';
  }
  return (err as Error)?.message ?? 'Password change failed.';
}
