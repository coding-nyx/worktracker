'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { sendChatTurn, ChatError, type ChatTurn, type ToolTraceEntry } from '../lib/chat';
import { useAuth } from '../lib/auth';
import { EmptyState } from './EmptyState';

interface ChatPanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Floating chat panel for the AI brain. The launcher button
 * is rendered by TopBar (the panel itself only renders when
 * `open` is true). Conversation history is per-session, in
 * memory — no persistence, no DB, no leak.
 */
export function ChatPanel({ open, onClose }: ChatPanelProps) {
  const auth = useAuth();
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [trace, setTrace] = useState<ToolTraceEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      // Reset the not-configured state every time the panel
      // opens; the user might have just rotated the API key
      // server-side.
      setNotConfigured(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    // Auto-scroll to the bottom when new messages or tool
    // traces arrive.
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history, trace, pending]);

  if (!open) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    const text = draft.trim();
    if (!text) return;
    setError(null);
    setPending(true);
    setDraft('');
    const next: ChatTurn[] = [...history, { role: 'user', content: text }];
    setHistory(next);
    setTrace([]);
    try {
      const res = await sendChatTurn(next, auth.worktrackerUser);
      setHistory((h) => [...h, res.reply]);
      setTrace(res.trace);
    } catch (err) {
      if (err instanceof ChatError) {
        if (err.code === 'ai_not_configured') setNotConfigured(true);
        setError(err.message);
      } else {
        setError((err as Error).message || 'chat failed');
      }
    } finally {
      setPending(false);
    }
  }

  function reset() {
    setHistory([]);
    setTrace([]);
    setError(null);
    setNotConfigured(false);
    setDraft('');
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 flex w-[min(420px,calc(100vw-2rem))] flex-col rounded-2xl border border-border-subtle bg-bg-raised shadow-card-lg animate-slide-in-right">
      <header className="flex items-center justify-between gap-2 border-b border-border-subtle px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span aria-hidden className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-brand-500 to-brand-700 text-white">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2 14 8.5 21 9.5 16 14 17.5 21 12 17.5 6.5 21 8 14 3 9.5 10 8.5z" />
            </svg>
          </span>
          <div>
            <div className="text-[13px] font-semibold text-ink-1">WorkTracker AI</div>
            <div className="text-[10.5px] text-ink-3">Onboard assistant</div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={reset}
            aria-label="Reset conversation"
            title="Reset"
            className="focus-ring -m-1 rounded-md p-1 text-ink-3 hover:bg-bg-sunken hover:text-ink-1"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <path d="M3 4v5h5" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chat"
            className="focus-ring -m-1 rounded-md p-1 text-ink-3 hover:bg-bg-sunken hover:text-ink-1"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18" /><path d="M6 6l12 12" />
            </svg>
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="flex max-h-[60vh] min-h-[260px] flex-col gap-3 overflow-y-auto px-4 py-3"
      >
        {history.length === 0 ? (
          notConfigured ? (
            <EmptyState
              title="AI not configured"
              body="The provider is missing AI_API_KEY (and optionally AI_BASE_URL, AI_MODEL). Set them on the API and redeploy."
            />
          ) : (
            <EmptyState
              title="Ask anything"
              body="What should I work on? Create a board for me. What's blocking the in-progress items? The AI has access to your boards, items, and the 15 worktracker_* tools."
            />
          )
        ) : (
          history.map((m, i) => (
            <Message key={i} role={m.role} content={m.content} />
          ))
        )}

        {trace.length > 0 ? (
          <div className="space-y-1.5 rounded-lg border border-border-subtle bg-bg-sunken/40 p-2.5 text-[11.5px]">
            <div className="text-[10.5px] uppercase tracking-wider text-ink-3">Tools used</div>
            {trace.map((t, i) => (
              <ToolTraceRow key={i} entry={t} />
            ))}
          </div>
        ) : null}

        {pending ? (
          <div className="flex items-center gap-2 self-start rounded-lg border border-border-subtle bg-bg-raised px-3 py-2 text-[12.5px] text-ink-3">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
            thinking…
          </div>
        ) : null}

        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-status-blocked-500/40 bg-status-blocked-500/10 px-3 py-2 text-[12.5px] text-status-blocked-600"
          >
            {error}
          </div>
        ) : null}
      </div>

      <form onSubmit={submit} className="border-t border-border-subtle p-2.5">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit(e as unknown as FormEvent);
              }
            }}
            placeholder="Ask the WorkTracker AI…"
            rows={2}
            className="field w-full resize-none text-[13.5px]"
            disabled={pending}
          />
          <button
            type="submit"
            disabled={pending || !draft.trim()}
            className="btn-primary focus-ring inline-flex h-9 w-9 shrink-0 items-center justify-center disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Send"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12 19 12" />
              <path d="m13 6 6 6-6 6" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}

function Message({ role, content }: { role: 'user' | 'assistant'; content: string }) {
  if (role === 'user') {
    return (
      <div className="self-end max-w-[88%] rounded-2xl rounded-br-md bg-brand-500/15 px-3 py-2 text-[13.5px] text-ink-1">
        {content}
      </div>
    );
  }
  return (
    <div className="self-start max-w-[88%] rounded-2xl rounded-bl-md bg-bg-sunken px-3 py-2 text-[13.5px] leading-relaxed text-ink-1">
      {content || <span className="italic text-ink-3">…</span>}
    </div>
  );
}

function ToolTraceRow({ entry }: { entry: ToolTraceEntry }) {
  const label = entry.name.replace(/^worktracker_/, '').replace(/_/g, ' ');
  return (
    <div className="flex items-center gap-2 font-mono text-ink-2">
      <span
        aria-hidden
        className={`inline-block h-1.5 w-1.5 rounded-full ${entry.ok ? 'bg-status-ready-500' : 'bg-status-blocked-500'}`}
      />
      <span className="font-sans">{label}</span>
      <span className="text-ink-3">·</span>
      <span className="truncate text-ink-3" title={JSON.stringify(entry.args, null, 2)}>
        {summarizeArgs(entry.args)}
      </span>
    </div>
  );
}

function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v == null || v === '') continue;
    if (typeof v === 'object') continue; // skip complex objects in the chip
    const s = String(v);
    parts.push(`${k}=${s.length > 24 ? `${s.slice(0, 21)}…` : s}`);
    if (parts.length >= 3) {
      parts.push('…');
      break;
    }
  }
  return parts.join(' ') || '—';
}
