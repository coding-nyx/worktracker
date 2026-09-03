'use client';

/**
 * /admin/install — the 4-step wizard (slice 7).
 *
 * Steps:
 *   1. pick   — which agent? (claude-code, codex, cline, copilot,
 *               cursor, openclaw, hermes, custom)
 *   2. bearer — POST /api/connectors/:name/invite. Server
 *               mints a kind:user client; the page renders the
 *               bearer + the rendered config block.
 *   3. test   — call GET /api/clients/introspect with the bearer
 *               to prove the credential is live before the user
 *               pastes the config into their agent.
 *   4. install — render the install_steps from the protocol
 *               module + the verify_command so the user can run
 *               it from a terminal.
 *
 * Each step is a card; the user can click Back / Next. The
 * bearer is shown ONCE in step 2 (the standard "show then
 * hide" pattern); a copy-to-clipboard is provided.
 */

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { EmptyState } from '../../../components/EmptyState';
import { Modal } from '../../../components/Modal';

interface ProtocolModule {
  name: string;
  display_name: string;
  blurb: string;
  install_steps: string[];
}

const KNOWN_PROTOCOLS: ProtocolModule[] = [
  { name: 'claude-code', display_name: 'Claude Code', blurb: "Anthropic's CLI coding agent. Reads MCP servers from `~/.claude.json` or `.mcp.json`.", install_steps: [] },
  { name: 'codex',       display_name: 'Codex CLI',    blurb: "OpenAI's CLI. Reads MCP from `~/.codex/config.toml`.",            install_steps: [] },
  { name: 'cline',       display_name: 'Cline',        blurb: 'VS Code AI extension. Configures MCP in the Cline panel.',  install_steps: [] },
  { name: 'copilot',     display_name: 'GitHub Copilot', blurb: "GitHub's agent. MCP support is rolling out.",                  install_steps: [] },
  { name: 'cursor',      display_name: 'Cursor',       blurb: "Cursor. Reads MCP from `~/.cursor/mcp.json`.",               install_steps: [] },
  { name: 'openclaw',    display_name: 'OpenClaw',     blurb: "WorkTracker's own bridge daemon.",                          install_steps: [] },
  { name: 'hermes',      display_name: 'Hermes',       blurb: 'WorkTracker local-first kanban daemon. Two-sided install.', install_steps: [] },
  { name: 'custom',      display_name: 'Custom HTTP',  blurb: 'Anything that speaks JSON-RPC 2.0 over HTTP.',                install_steps: [] },
];

type Step = 1 | 2 | 3 | 4;

export default function InstallWizardPage() {
  const auth = useAuth();
  const [step, setStep] = useState<Step>(1);
  const [pickedName, setPickedName] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ bearer: string; endpoint: string; verify_command: string; protocol: ProtocolModule } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<null | 'bearer' | 'endpoint' | 'verify'>(null);
  const [introspectResult, setIntrospectResult] = useState<{ name: string; scope: string; tool_count: number } | null>(null);

  if (!auth.firebaseUser) {
    return <p className="text-[13px] text-ink-3">Sign in to install an MCP client.</p>;
  }
  if (!auth.isAdmin) {
    return (
      <div className="card space-y-2 p-5">
        <h1 className="text-[15px] font-semibold text-ink-1">Install wizard</h1>
        <p className="text-[13px] text-ink-2">Admin only. Sign in as an admin to install MCP clients for an agent.</p>
      </div>
    );
  }

  const picked = pickedName ? KNOWN_PROTOCOLS.find((p) => p.name === pickedName) : null;

  const inviteMut = useMutation({
    mutationFn: (name: string) => api.inviteConnector(name),
    onSuccess: (res) => {
      setInvite({
        bearer: res.bearer,
        endpoint: res.endpoint,
        verify_command: res.verify_command,
        protocol: {
          name: res.protocol.name,
          display_name: res.protocol.display_name,
          blurb: res.protocol.blurb,
          install_steps: res.protocol.install_steps ?? [],
        },
      });
      setStep(2);
    },
    onError: (err) => setError((err as Error).message),
  });

  const testMut = useMutation({
    mutationFn: async (bearer: string) => {
      // The introspect endpoint requires the worker's auth
      // (the admin's Firebase ID token). We override the bearer
      // by calling the REST endpoint directly with a manual
      // Authorization header via a custom fetch.
      const res = await fetch('/api/clients/introspect', {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`introspect failed: ${res.status} ${text.slice(0, 200)}`);
      }
      return res.json() as Promise<{ name: string; scope: string; visible_tools: string[] }>;
    },
    onSuccess: (data) => {
      setIntrospectResult({
        name: data.name,
        scope: data.scope,
        tool_count: data.visible_tools?.length ?? 0,
      });
      setStep(3);
    },
    onError: (err) => setError((err as Error).message),
  });

  async function copy(field: 'bearer' | 'endpoint' | 'verify', text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(field);
      window.setTimeout(() => setCopied(null), 1800);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">// install</p>
        <h1 className="text-2xl font-bold tracking-tight text-ink-1">Connect an MCP client</h1>
        <p className="text-[13px] text-ink-2">
          Mint a credential and paste the config into your agent. Each step validates the previous one.
        </p>
      </header>

      <Stepper step={step} />

      {error ? (
        <div role="alert" className="card-inset border-status-blocked-500/40 bg-status-blocked-500/5 px-3.5 py-2.5 text-[13px] text-status-blocked-600">
          {error}
        </div>
      ) : null}

      {step === 1 ? (
        <PickStep onPick={(name) => { setPickedName(name); setError(null); inviteMut.mutate(name); }} disabled={inviteMut.isPending} />
      ) : null}

      {step === 2 && invite ? (
        <BearerStep
          invite={invite}
          copied={copied}
          onCopy={copy}
          onTest={() => { setError(null); testMut.mutate(invite.bearer); }}
          onBack={() => setStep(1)}
          testing={testMut.isPending}
        />
      ) : null}

      {step === 3 ? (
        <TestStep
          loading={testMut.isPending}
          result={introspectResult}
          onNext={() => setStep(4)}
          onBack={() => setStep(2)}
        />
      ) : null}

      {step === 4 && invite ? (
        <InstallStep
          invite={invite}
          copied={copied}
          onCopy={copy}
          onDone={() => { setStep(1); setPickedName(null); setInvite(null); setIntrospectResult(null); }}
        />
      ) : null}
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const labels: Array<{ n: Step; label: string }> = [
    { n: 1, label: 'pick' },
    { n: 2, label: 'bearer' },
    { n: 3, label: 'test' },
    { n: 4, label: 'install' },
  ];
  return (
    <ol className="flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wider text-ink-3">
      {labels.map((s, i) => (
        <li key={s.n} className="flex items-center gap-1.5">
          <span
            className={`inline-flex h-5 w-5 items-center justify-center rounded-full border ${
              s.n <= step
                ? 'border-brand-500 bg-brand-500/10 text-brand-500'
                : 'border-border-subtle text-ink-3'
            }`}
            aria-current={s.n === step ? 'step' : undefined}
          >
            {s.n}
          </span>
          <span className={s.n === step ? 'text-brand-500' : ''}>{s.label}</span>
          {i < labels.length - 1 ? <span aria-hidden className="text-ink-4">·</span> : null}
        </li>
      ))}
    </ol>
  );
}

function PickStep({ onPick, disabled }: { onPick: (name: string) => void; disabled: boolean }) {
  return (
    <section className="card space-y-4 p-5">
      <h2 className="text-[15px] font-semibold text-ink-1">Step 1 · Pick an agent</h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {KNOWN_PROTOCOLS.map((p) => (
          <li key={p.name}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(p.name)}
              className="card-inset w-full px-4 py-3 text-left transition-colors hover:bg-bg-sunken/60 disabled:opacity-50"
            >
              <p className="font-mono text-[10.5px] uppercase tracking-wider text-brand-500">{p.name}</p>
              <p className="mt-0.5 text-[14px] font-semibold text-ink-1">{p.display_name}</p>
              <p className="mt-1 text-[12.5px] text-ink-2">{p.blurb}</p>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function BearerStep({
  invite, copied, onCopy, onTest, onBack, testing,
}: {
  invite: { bearer: string; endpoint: string; protocol: ProtocolModule };
  copied: 'bearer' | 'endpoint' | 'verify' | null;
  onCopy: (field: 'bearer' | 'endpoint' | 'verify', text: string) => void;
  onTest: () => void;
  onBack: () => void;
  testing: boolean;
}) {
  return (
    <section className="card space-y-4 p-5">
      <header>
        <h2 className="text-[15px] font-semibold text-ink-1">Step 2 · Bearer issued</h2>
        <p className="text-[12.5px] text-ink-2">
          The bearer is shown once. Copy it; you will not see it again.
        </p>
      </header>
      <div className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-wider text-ink-3">Bearer</p>
        <pre className="card-inset overflow-x-auto p-3 font-mono text-[12px] text-status-ready-600">
          {invite.bearer}
        </pre>
        <button onClick={() => onCopy('bearer', invite.bearer)} className="btn-secondary focus-ring px-3 py-1 text-[12px]">
          {copied === 'bearer' ? 'Copied' : 'Copy bearer'}
        </button>
      </div>
      <div className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-wider text-ink-3">Config to paste into {invite.protocol.display_name}</p>
        <pre className="card-inset overflow-x-auto p-3 font-mono text-[12px] text-ink-1">
          {invite.endpoint}
        </pre>
        <button onClick={() => onCopy('endpoint', invite.endpoint)} className="btn-secondary focus-ring px-3 py-1 text-[12px]">
          {copied === 'endpoint' ? 'Copied' : 'Copy config'}
        </button>
      </div>
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="btn-ghost focus-ring text-[13px] text-ink-2">← Back</button>
        <button onClick={onTest} disabled={testing} className="btn-primary focus-ring px-4 py-2 text-[13px] disabled:opacity-50">
          {testing ? 'Testing…' : 'Test the bearer →'}
        </button>
      </div>
    </section>
  );
}

function TestStep({
  result, loading, onNext, onBack,
}: { result: { name: string; scope: string; tool_count: number } | null; loading: boolean; onNext: () => void; onBack: () => void }) {
  return (
    <section className="card space-y-4 p-5">
      <header>
        <h2 className="text-[15px] font-semibold text-ink-1">Step 3 · Verify</h2>
        <p className="text-[12.5px] text-ink-2">
          The wizard called <code className="rounded bg-bg-sunken px-1 py-0.5 font-mono text-[11.5px]">/api/clients/introspect</code> with the fresh bearer.
        </p>
      </header>
      {loading ? (
        <div className="card-inset px-4 py-3 text-[13px] text-ink-2">Calling /api/clients/introspect…</div>
      ) : result ? (
        <div className="card-inset space-y-2 border-status-done-500/30 bg-status-done-500/5 px-4 py-3">
          <p className="text-[13px] text-status-done-600">Introspect succeeded.</p>
          <dl className="grid grid-cols-[120px_1fr] gap-y-1 font-mono text-[12px]">
            <dt className="text-ink-3">name</dt><dd className="text-ink-1">{result.name}</dd>
            <dt className="text-ink-3">scope</dt><dd className="text-ink-1">{result.scope}</dd>
            <dt className="text-ink-3">visible_tools</dt><dd className="text-ink-1">{result.tool_count}</dd>
          </dl>
        </div>
      ) : null}
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="btn-ghost focus-ring text-[13px] text-ink-2">← Back</button>
        <button onClick={onNext} disabled={!result} className="btn-primary focus-ring px-4 py-2 text-[13px] disabled:opacity-50">
          Install →
        </button>
      </div>
    </section>
  );
}

function InstallStep({
  invite, copied, onCopy, onDone,
}: {
  invite: { bearer: string; endpoint: string; verify_command: string; protocol: ProtocolModule };
  copied: 'bearer' | 'endpoint' | 'verify' | null;
  onCopy: (field: 'bearer' | 'endpoint' | 'verify', text: string) => void;
  onDone: () => void;
}) {
  return (
    <section className="card space-y-4 p-5">
      <header>
        <h2 className="text-[15px] font-semibold text-ink-1">Step 4 · Install</h2>
        <p className="text-[12.5px] text-ink-2">
          Follow the steps in {invite.protocol.display_name}, then run the verify command to confirm everything is wired.
        </p>
      </header>
      <ol className="list-decimal space-y-2 pl-5 text-[13px] text-ink-1">
        {invite.protocol.install_steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <div className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-wider text-ink-3">Verify from a terminal</p>
        <pre className="card-inset overflow-x-auto p-3 font-mono text-[12px] text-ink-1">
          {invite.verify_command}
        </pre>
        <button onClick={() => onCopy('verify', invite.verify_command)} className="btn-secondary focus-ring px-3 py-1 text-[12px]">
          {copied === 'verify' ? 'Copied' : 'Copy verify command'}
        </button>
      </div>
      <div className="flex justify-end">
        <button onClick={onDone} className="btn-primary focus-ring px-4 py-2 text-[13px]">
          Done
        </button>
      </div>
    </section>
  );
}
