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
import { canTransition } from '@worktracker/types';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useItemsSubscription } from '../lib/useItemsSubscription';
import { Pill, statusToPillKind, type StatusKind } from '../components/Pill';
import { EmptyState } from '../components/EmptyState';
import { NewItemModal } from '../components/NewItemModal';
import { ItemDetailsPanel } from '../components/ItemDetailsPanel';

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
  const [searchQuery, setSearchQuery] = useState<string>('');
  // Slice 10: structural filters. Client-side, since the full
  // item set is already in memory after the live subscription.
  const [projectFilter, setProjectFilter] = useState<string>('');
  const [releaseFilter, setReleaseFilter] = useState<string>('');
  const [tagFilter, setTagFilter] = useState<string>('');
  const [showNewItem, setShowNewItem] = useState(false);
  const [itemDetailsId, setItemDetailsId] = useState<string | null>(null);
  // Slice 3 — the kanban is either a board view (items with
  // board_id === activeBoard.id) or the Backlog view (items with
  // board_id === null). The toggle sits in the page header; the
  // choice persists per-board so switching boards doesn't lose
  // the user's preferred layout.
  type ViewMode = 'board' | 'backlog';
  const [viewMode, setViewMode] = useState<ViewMode>('board');

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
    queryKey: ['clients'],
    queryFn: () => api.listClients(),
  });
  const sources = (sourcesData?.clients ?? []).map((c) => ({ name: c.name, display_name: c.display_name }));

  const { data: boardsData } = useQuery({
    queryKey: ['boards'],
    queryFn: () => api.listBoards(),
  });
  const boards = boardsData?.boards ?? [];

  // Slice 10 — structural primitives used by the kanban filter.
  // The list is small (≤ a few hundred tags/projects in v0) so
  // loading them all is cheap; if it ever becomes a bottleneck
  // we move to a server-side search endpoint.
  const { data: projectsData } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects(),
  });
  const projects = projectsData?.projects ?? [];
  const { data: tagsData } = useQuery({
    queryKey: ['tags'],
    queryFn: () => api.listTags(),
  });
  const tags = tagsData?.tags ?? [];
  // Releases for the active project. Empty when no project
  // filter is set (the operator should pick a project first).
  const { data: releasesData } = useQuery({
    queryKey: ['releases', projectFilter],
    queryFn: () => api.listReleases(projectFilter ? { project_id: projectFilter } : {}),
    enabled: !!projectFilter,
  });
  const releases = releasesData?.releases ?? [];

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
    // Slice 3 — board / backlog split. `board_id: null` is the
    // Backlog; the active board owns the rest. The kind filter
    // still applies on top, so a board that's locked to `task`
    // shows only tasks, even if it owns tickets.
    let scoped: WorkItem[];
    if (viewMode === 'backlog') {
      scoped = itemsToShow.filter((i) => i.board_id === null);
    } else if (activeBoard) {
      scoped = itemsToShow.filter((i) => i.board_id === activeBoard.id);
    } else {
      // No active board + not backlog: fall back to "everything
      // that's not on any board" so the page doesn't go blank.
      scoped = itemsToShow.filter((i) => i.board_id === null);
    }
    let base: WorkItem[];
    if (!boardKinds || boardKinds.length === 0) {
      base = scoped.filter((i) => !i.archived_at);
    } else {
      const set = new Set<WorkItemKind>(boardKinds);
      base = scoped.filter((i) => set.has(i.kind) && !i.archived_at);
    }
    // Slice 10 — client-side project / release / tag filter.
    // The full item set is already in memory; this is cheap.
    if (projectFilter) {
      base = base.filter((i) => i.project_id === projectFilter);
    }
    if (releaseFilter) {
      base = base.filter((i) => i.release_id === releaseFilter);
    }
    if (tagFilter) {
      base = base.filter((i) => i.tag_slugs.includes(tagFilter));
    }
    const q = searchQuery.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        (i.body ?? '').toLowerCase().includes(q) ||
        (i.owner ?? '').toLowerCase().includes(q),
    );
  }, [itemsToShow, boardKinds, searchQuery, activeBoard, viewMode]);

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
      setBrainError(null);
    },
    onError: (err) => {
      // Surface the brain's reason inline (the "drag-drop fix").
      // The structured `code: 'invalid_transition'` from the
      // server ends up in `err.message` via the API error wrapper.
      const msg = err instanceof Error ? err.message : String(err);
      setBrainError(msg);
    },
  });

  // The last brain error we want to surface in the mono `[err]`
  // block. Cleared on a successful transition or when the user
  // dismisses it.
  const [brainError, setBrainError] = useState<string | null>(null);

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
    // Slice 3 — gate on the state machine. The same `canTransition`
    // the brain uses, evaluated client-side so the drop is a quiet
    // no-op (the column was already greyed out). If a stale item
    // somehow lands here (e.g. the server's view differs), the
    // server still rejects with `code: 'invalid_transition'` and
    // the `[err]` block surfaces the reason.
    const check = canTransition(item.status, targetStatus, item.kind);
    if (!check.ok) {
      setBrainError(check.reason.message);
      return;
    }
    transition.mutate({ id: item.id, to_status: targetStatus, expected_version: item.version });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        items={visibleItems}
        totalItems={itemsToShow.filter((i) => !i.archived_at).length}
        board={activeBoard}
        boards={boards}
        activeBoardId={activeBoard?.id ?? null}
        onBoardChange={onBoardChange}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        sourceFilter={sourceFilter}
        onSourceFilterChange={setSourceFilter}
        sources={sources}
        projects={projects}
        projectFilter={projectFilter}
        onProjectFilterChange={setProjectFilter}
        releases={releases}
        releaseFilter={releaseFilter}
        onReleaseFilterChange={setReleaseFilter}
        tags={tags}
        tagFilter={tagFilter}
        onTagFilterChange={setTagFilter}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onNewItem={() => setShowNewItem(true)}
        liveOk={!liveError}
        liveError={liveErrorObj}
        brainError={brainError}
        onDismissBrainError={() => setBrainError(null)}
      />

      {boards.length === 0 ? (
        <EmptyState
          title="No boards yet"
          body="Create your first kanban board to start tracking work. Boards hold columns that group work items by status."
          action={
            <a href="/admin/boards" className="btn-primary focus-ring inline-flex items-center gap-2 px-4 py-2 text-[13px] font-medium">
              Create a board
            </a>
          }
        />
      ) : (
        <>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {boardColumns.map((col) => (
                <KanbanColumn
                  key={col.id}
                  id={col.id}
                  label={col.label}
                  kind={columnKind(col.id, col.statuses)}
                  items={visibleItems.filter((i) => col.statuses.includes(i.status))}
                  onCardClick={setItemDetailsId}
                />
              ))}
            </div>
          </DndContext>

          {visibleItems.length === 0 ? (
            <EmptyState
              title={searchQuery ? 'No matches' : 'No items on this board'}
              body={searchQuery
                ? `Nothing matches "${searchQuery}". Clear the search or pick a different board.`
                : 'Click "New item" in the header to add the first one.'}
              action={
                searchQuery ? (
                  <button onClick={() => setSearchQuery('')} className="btn-ghost focus-ring text-[13px]">
                    Clear search
                  </button>
                ) : (
                  <button onClick={() => setShowNewItem(true)} className="btn-primary focus-ring px-4 py-2 text-[13px] font-medium">
                    New item
                  </button>
                )
              }
            />
          ) : null}

          <UnbucketedSection items={visibleItems} boardColumns={boardColumns} />
          <HiddenByKindSection items={visibleItems} boardKinds={boardKinds} activeBoardName={activeBoard?.name ?? null} />
        </>
      )}

      <NewItemModal
        open={showNewItem}
        onClose={() => setShowNewItem(false)}
        onCreated={() => {
          // Live subscription will pick up the new item; no manual
          // invalidation needed unless we're in REST-only mode.
          if (!process.env.NEXT_PUBLIC_FIREBASE_API_KEY) {
            queryClient.invalidateQueries({ queryKey: ['items'] });
          }
        }}
      />

      <ItemDetailsPanel
        itemId={itemDetailsId}
        onClose={() => setItemDetailsId(null)}
        onChanged={() => {
          if (!process.env.NEXT_PUBLIC_FIREBASE_API_KEY) {
            queryClient.invalidateQueries({ queryKey: ['items'] });
          }
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Header — page title + live status + board picker + source filter.          */

function PageHeader({
  items,
  totalItems,
  board,
  boards,
  activeBoardId,
  onBoardChange,
  viewMode,
  onViewModeChange,
  sourceFilter,
  onSourceFilterChange,
  sources,
  projects,
  projectFilter,
  onProjectFilterChange,
  releases,
  releaseFilter,
  onReleaseFilterChange,
  tags,
  tagFilter,
  onTagFilterChange,
  searchQuery,
  onSearchQueryChange,
  onNewItem,
  liveOk,
  liveError,
  brainError,
  onDismissBrainError,
}: {
  items: WorkItem[];
  totalItems: number;
  board: Board | null;
  boards: Board[];
  activeBoardId: string | null;
  onBoardChange: (id: string) => void;
  viewMode: 'board' | 'backlog';
  onViewModeChange: (m: 'board' | 'backlog') => void;
  sourceFilter: string;
  onSourceFilterChange: (s: string) => void;
  sources: { name: string; display_name: string }[];
  projects: { id: string; name: string; color: string }[];
  projectFilter: string;
  onProjectFilterChange: (id: string) => void;
  releases: { id: string; version: string; status: string }[];
  releaseFilter: string;
  onReleaseFilterChange: (id: string) => void;
  tags: { slug: string; label: string; color: string }[];
  tagFilter: string;
  onTagFilterChange: (slug: string) => void;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  onNewItem: () => void;
  liveOk: boolean;
  liveError: Error | null;
  brainError: string | null;
  onDismissBrainError: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-ink-1">Kanban</h1>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-2">
            <span className="font-semibold text-ink-1">{items.length}</span>
            {searchQuery && items.length !== totalItems ? (
              <>
                <span>of</span>
                <span className="font-semibold text-ink-1">{totalItems}</span>
              </>
            ) : null}
            <span>items</span>
            <span aria-hidden className="text-ink-3">·</span>
            <span className="inline-flex items-center gap-1.5">
              <BoardBadge board={board} viewMode={viewMode} />
            </span>
            <span aria-hidden className="text-ink-3">·</span>
            <span className="inline-flex items-center gap-1.5">
              <span className={liveOk ? 'live-dot' : 'h-1.5 w-1.5 rounded-full bg-ink-4'} aria-hidden />
              <span>{liveOk ? 'live' : 'rest snapshot'}</span>
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ViewModeToggle viewMode={viewMode} onChange={onViewModeChange} />
          <SearchInput value={searchQuery} onChange={onSearchQueryChange} />
          <BoardPicker
            boards={boards}
            activeBoardId={activeBoardId}
            onChange={onBoardChange}
            disabled={viewMode === 'backlog'}
          />
          <SourceFilter value={sourceFilter} onChange={onSourceFilterChange} sources={sources} />
          {projects.length > 0 ? (
            <ProjectFilter
              projects={projects}
              value={projectFilter}
              onChange={onProjectFilterChange}
            />
          ) : null}
          {projectFilter && releases.length > 0 ? (
            <ReleaseFilter
              releases={releases}
              value={releaseFilter}
              onChange={onReleaseFilterChange}
            />
          ) : null}
          {tags.length > 0 ? (
            <TagFilter tags={tags} value={tagFilter} onChange={onTagFilterChange} />
          ) : null}
          <button
            type="button"
            onClick={onNewItem}
            className="btn-primary focus-ring inline-flex items-center gap-1.5 px-3.5 py-2 text-[13px] font-medium"
            title="New work item (N)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 5v14" /><path d="M5 12h14" />
            </svg>
            New item
          </button>
          <CurrentUser />
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

      {brainError ? (
        <div
          role="alert"
          className="card-inset flex items-start gap-3 border-status-blocked-500/40 bg-status-blocked-500/5 px-3.5 py-2.5"
        >
          <span aria-hidden className="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-status-blocked-500" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-mono text-[11px] uppercase tracking-wider text-status-blocked-500">
              [err] · brain rejected the transition
            </p>
            <p className="break-words font-mono text-[12.5px] text-status-blocked-600">
              {brainError}
            </p>
          </div>
          <button
            type="button"
            onClick={onDismissBrainError}
            className="btn-ghost focus-ring shrink-0 text-[12px] text-ink-3"
            title="Dismiss"
          >
            dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ViewModeToggle({
  viewMode, onChange,
}: { viewMode: 'board' | 'backlog'; onChange: (m: 'board' | 'backlog') => void }) {
  return (
    <div
      role="tablist"
      aria-label="View mode"
      className="inline-flex items-center rounded-md border border-border-subtle bg-bg-sunken/40 p-0.5"
    >
      {(['board', 'backlog'] as const).map((m) => {
        const active = viewMode === m;
        return (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(m)}
            className={`focus-ring rounded-sm px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-wider transition-colors ${
              active
                ? 'bg-bg-raised text-brand-500 shadow-glow-cyan'
                : 'text-ink-3 hover:text-ink-1'
            }`}
          >
            {m}
          </button>
        );
      })}
    </div>
  );
}

function BoardBadge({ board, viewMode }: { board: Board | null; viewMode: 'board' | 'backlog' }) {
  if (viewMode === 'backlog') {
    return <span className="font-medium text-magenta-500">Backlog</span>;
  }
  if (!board) return <span className="italic text-ink-3">no board</span>;
  return (
    <>
      <span className="font-medium text-ink-1">{board.name}</span>
      {board.is_default ? (
        <span className="rounded border border-border-subtle bg-bg-sunken px-1 text-[10px] font-medium uppercase tracking-wider text-ink-3">default</span>
      ) : null}
    </>
  );
}

function SearchInput({ value, onChange }: { value: string; onChange: (q: string) => void }) {
  return (
    <div className="relative">
      <label htmlFor="kanban-search" className="sr-only">Search items</label>
      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-ink-3">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </span>
      <input
        id="kanban-search"
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search…"
        className="field pl-8 text-[13px] w-44"
      />
    </div>
  );
}

function BoardPicker({
  boards,
  activeBoardId,
  onChange,
  disabled,
}: {
  boards: Board[];
  activeBoardId: string | null;
  onChange: (id: string) => void;
  /** When true (Backlog view), the picker is rendered but not
   *  interactive — the active board is irrelevant to the visible
   *  items, so switching it is a no-op. */
  disabled?: boolean;
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
        disabled={disabled}
        className="field pr-8 text-[13px] disabled:cursor-not-allowed disabled:opacity-50"
        title={disabled ? 'Switch to Board view to change board' : undefined}
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

// Slice 10: structural filters. Each is a select that
// appends to a chain: project → release → tag. Selecting
// "all" for project clears the release (the page does
// this via onChange; the dropdown is just the UI).
function ProjectFilter({
  projects,
  value,
  onChange,
}: {
  projects: { id: string; name: string; color: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="sr-only" htmlFor="project-filter">Project</label>
      <select
        id="project-filter"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="field pr-8 text-[13px]"
        title="Filter by project"
      >
        <option value="">All projects</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function ReleaseFilter({
  releases,
  value,
  onChange,
}: {
  releases: { id: string; version: string; status: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="sr-only" htmlFor="release-filter">Release</label>
      <select
        id="release-filter"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="field pr-8 text-[13px]"
        title="Filter by release"
      >
        <option value="">All releases</option>
        {releases.map((r) => (
          <option key={r.id} value={r.id}>
            {r.version} {r.status === 'shipped' ? '(shipped)' : r.status === 'archived' ? '(archived)' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

function TagFilter({
  tags,
  value,
  onChange,
}: {
  tags: { slug: string; label: string; color: string }[];
  value: string;
  onChange: (slug: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="sr-only" htmlFor="tag-filter">Tag</label>
      <select
        id="tag-filter"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="field pr-8 text-[13px]"
        title="Filter by tag"
      >
        <option value="">All tags</option>
        {tags.map((t) => (
          <option key={t.slug} value={t.slug}>
            {t.label}
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
  onCardClick,
}: {
  id: string;
  label: string;
  kind: StatusKind;
  items: WorkItem[];
  onCardClick: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      // Slice 9: cap the column at (viewport - 220px) so the
      // top bar, board picker, search bar and item-details drawer
      // stay visible while the cards inside scroll. The
      // `min-h-[280px]` keeps the column looking like a column
      // when empty. Sticky header with a translucent background
      // so cards never bleed through the column title.
      className={`flex max-h-[calc(100vh-220px)] min-h-[280px] flex-col rounded-2xl border bg-bg-surface/60 backdrop-blur-sm transition-all duration-200 ease-spring ${
        isOver
          ? 'border-brand-500/60 bg-brand-500/5 shadow-glow'
          : 'border-border-subtle'
      }`}
    >
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border-subtle bg-bg-surface/95 px-3.5 py-2.5 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full bg-status-${kind}-500`} />
          <h2 className="text-[13px] font-semibold uppercase tracking-wider text-ink-2">{label}</h2>
        </div>
        <span className="rounded-md border border-border-subtle bg-bg-sunken px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-ink-2">
          {items.length}
        </span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-2.5">
        {items.map((item) => (
          <KanbanCard key={item.id} item={item} onClick={onCardClick} />
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

function KanbanCard({ item, onClick }: { item: WorkItem; onClick: (id: string) => void }) {
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
      onClick={() => onClick(item.id)}
      className={`group relative cursor-pointer rounded-xl border border-border-subtle bg-bg-surface p-3 shadow-card transition-shadow duration-150 ease-out-quint hover:border-border-default hover:shadow-card-lg ${
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
        {item.archived_at ? (
          <Pill kind="blocked" dot={false} className="!ring-status-blocked-500/30">archived</Pill>
        ) : null}
      </div>
      <p className="mt-1.5 line-clamp-2 text-[13.5px] font-medium leading-snug text-ink-1">{item.title}</p>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-3">
        {item.due_at ? <span>due {formatDate(item.due_at)}</span> : null}
        {item.due_at && item.owner ? <span aria-hidden>·</span> : null}
        {item.owner ? <span className="truncate">{item.owner}</span> : null}
      </div>
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
/* Current user chip — shows the signed-in email and admin badge in the        */
/* page header. The auth gate in providers.tsx already redirects to /login    */
/* when the user is not signed in, so this is purely informational.            */

function CurrentUser() {
  const auth = useAuth();
  if (!auth.firebaseUser) return null;
  const email = auth.firebaseUser.email ?? '';
  const isAdmin = auth.isAdmin;
  return (
    <div className="hidden items-center gap-2 text-[12px] text-ink-2 sm:flex">
      <span
        aria-hidden
        className={`inline-block h-1.5 w-1.5 rounded-full ${isAdmin ? 'bg-status-ready-500' : 'bg-ink-3'}`}
      />
      <span className="truncate max-w-[200px]">{email}</span>
      {isAdmin ? (
        <span className="rounded-md border border-brand-500/30 bg-brand-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand-500">
          admin
        </span>
      ) : null}
    </div>
  );
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

function isValidTransition(from: WorkItemStatus, to: WorkItemStatus, kind: WorkItem['kind']): boolean {
  // Slice 3 — defer to the shared state machine in
  // @worktracker/types. The local stub this replaced was buggy
  // (reversed the edge lookup) and didn't validate per-kind.
  return canTransition(from, to, kind).ok;
}
