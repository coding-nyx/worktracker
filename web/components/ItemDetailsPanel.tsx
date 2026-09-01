'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkItem, WorkItemEvent, WorkItemStatus, WorkItemKind } from '@worktracker/types';
import { api } from '../lib/api';
import { Pill, statusToPillKind, type StatusKind } from './Pill';

const KINDS: WorkItemKind[] = ['task', 'ticket', 'decision', 'review'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
const PRIORITIES = ['low', 'medium', 'high'] as const;
const STATUSES: WorkItemStatus[] = [
  'open', 'ready', 'in_progress', 'blocked', 'done', 'cancelled',
];

/**
 * Slide-in details panel for a single work item. Read by
 * default; switches to edit mode via "Edit", shows comments
 * inline, and supports archive/unarchive. Close via Escape,
 * the X, or clicking the backdrop.
 */
export function ItemDetailsPanel({
  itemId,
  onClose,
  onChanged,
}: {
  itemId: string | null;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const qc = useQueryClient();
  const open = Boolean(itemId);
  const [editing, setEditing] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState(false);

  const { data: item, isLoading, error } = useQuery({
    queryKey: ['item', itemId],
    queryFn: () => api.getItem(itemId!),
    enabled: open,
  });
  const { data: eventsData } = useQuery({
    queryKey: ['item', itemId, 'events'],
    queryFn: () => api.getItemEvents(itemId!),
    enabled: open,
  });

  useEffect(() => {
    if (!open) {
      setEditing(false);
      setArchiveConfirm(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const events = (eventsData?.events ?? []) as WorkItemEvent[];

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.updateItem({ id: itemId!, patch, expected_version: item!.version }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['items'] });
      qc.invalidateQueries({ queryKey: ['item', itemId] });
      setEditing(false);
      onChanged?.();
    },
  });

  const comment = useMutation({
    mutationFn: (body: string) =>
      api.comment(itemId!, { body, expected_version: item!.version }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['item', itemId] });
      qc.invalidateQueries({ queryKey: ['item', itemId, 'events'] });
    },
  });

  const transition = useMutation({
    mutationFn: (to_status: WorkItemStatus) =>
      api.transition(itemId!, { to_status, expected_version: item!.version }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['items'] });
      qc.invalidateQueries({ queryKey: ['item', itemId] });
    },
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end animate-fade-in">
      <button
        aria-label="Close panel"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-[2px]"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Item details"
        className="relative h-full w-full max-w-md overflow-y-auto border-l border-border-subtle bg-bg-base shadow-2xl animate-slide-in-right"
      >
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border-subtle bg-bg-base/90 px-5 py-3 backdrop-blur">
          <div className="flex items-center gap-2">
            {item ? (
              <>
                <Pill kind="backlog" dot={false} className="!ring-border-subtle !bg-bg-sunken !text-ink-2">
                  {item.kind}
                </Pill>
                <Pill kind={statusToPillKind(item.status)}>{item.status}</Pill>
                {item.archived_at ? (
                  <Pill kind="blocked" dot={false} className="!ring-status-blocked-500/30">
                    archived
                  </Pill>
                ) : null}
              </>
            ) : (
              <span className="text-[12px] text-ink-3">Item</span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="focus-ring -m-1 rounded-md p-1 text-ink-3 hover:bg-bg-sunken hover:text-ink-1"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18" /><path d="M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="px-5 py-4">
          {isLoading ? (
            <div className="space-y-2 text-[13px] text-ink-3">Loading…</div>
          ) : error ? (
            <div className="rounded-lg border border-status-blocked-500/40 bg-status-blocked-500/10 px-3 py-2 text-[12.5px] text-status-blocked-600">
              {(error as Error).message}
            </div>
          ) : !item ? (
            <div className="rounded-lg border border-border-subtle bg-bg-sunken px-3 py-2 text-[13px] text-ink-2">
              Item not found.
            </div>
          ) : editing ? (
            <EditForm
              item={item}
              submitting={update.isPending}
              error={update.isPending ? null : (update.error as Error | null)?.message ?? null}
              onCancel={() => setEditing(false)}
              onSubmit={(patch) => update.mutate(patch)}
            />
          ) : (
            <ReadView
              item={item}
              events={events}
              onEdit={() => setEditing(true)}
              onTransition={(to) => transition.mutate(to)}
              onArchive={() => {
                if (item.archived_at) {
                  update.mutate({ archived_at: null });
                } else if (archiveConfirm) {
                  update.mutate({ archived_at: new Date().toISOString() });
                  setArchiveConfirm(false);
                } else {
                  setArchiveConfirm(true);
                }
              }}
              archiveConfirm={archiveConfirm}
              onAddComment={(body) => comment.mutate(body)}
              commentPending={comment.isPending}
              commentError={(comment.error as Error | null)?.message ?? null}
            />
          )}
        </div>
      </aside>
    </div>
  );
}

function ReadView({
  item, events, onEdit, onTransition, onArchive, archiveConfirm, onAddComment, commentPending, commentError,
}: {
  item: WorkItem;
  events: WorkItemEvent[];
  onEdit: () => void;
  onTransition: (to: WorkItemStatus) => void;
  onArchive: () => void;
  archiveConfirm: boolean;
  onAddComment: (body: string) => void;
  commentPending: boolean;
  commentError: string | null;
}) {
  const [commentBody, setCommentBody] = useState('');
  const [commentAuthor, setCommentAuthor] = useState('');
  const eventsSorted = [...events].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h2 className="text-[18px] font-semibold leading-snug tracking-tight text-ink-1">
          {item.title}
        </h2>
        {item.body ? (
          <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink-2">
            {item.body}
          </p>
        ) : null}
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[12.5px]">
        <Meta label="Status" value={item.status} />
        <Meta label="Kind" value={item.kind} />
        <Meta label="Priority" value={item.priority ?? '—'} />
        <Meta label="Severity" value={item.severity ?? '—'} />
        <Meta label="Owner" value={item.owner ?? '—'} />
        <Meta label="Source" value={item.source ?? '—'} />
        {item.due_at ? <Meta label="Due" value={new Date(item.due_at).toLocaleString()} /> : null}
        <Meta label="Created" value={new Date(item.created_at).toLocaleString()} />
        <Meta label="Updated" value={new Date(item.updated_at).toLocaleString()} />
        {item.version !== undefined ? <Meta label="Version" value={String(item.version)} /> : null}
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onEdit}
          className="btn-ghost focus-ring text-[13px]"
        >
          Edit
        </button>
        <StatusMenu current={item.status} onPick={onTransition} />
        <button
          type="button"
          onClick={onArchive}
          className={`focus-ring text-[13px] ${archiveConfirm ? 'btn-primary' : 'btn-ghost'}`}
        >
          {archiveConfirm ? 'Confirm archive' : item.archived_at ? 'Unarchive' : 'Archive'}
        </button>
      </div>

      <CommentsSection
        events={eventsSorted}
        body={commentBody}
        setBody={setCommentBody}
        author={commentAuthor}
        setAuthor={setCommentAuthor}
        onSubmit={() => { if (commentBody.trim()) { onAddComment(commentBody.trim()); setCommentBody(''); } }}
        pending={commentPending}
        error={commentError}
      />
    </div>
  );
}

function StatusMenu({ current, onPick }: { current: WorkItemStatus; onPick: (s: WorkItemStatus) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn-ghost focus-ring text-[13px]"
      >
        Transition ▾
      </button>
      {open ? (
        <div className="absolute left-0 z-20 mt-1 min-w-[140px] rounded-lg border border-border-subtle bg-bg-raised py-1 shadow-card-lg">
          {STATUSES.filter((s) => s !== current).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => { onPick(s); setOpen(false); }}
              className="block w-full px-3 py-1.5 text-left text-[12.5px] text-ink-1 hover:bg-bg-sunken"
            >
              <Pill kind={statusToPillKind(s)} dot={false} className="!ring-border-subtle">{s}</Pill>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CommentsSection({
  events, body, setBody, author, setAuthor, onSubmit, pending, error,
}: {
  events: WorkItemEvent[];
  body: string;
  setBody: (s: string) => void;
  author: string;
  setAuthor: (s: string) => void;
  onSubmit: () => void;
  pending: boolean;
  error: string | null;
}) {
  return (
    <section className="space-y-2.5 border-t border-border-subtle pt-4">
      <h3 className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">Activity</h3>
      <ul className="space-y-2.5">
        {events.length === 0 ? (
          <li className="text-[12.5px] text-ink-3">No activity yet.</li>
        ) : events.map((e) => (
          <li key={e.id} className="rounded-lg border border-border-subtle bg-bg-raised px-3 py-2">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-ink-3">
              <span>{e.kind}</span>
              <span>·</span>
              <span className="font-mono normal-case text-ink-2">{e.actor ?? 'system'}</span>
              <span>·</span>
              <span className="normal-case">{new Date(e.created_at).toLocaleString()}</span>
            </div>
            {e.body ? (
              <p className="mt-1 whitespace-pre-wrap text-[13px] text-ink-1">{e.body}</p>
            ) : null}
          </li>
        ))}
      </ul>

      <form
        onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
        className="space-y-2 rounded-lg border border-border-subtle bg-bg-raised p-3"
      >
        <div className="grid grid-cols-3 gap-2">
          <input
            type="text"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="@actor (optional)"
            className="field col-span-1 text-[12.5px]"
            disabled={pending}
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Add a comment…"
            rows={2}
            className="field col-span-2 resize-y text-[13px]"
            disabled={pending}
          />
        </div>
        {error ? (
          <div className="text-[12px] text-status-blocked-600">{error}</div>
        ) : null}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={pending || !body.trim()}
            className="btn-primary focus-ring px-3 py-1.5 text-[12.5px] font-medium disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'Posting…' : 'Comment'}
          </button>
        </div>
      </form>
    </section>
  );
}

function EditForm({
  item, submitting, error, onCancel, onSubmit,
}: {
  item: WorkItem;
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (patch: Record<string, unknown>) => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body ?? '');
  const [kind, setKind] = useState<WorkItemKind>(item.kind);
  const [severity, setSeverity] = useState<string>(item.severity ?? '');
  const [priority, setPriority] = useState<string>(item.priority ?? '');
  const [owner, setOwner] = useState(item.owner ?? '');
  const [due, setDue] = useState(item.due_at ? item.due_at.slice(0, 10) : '');

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const patch: Record<string, unknown> = {
      title: title.trim(),
      body: body.trim() || null,
      kind,
      severity: severity || null,
      priority: priority || null,
      owner: owner.trim() || null,
      due_at: due ? new Date(`${due}T17:00:00Z`).toISOString() : null,
    };
    onSubmit(patch);
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <div className="space-y-1.5">
        <label className="block text-[11.5px] font-medium uppercase tracking-wider text-ink-3">Title</label>
        <input
          type="text"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="field w-full text-[14px]"
          disabled={submitting}
        />
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <SelectField label="Kind" value={kind} onChange={(v) => setKind(v as WorkItemKind)} options={KINDS} disabled={submitting} />
        <SelectField label="Priority" value={priority} onChange={setPriority} options={PRIORITIES} disabled={submitting} allowEmpty />
        <SelectField label="Severity" value={severity} onChange={setSeverity} options={SEVERITIES} disabled={submitting} allowEmpty />
        <div className="space-y-1.5">
          <label className="block text-[11.5px] font-medium uppercase tracking-wider text-ink-3">Owner</label>
          <input
            type="text"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className="field w-full text-[14px]"
            disabled={submitting}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <label className="block text-[11.5px] font-medium uppercase tracking-wider text-ink-3">Body</label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          className="field w-full resize-y text-[14px]"
          disabled={submitting}
        />
      </div>
      <div className="space-y-1.5">
        <label className="block text-[11.5px] font-medium uppercase tracking-wider text-ink-3">Due date</label>
        <input
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          className="field w-full text-[14px]"
          disabled={submitting}
        />
      </div>
      {error ? (
        <div className="rounded-lg border border-status-blocked-500/40 bg-status-blocked-500/10 px-3 py-2 text-[12.5px] text-status-blocked-600">
          {error}
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="btn-ghost focus-ring text-[13px] text-ink-2 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || !title.trim()}
          className="btn-primary focus-ring inline-flex items-center gap-2 px-4 py-2 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

function SelectField({
  label, value, onChange, options, disabled, allowEmpty,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  disabled?: boolean;
  allowEmpty?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[11.5px] font-medium uppercase tracking-wider text-ink-3">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="field w-full text-[14px]"
        disabled={disabled}
      >
        {allowEmpty ? <option value="">none</option> : null}
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-ink-3">{label}</dt>
      <dd className="text-ink-1">{value}</dd>
    </>
  );
}
