'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import type {
  Board,
  WorkItem,
  WorkItemStatus,
  WorkItemKind,
} from '@worktracker/types';
import { api, getCredentials, setCredentials as setApiCredentials } from '../lib/api';
import { CREDENTIALS_BOOTSTRAPPED_EVENT } from './providers';
import { useItemsSubscription } from '../lib/useItemsSubscription';
import { Pill, statusToPillKind, type StatusKind } from '../components/Pill';
import { EmptyState } from '../components/EmptyState';

const ACTIVE_BOARD_KEY = 'worktracker.active_board_id';

// Fallback used when no boards are defined yet. Matches the
// original hard-coded 5-column layout for tasks, so first-run
// looks the same as v0.
const FALLBACK_COLUMNS: { id: string; label: string; statuses: string[] }[] = [
  { id: 'open', label: 'Open', statuses: ['open'] },
  { id: 'ready', label: 'Ready', statuses: ['ready'] },
  { id: 'in_progress', label: 'In Progress', statuses: ['in_progress'] },
  { id: 'blocked', label: 'Blocked', statuses: ['blocked'] },
  { id: 'done', label: 'Done', statuses: ['done', 'cancelled'] },
];

// Map a fallback column id to a pill kind so the headers get the
// right status hue.
const FALLBACK_COLUMN_KIND: Record<string, StatusKind> = {
  open: 'backlog',
  ready: 'ready',
  in_progress: 'progress',
  blocked: 'blocked',
  done: 'done',
};

export default function HomePage() {
  const queryClient = useQueryClient();
  const [sourceFilter, setSourceFilter] = useState<string>('');

  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setActiveBoardId(window.localStorage.getItem(ACTIVE_BOARD_KEY));
  }, []);

  const { items, error: liveError } = useItemsSubscription({ source: sourceFilter || undefined });
  // useItemsSubscription returns `error: string | null`; coerce to
  // an Error-shaped value so the rest of the page can pass it
  // through uniformly.
  const liveErrorObj: Error | null = liveError ? new Error(liveError) : null;

  const { data: restData } = useQuery({
    queryKey: ['items', sourceFilter],
    queryFn: () => api.listItems({ source: sourceFilter || undefined, limit: 200 }),
    enabled: typeof window !== 'undefined' && !process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  });

  const itemsToShow: WorkItem[] = items.length > 0 ? items : (restData?.items ?? []);

  const { data: sourcesData } = useQuery({
    queryKey: ['sources'],
    queryFn: () => api.listSources(),
  });
  const sources = sourcesData?.sources ?? [];

  const { data: boardsData } = useQuery({
    queryKey: ['boards'],
    queryFn: () => api.listBoards(),
  });
  const boards = boardsData?.boards ?? [];

  const activeBoard: Board | null = useMemo(() => {
    if (boards.length === 0) return null;
    if (activeBoardId) {
      const found = boards.find((b) => b.id === activeBoardId);
      if (found) return found;
    }
    const def = boards.find((b) => b.is_default);
    if (def) return def;
    return boards[0] ?? null;
  }, [boards, activeBoardId]);

  useEffect(() => {
    if (activeBoardId && boards.length > 0 && !boards.find((b) => b.id === activeBoardId)) {
      setActiveBoardId(null);
      if (typeof window !== 'undefined') window.localStorage.removeItem(ACTIVE_BOARD_KEY);
    }
  }, [boards, activeBoardId]);

  const onBoardChange = useCallback((id: string) => {
    setActiveBoardId(id);
    if (typeof window !== 'undefined') {
      if (id) window.localStorage.setItem(ACTIVE_BOARD_KEY, id);
      else window.localStorage.removeItem(ACTIVE_BOARD_KEY);
    }
  }, []);

  const boardKinds: WorkItemKind[] | null = activeBoard?.kinds ?? null;
  const visibleItems = useMemo(() => {
    if (!boardKinds || boardKinds.length === 0) return itemsToShow.filter((i) => !i.archived_at);
    const set = new Set<WorkItemKind>(boardKinds);
    return itemsToShow.filter((i) => set.has(i.kind) && !i.archived_at);
  }, [itemsToShow, boardKinds]);

  const boardColumns: { id: string; label: string; statuses: string[] }[] = useMemo(() => {
    if (!activeBoard) return FALLBACK_COLUMNS;
    return activeBoard.columns.map((c) => ({ id: c.id, label: c.label, statuses: c.statuses }));
  }, [activeBoard]);

  // Map column id → pill kind. The fallback table is explicit; for
  // real boards we derive from the column's first status.
  const columnKind = useCallback(
    (id: string, statuses: string[]): StatusKind => {
      if (FALLBACK_COLUMN_KIND[id]) return FALLBACK_COLUMN_KIND[id];
      return statusToPillKind(statuses[0] ?? '');
    },
    [],
  );

  const transition = useMutation({
    mutationFn: async ({ id, to_status, expected_version }: { id: string; to_status: WorkItemStatus; expected_version: number }) =>
      api.transition(id, { to_status, expected_version }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
    },
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    const item = visibleItems.find((i) => i.id === active.id);
    if (!item) return;
    const col = boardColumns.find((c) => c.id === over.id);
    if (!col || col.statuses.length === 0) return;
    const targetStatus = col.statuses[0] as WorkItemStatus;
    if (targetStatus === item.status) return;
    if (!isValidTransition(item.status, targetStatus, item.kind)) return;
    transition.mutate({ id: item.id, to_status: targetStatus, expected_version: item.version });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        items={visibleItems}
        boardName={activeBoard?.name ?? null}
        liveOk={!liveError}
        liveError={liveErrorObj}
        boards={boards}
        activeBoardId={activeBoard?.id ?? null}
        onBoardChange={onBoardChange}
        sourceFilter={sourceFilter}
        onSourceFilterChange={setSourceFilter}
        sources={sources}
      />

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {boardColumns.map((col) => (
            <KanbanColumn
              key={col.id}
              id={col.id}
              label={col.label}
              kind={columnKind(col.id, col.statuses)}
              items={visibleItems.filter((i) => col.statuses.includes(i.status))}
            />
          ))}
        </div>
      </DndContext>

      <UnbucketedSection items={visibleItems} boardColumns={boardColumns} />
      <HiddenByKindSection items={visibleItems} boardKinds={boardKinds} activeBoardName={activeBoard?.name ?? null} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Header — page title + live status + board picker + source filter.          */

function PageHeader({
  items,
  boardName,
  liveOk,
  liveError,
  boards,
  activeBoardId,
  onBoardChange,
  sourceFilter,
  onSourceFilterChange,
  sources,
}: {
  items: WorkItem[];
  boardName: string | null;
  liveOk: boolean;
  liveError: Error | null;
  boards: Board[];
  activeBoardId: string | null;
  onBoardChange: (id: string) => void;
  sourceFilter: string;
  onSourceFilterChange: (s: string) => void;
  sources: { name: string; display_name: string }[];
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-ink-1">Kanban</h1>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-2">
            <span className="font-semibold text-ink-1">{items.length}</span>
            <span>items</span>
            <span aria-hidden className="text-ink-3">·</span>
            <span>{boardName ?? <span className="italic text-ink-3">no board</span>}</span>
            <span aria-hidden className="text-ink-3">·</span>
            <span className="inline-flex items-center gap-1.5">
              <span className={liveOk ? 'live-dot' : 'h-1.5 w-1.5 rounded-full bg-ink-4'} aria-hidden />
              <span>{liveOk ? 'live' : 'rest snapshot'}</span>
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <BoardPicker boards={boards} activeBoardId={activeBoardId} onChange={onBoardChange} />
          <SourceFilter value={sourceFilter} onChange={onSourceFilterChange} sources={sources} />
          <CredentialsGate />
        </div>
      </div>

      {liveError ? (
        <div className="card-inset flex items-start gap-2.5 px-3.5 py-2.5 text-[13px] text-ink-2">
          <span aria-hidden className="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warning-500" />
          <span>
            <span className="font-medium text-ink-1">Live updates unavailable</span> ({liveError.message}). Showing the last REST snapshot.
          </span>
        </div>
      ) : null}
    </div>
  );
}

function BoardPicker({
  boards,
  activeBoardId,
  onChange,
}: {
  boards: Board[];
  activeBoardId: string | null;
  onChange: (id: string) => void;
}) {
  if (boards.length === 0) {
    return (
      <a
        href="/admin/boards"
        className="btn-ghost focus-ring text-[13px] text-ink-2"
      >
        No boards yet — <span className="text-brand-500 underline">create one</span>
      </a>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <label className="sr-only" htmlFor="board-picker">Board</label>
      <select
        id="board-picker"
        value={activeBoardId ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="field pr-8 text-[13px]"
      >
        {boards.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}{b.is_default ? ' ★' : ''}
          </option>
        ))}
      </select>
      <a
        href="/admin/boards"
        className="btn-ghost focus-ring text-[13px]"
        title="Manage boards"
      >
        manage
      </a>
    </div>
  );
}

function SourceFilter({
  value,
  onChange,
  sources,
}: {
  value: string;
  onChange: (s: string) => void;
  sources: { name: string; display_name: string }[];
}) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="sr-only" htmlFor="source-filter">Source</label>
      <select
        id="source-filter"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="field pr-8 text-[13px]"
      >
        <option value="">All sources</option>
        {sources.map((s) => (
          <option key={s.name} value={s.name}>
            {s.display_name}
          </option>
        ))}
      </select>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Kanban — columns with the status-hued header, glassy cards, drag motion.  */

function KanbanColumn({
  id,
  label,
  kind,
  items,
}: {
  id: string;
  label: string;
  kind: StatusKind;
  items: WorkItem[];
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`flex h-full min-h-[280px] flex-col rounded-2xl border bg-bg-surface/60 backdrop-blur-sm transition-all duration-200 ease-spring ${
        isOver
          ? 'border-brand-500/60 bg-brand-500/5 shadow-glow'
          : 'border-border-subtle'
      }`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full bg-status-${kind}-500`} />
          <h2 className="text-[13px] font-semibold uppercase tracking-wider text-ink-2">{label}</h2>
        </div>
        <span className="rounded-md border border-border-subtle bg-bg-sunken px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-ink-2">
          {items.length}
        </span>
      </div>
      <div className="flex-1 space-y-2 p-2.5">
        {items.map((item) => (
          <KanbanCard key={item.id} item={item} />
        ))}
        {items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-subtle px-2.5 py-6 text-center text-[11px] uppercase tracking-wider text-ink-3">
            empty
          </div>
        ) : null}
      </div>
    </div>
  );
}

function KanbanCard({ item }: { item: WorkItem }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: item.id });
  const style: React.CSSProperties | undefined = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0) rotate(${transform.x * 0.04}deg)`, zIndex: 50 }
    : undefined;
  const kind = statusToPillKind(item.status);
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={`group relative cursor-grab rounded-xl border border-border-subtle bg-bg-surface p-3 shadow-card transition-shadow duration-150 ease-out-quint hover:border-border-default hover:shadow-card-lg ${
        isDragging ? 'opacity-90 shadow-card-lg' : ''
      }`}
    >
      {/* status accent stripe */}
      <span aria-hidden className={`absolute inset-y-2 left-0 w-0.5 rounded-full bg-status-${kind}-500/80`} />
      <div className="flex items-center gap-1.5">
        <Pill kind="backlog" dot={false} className="!ring-border-subtle !bg-bg-sunken !text-ink-2">
          {item.kind}
        </Pill>
        {item.priority && item.priority !== 'low' ? (
          <Pill kind={priorityKind(item.priority)} dot={false} className="!ring-status-blocked-500/30">
            {item.priority}
          </Pill>
        ) : null}
      </div>
      <p className="mt-1.5 line-clamp-2 text-[13.5px] font-medium leading-snug text-ink-1">{item.title}</p>
      {item.due_at ? (
        <p className="mt-1 text-[11px] text-ink-3">due {formatDate(item.due_at)}</p>
      ) : null}
      {item.enrichment_state ? <EnrichmentChip state={item.enrichment_state} /> : null}
    </div>
  );
}

function priorityKind(p: string): StatusKind {
  if (p === 'high' || p === 'critical') return 'blocked';
  if (p === 'medium') return 'progress';
  return 'backlog';
}

function EnrichmentChip({ state }: { state: NonNullable<WorkItem['enrichment_state']> }) {
  const grill = state.grill?.status;
  const wayfind = state.wayfind?.status;
  return (
    <div className="mt-2 flex gap-1.5 text-[10px] font-medium uppercase tracking-wider">
      <EnrichmentDot label="grill"    status={grill} />
      <EnrichmentDot label="wayfind"  status={wayfind} />
    </div>
  );
}

function EnrichmentDot({ label, status }: { label: string; status: string | undefined }) {
  const tone =
    status === 'complete'   ? 'bg-status-done-500/20 text-status-done-600 ring-status-done-500/40' :
    status === 'in_progress' ? 'bg-status-progress-500/20 text-status-progress-600 ring-status-progress-500/40' :
    status === 'failed'     ? 'bg-status-blocked-500/20 text-status-blocked-600 ring-status-blocked-500/40' :
    'bg-bg-sunken text-ink-3 ring-border-subtle';
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 ring-1 ring-inset ${tone}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${
        status === 'complete' ? 'bg-status-done-500' :
        status === 'in_progress' ? 'bg-status-progress-500' :
        status === 'failed' ? 'bg-status-blocked-500' : 'bg-ink-3'
      }`} />
      {label}: {status ?? '—'}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Unbucketed + hidden-by-kind sections.                                       */

function UnbucketedSection({
  items,
  boardColumns,
}: {
  items: WorkItem[];
  boardColumns: { id: string; label: string; statuses: string[] }[];
}) {
  const orphans = items.filter((i) => !boardColumns.some((c) => c.statuses.includes(i.status)));
  if (orphans.length === 0) return null;
  return (
    <section className="space-y-2.5">
      <div className="flex items-baseline gap-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-wider text-ink-2">Unbucketed</h2>
        <span className="rounded-md border border-border-subtle bg-bg-sunken px-1.5 py-0.5 text-[11px] tabular-nums text-ink-3">
          {orphans.length}
        </span>
      </div>
      <p className="text-[12px] text-ink-3">
        These items have a status no current board column captures. Add the status to a column or switch boards.
      </p>
      <ul className="space-y-1.5">
        {orphans.map((item) => (
          <li key={item.id} className="card flex items-center gap-2 px-3 py-2 text-[13px]">
            <Pill kind="backlog" dot={false} className="!ring-border-subtle !bg-bg-sunken !text-ink-2">
              {item.kind}
            </Pill>
            <Pill kind={statusToPillKind(item.status)}>{item.status}</Pill>
            <span className="truncate text-ink-1">{item.title}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HiddenByKindSection({
  items,
  boardKinds,
  activeBoardName,
}: {
  items: WorkItem[];
  boardKinds: WorkItemKind[] | null;
  activeBoardName: string | null;
}) {
  if (!boardKinds || boardKinds.length === 0) return null;
  const hidden = items.filter((i) => !boardKinds.includes(i.kind));
  if (hidden.length === 0) return null;
  return (
    <section className="space-y-2.5">
      <div className="flex items-baseline gap-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-wider text-ink-2">Hidden by board kind filter</h2>
        <span className="rounded-md border border-border-subtle bg-bg-sunken px-1.5 py-0.5 text-[11px] tabular-nums text-ink-3">
          {hidden.length}
        </span>
      </div>
      <p className="text-[12px] text-ink-3">
        Board <code className="rounded bg-bg-sunken px-1.5 py-0.5 text-ink-1">{activeBoardName}</code> restricts to kinds: {boardKinds.join(', ')}.
      </p>
      <ul className="space-y-1.5">
        {hidden.map((item) => (
          <li key={item.id} className="card flex items-center gap-2 px-3 py-2 text-[13px]">
            <Pill kind="backlog" dot={false} className="!ring-border-subtle !bg-bg-sunken !text-ink-2">
              {item.kind}
            </Pill>
            <span className="truncate text-ink-1">{item.title}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* First-run auth gate — prompts for API base + admin token if missing.       */

function CredentialsGate() {
  const [hasCreds, setHasCreds] = useState<boolean | null>(null);
  const refresh = useCallback(() => {
    if (typeof window === 'undefined') return;
    const { apiBase, token } = getCredentials();
    setHasCreds(Boolean(apiBase && token));
  }, []);
  useEffect(() => {
    refresh();
    if (typeof window === 'undefined') return;
    window.addEventListener(CREDENTIALS_BOOTSTRAPPED_EVENT, refresh);
    return () => window.removeEventListener(CREDENTIALS_BOOTSTRAPPED_EVENT, refresh);
  }, [refresh]);
  if (hasCreds === false) {
    return (
      <button
        type="button"
        onClick={() => {
          const apiBase = window.prompt('WorkTracker API base URL', window.location.origin) ?? '';
          const token = window.prompt('Admin token') ?? '';
          if (apiBase && token) {
            setApiCredentials(apiBase, token);
            window.location.reload();
          }
        }}
        className="btn-primary focus-ring"
      >
        Sign in
      </button>
    );
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Helpers — kept from the original page.                                     */

function formatDate(s: string): string {
  try {
    return new Date(s).toLocaleDateString();
  } catch {
    return s;
  }
}

function isValidTransition(from: WorkItemStatus, to: WorkItemStatus, _kind: WorkItem['kind']): boolean {
  if (from === to) return false;
  const allowed: Record<WorkItemStatus, WorkItemStatus[]> = {
    open: ['ready', 'in_progress', 'blocked', 'done', 'cancelled'],
    ready: ['open', 'in_progress', 'blocked', 'done', 'cancelled'],
    in_progress: ['ready', 'blocked', 'done', 'cancelled'],
    blocked: ['ready', 'in_progress', 'done', 'cancelled'],
    done: ['ready', 'in_progress'],
    cancelled: ['open'],
    triaged: ['in_progress', 'wontfix', 'duplicate', 'resolved'],
    in_progress_legacy: [],
    resolved: ['in_progress', 'wontfix', 'duplicate'],
    wontfix: ['triaged'],
    duplicate: ['triaged'],
    proposed: ['accepted', 'rejected', 'superseded'],
    accepted: ['superseded'],
    superseded: [],
    rejected: ['proposed'],
    pending: ['changes_requested', 'approved', 'closed'],
    changes_requested: ['pending', 'approved', 'closed'],
    approved: ['merged', 'closed', 'pending'],
    merged: ['closed'],
    closed: ['pending'],
  } as Record<WorkItemStatus, WorkItemStatus[]>;
  void (allowed as Record<string, WorkItemStatus[]>).in_progress_legacy;
  const target = allowed[to];
  return Array.isArray(target) ? (target as WorkItemStatus[]).includes(from) : false;
}
