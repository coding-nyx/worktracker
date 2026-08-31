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
  BoardColumn,
  WorkItem,
  WorkItemStatus,
  WorkItemKind,
} from '@worktracker/types';
import { api, getCredentials, setCredentials as setApiCredentials } from '../lib/api';
import { CREDENTIALS_BOOTSTRAPPED_EVENT } from './providers';
import { useItemsSubscription } from '../lib/useItemsSubscription';

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

export default function HomePage() {
  const queryClient = useQueryClient();
  const [sourceFilter, setSourceFilter] = useState<string>('');

  // Active board. Persisted in localStorage; falls back to the
  // first board (typically is_default=true).
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setActiveBoardId(window.localStorage.getItem(ACTIVE_BOARD_KEY));
  }, []);

  // Live items via Firestore onSnapshot. The hook handles
  // initial fetch, live updates, and cleanup.
  const { items, error: liveError } = useItemsSubscription({ source: sourceFilter || undefined });

  // Fall back to REST if Firestore isn't configured.
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

  // Boards. Picker reads from this list.
  const { data: boardsData } = useQuery({
    queryKey: ['boards'],
    queryFn: () => api.listBoards(),
  });
  const boards = boardsData?.boards ?? [];

  // Resolve the active board: explicit id from localStorage,
  // then the first board with is_default=true, then the first
  // board at all, then null (which triggers the fallback).
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

  // If the persisted activeBoardId doesn't exist in the new
  // boards list, clear it so the default takes over.
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

  // Filter items by the board's kind filter (if any), then drop
  // archived items.
  const boardKinds: WorkItemKind[] | null = activeBoard?.kinds ?? null;
  const visibleItems = useMemo(() => {
    if (!boardKinds || boardKinds.length === 0) return itemsToShow.filter((i) => !i.archived_at);
    const set = new Set<WorkItemKind>(boardKinds);
    return itemsToShow.filter((i) => set.has(i.kind) && !i.archived_at);
  }, [itemsToShow, boardKinds]);

  // Columns: from the active board if present, else the fallback.
  // The fallback matches v0's hard-coded task columns so the
  // page is usable on first load.
  const boardColumns: { id: string; label: string; statuses: string[] }[] = useMemo(() => {
    if (!activeBoard) return FALLBACK_COLUMNS;
    return activeBoard.columns.map((c) => ({ id: c.id, label: c.label, statuses: c.statuses }));
  }, [activeBoard]);

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
    // The drop target is the column id. We need to find a valid
    // status to transition to. Pick the first status in the
    // column's status list.
    const col = boardColumns.find((c) => c.id === over.id);
    if (!col || col.statuses.length === 0) return;
    const targetStatus = col.statuses[0] as WorkItemStatus;
    if (targetStatus === item.status) return;
    if (!isValidTransition(item.status, targetStatus, item.kind)) return;
    transition.mutate({ id: item.id, to_status: targetStatus, expected_version: item.version });
  }

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Kanban</h1>
          <p className="text-sm text-slate-500">
            {visibleItems.length} items · {activeBoard ? activeBoard.name : 'no board'} · live via Firestore
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <BoardPicker
            boards={boards}
            activeBoardId={activeBoard?.id ?? null}
            onChange={onBoardChange}
          />
          <div className="flex items-center gap-2">
            <label className="text-sm text-slate-600" htmlFor="source-filter">Source</label>
            <select
              id="source-filter"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
            >
              <option value="">All</option>
              {sources.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.display_name}
                </option>
              ))}
            </select>
          </div>
          <CredentialsGate />
        </div>
      </header>

      {liveError ? (
        <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          Live updates unavailable ({liveError}). Showing last REST snapshot.
        </p>
      ) : null}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <div className={`grid gap-4 ${boardColumns.length <= 3 ? 'md:grid-cols-3' : 'md:grid-cols-3 lg:grid-cols-5'}`}>
          {boardColumns.map((col) => (
            <KanbanColumn
              key={col.id}
              id={col.id}
              label={col.label}
              items={visibleItems.filter((i) => col.statuses.includes(i.status))}
            />
          ))}
        </div>
      </DndContext>

      {visibleItems.some((i) => !boardColumns.some((c) => c.statuses.includes(i.status))) ? (
        <section>
          <h2 className="text-sm font-semibold text-slate-500">Unbucketed</h2>
          <p className="mt-1 text-xs text-slate-400">
            Items in this list have a status no current board column captures.
            Add the status to a column or switch boards to see them.
          </p>
          <ul className="mt-2 space-y-2">
            {visibleItems
              .filter((i) => !boardColumns.some((c) => c.statuses.includes(i.status)))
              .map((item) => (
                <li key={item.id} className="card px-3 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                      {item.kind}
                    </span>
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700">
                      {item.status}
                    </span>
                    <span className="font-medium">{item.title}</span>
                  </div>
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      {visibleItems.some((i) => boardKinds && !boardKinds.includes(i.kind)) ? (
        <section>
          <h2 className="text-sm font-semibold text-slate-500">Hidden by board kind filter</h2>
          <p className="mt-1 text-xs text-slate-400">
            Board <code className="rounded bg-slate-100 px-1 py-0.5">{activeBoard?.name}</code> restricts
            to kinds: {boardKinds?.join(', ')}. Items of other kinds are listed below.
          </p>
          <ul className="mt-2 space-y-2">
            {visibleItems
              .filter((i) => boardKinds && !boardKinds.includes(i.kind))
              .map((item) => (
                <li key={item.id} className="card px-3 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                      {item.kind}
                    </span>
                    <span className="font-medium">{item.title}</span>
                  </div>
                </li>
              ))}
          </ul>
        </section>
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
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span>No boards yet. Create one in</span>
        <a href="/admin/boards" className="text-brand-600 underline">
          Connectors → Boards
        </a>
        <span>to customize columns.</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <label className="text-sm text-slate-600" htmlFor="board-picker">Board</label>
      <select
        id="board-picker"
        value={activeBoardId ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
      >
        {boards.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}{b.is_default ? ' ★' : ''}
          </option>
        ))}
      </select>
      <a href="/admin/boards" className="text-xs text-brand-600 underline">
        manage
      </a>
    </div>
  );
}

function KanbanColumn({ id, label, items }: { id: string; label: string; items: WorkItem[] }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`rounded-lg border bg-slate-50/60 p-3 transition-colors ${
        isOver ? 'border-brand-500 bg-brand-50' : 'border-slate-200'
      }`}
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-tight text-slate-700">{label}</h2>
        <span className="rounded bg-white px-1.5 py-0.5 text-xs text-slate-500">{items.length}</span>
      </div>
      <div className="space-y-2">
        {items.map((item) => (
          <KanbanCard key={item.id} item={item} />
        ))}
        {items.length === 0 ? (
          <p className="rounded border border-dashed border-slate-200 px-2 py-3 text-center text-xs text-slate-400">
            empty
          </p>
        ) : null}
      </div>
    </div>
  );
}

function KanbanCard({ item }: { item: WorkItem }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: item.id });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={`card cursor-grab px-3 py-2 text-sm shadow-sm transition-shadow ${
        isDragging ? 'opacity-60 shadow-lg' : 'hover:shadow-md'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
          {item.kind}
        </span>
        {item.priority ? (
          <span className={`rounded px-1.5 py-0.5 text-xs ${priorityColor(item.priority)}`}>
            {item.priority}
          </span>
        ) : null}
      </div>
      <p className="mt-1 font-medium leading-tight text-slate-900">{item.title}</p>
      {item.due_at ? (
        <p className="mt-1 text-xs text-slate-500">due {formatDate(item.due_at)}</p>
      ) : null}
      {item.enrichment_state ? (
        <EnrichmentChip state={item.enrichment_state} />
      ) : null}
    </div>
  );
}

function EnrichmentChip({ state }: { state: NonNullable<WorkItem['enrichment_state']> }) {
  const grill = state.grill?.status;
  const wayfind = state.wayfind?.status;
  return (
    <div className="mt-2 flex gap-1 text-[10px]">
      <span className={chipColor(grill)}>grill: {grill ?? '—'}</span>
      <span className={chipColor(wayfind)}>wayfind: {wayfind ?? '—'}</span>
    </div>
  );
}

function chipColor(status: string | undefined): string {
  switch (status) {
    case 'complete':
      return 'rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700';
    case 'in_progress':
      return 'rounded bg-amber-50 px-1.5 py-0.5 text-amber-700';
    case 'failed':
      return 'rounded bg-rose-50 px-1.5 py-0.5 text-rose-700';
    default:
      return 'rounded bg-slate-100 px-1.5 py-0.5 text-slate-500';
  }
}

function priorityColor(p: string): string {
  switch (p) {
    case 'high':
      return 'bg-rose-50 text-rose-700';
    case 'medium':
      return 'bg-amber-50 text-amber-700';
    case 'low':
      return 'bg-slate-100 text-slate-600';
    default:
      return 'bg-slate-100 text-slate-600';
  }
}

function formatDate(s: string): string {
  try {
    return new Date(s).toLocaleDateString();
  } catch {
    return s;
  }
}

function isValidTransition(from: WorkItemStatus, to: WorkItemStatus, _kind: WorkItem['kind']): boolean {
  if (from === to) return false;
  // The brain will reject illegal transitions, but we keep
  // the UI honest by only allowing the columns we render.
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
  // The legacy key above is just to satisfy the type checker for
  // stringly-typed arrays.
  void (allowed as Record<string, WorkItemStatus[]>).in_progress_legacy;
  const target = allowed[to];
  return Array.isArray(target) ? (target as WorkItemStatus[]).includes(from) : false;
}

function CredentialsGate() {
  // First-run experience: prompt for API base + admin token if
  // missing. Stored in localStorage thereafter. Re-checks when
  // the URL-hash bootstrap writes to localStorage after first
  // render.
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
      <div className="space-y-3">
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
          className="rounded bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          Sign in
        </button>
        <p className="max-w-md text-xs text-slate-500">
          Or open this URL with{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5">#apiBase=…&amp;token=…</code>{' '}
          in the hash to sign in automatically — the hash is stripped from the URL
          before the page renders.
        </p>
      </div>
    );
  }
  return null;
}
