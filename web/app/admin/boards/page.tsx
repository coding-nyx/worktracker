'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Board, BoardColumn, WorkItemKind } from '@worktracker/types';
import { api } from '../../../lib/api';
import { Modal } from '../../../components/Modal';
import { EmptyState } from '../../../components/EmptyState';
import { Pill } from '../../../components/Pill';

const KINDS: WorkItemKind[] = ['task', 'ticket', 'decision', 'review'];

export default function BoardsAdminPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['boards'],
    queryFn: () => api.listBoards(),
  });
  const boards = data?.boards ?? [];
  const [editing, setEditing] = useState<Board | null>(null);
  const [creating, setCreating] = useState(false);

  const createBoard = useMutation({
    mutationFn: (body: Parameters<typeof api.createBoard>[0]) => api.createBoard(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['boards'] });
      setCreating(false);
    },
  });
  const updateBoard = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.updateBoard>[1] }) =>
      api.updateBoard(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['boards'] });
      setEditing(null);
    },
  });
  const deleteBoard = useMutation({
    mutationFn: (id: string) => api.deleteBoard(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['boards'] });
    },
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">multi-board</p>
          <h1 className="text-2xl font-bold tracking-tight text-ink-1">Boards</h1>
          <p className="max-w-2xl text-[13px] text-ink-2">
            Saved kanban views. Each board pins a list of columns (label + statuses) and an optional
            kind filter. The default board is the first thing every user sees on the kanban.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => refetch()} className="btn-secondary focus-ring">
            Refresh
          </button>
          <button type="button" onClick={() => setCreating(true)} className="btn-primary focus-ring">
            New board
          </button>
        </div>
      </header>

      {isLoading ? (
        <ul className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((i) => (
            <li key={i} className="skeleton h-32" />
          ))}
        </ul>
      ) : null}
      {error ? <p className="text-[13px] text-status-blocked">Failed to load boards.</p> : null}

      {!isLoading && boards.length === 0 ? (
        <EmptyState
          title="No boards yet"
          body="Create the first board and every user will see it as the default landing view."
          action={
            <button type="button" onClick={() => setCreating(true)} className="btn-primary focus-ring">
              Create the first one
            </button>
          }
        />
      ) : null}

      <ul className="grid gap-4 md:grid-cols-2">
        {boards.map((b) => (
          <li
            key={b.id}
            className="card group relative overflow-hidden p-5 transition-all duration-200 ease-out-quint hover:border-border-default hover:shadow-card-lg"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1.5">
                <div className="flex items-center gap-2">
                  <h3 className="truncate text-[15px] font-semibold tracking-tight text-ink-1">
                    {b.name}
                  </h3>
                  {b.is_default ? (
                    <Pill kind="ready" dot={false} className="!ring-status-ready/40 !bg-status-ready/10 !text-status-ready">
                      <span aria-hidden>★</span>
                      <span>default</span>
                    </Pill>
                  ) : null}
                </div>
                {b.description ? (
                  <p className="text-[12.5px] leading-5 text-ink-2">{b.description}</p>
                ) : null}
                <p className="text-[11px] uppercase tracking-wider text-ink-3">
                  {b.columns.length} column{b.columns.length === 1 ? '' : 's'}
                  <span className="px-1 text-ink-4">·</span>
                  {b.kinds && b.kinds.length > 0 ? `kinds: ${b.kinds.join(', ')}` : 'all kinds'}
                </p>
              </div>
              <div className="flex shrink-0 gap-2 opacity-60 transition-opacity group-hover:opacity-100">
                <button type="button" onClick={() => setEditing(b)} className="btn-secondary focus-ring">
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm(`Delete board "${b.name}"?`)) deleteBoard.mutate(b.id);
                  }}
                  disabled={b.is_default || deleteBoard.isPending}
                  title={b.is_default ? 'Unset default before deleting' : undefined}
                  className="btn-danger focus-ring"
                >
                  Delete
                </button>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {b.columns.map((c) => (
                <span
                  key={c.id}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-sunken px-2 py-0.5 text-[11px]"
                >
                  <span className="font-medium text-ink-1">{c.label}</span>
                  <span className="text-ink-3">({c.statuses.join(', ')})</span>
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>

      {creating ? (
        <BoardEditor
          initial={emptyBoard()}
          onCancel={() => setCreating(false)}
          onSave={(body) => createBoard.mutate(body)}
          saving={createBoard.isPending}
          error={createBoard.error}
        />
      ) : null}

      {editing ? (
        <BoardEditor
          initial={editing}
          onCancel={() => setEditing(null)}
          onSave={(body) => updateBoard.mutate({ id: editing.id, body })}
          saving={updateBoard.isPending}
          error={updateBoard.error}
        />
      ) : null}
    </div>
  );
}

function emptyBoard(): Board {
  return {
    id: '',
    name: 'New board',
    columns: [
      { id: 'todo', label: 'To Do', statuses: ['open'] },
      { id: 'doing', label: 'In Progress', statuses: ['in_progress'] },
      { id: 'done', label: 'Done', statuses: ['done', 'cancelled'] },
    ],
    is_default: false,
    created_at: '',
    updated_at: '',
  };
}

function BoardEditor({
  initial,
  onCancel,
  onSave,
  saving,
  error,
}: {
  initial: Board;
  onCancel: () => void;
  onSave: (body: Parameters<typeof api.createBoard>[0]) => void;
  saving: boolean;
  error: unknown;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? '');
  const [kinds, setKinds] = useState<WorkItemKind[]>(initial.kinds ?? []);
  const [isDefault, setIsDefault] = useState(initial.is_default);
  const [columns, setColumns] = useState<BoardColumn[]>(initial.columns);

  function addColumn() {
    setColumns([
      ...columns,
      { id: `col-${Date.now()}`, label: 'New column', statuses: ['open'] },
    ]);
  }
  function updateColumn(idx: number, patch: Partial<BoardColumn>) {
    setColumns(columns.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }
  function removeColumn(idx: number) {
    setColumns(columns.filter((_, i) => i !== idx));
  }
  function moveColumn(idx: number, dir: -1 | 1) {
    const next = [...columns];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    setColumns(next);
  }

  return (
    <Modal
      open
      onClose={onCancel}
      title={initial.id ? 'Edit board' : 'New board'}
      size="lg"
      footer={
        <>
          <button type="button" onClick={onCancel} className="btn-secondary focus-ring">
            Cancel
          </button>
          <button
            type="button"
            onClick={() =>
              onSave({
                name,
                description: description || undefined,
                kinds: kinds.length > 0 ? kinds : undefined,
                columns,
                is_default: isDefault,
              })
            }
            disabled={saving || name.trim().length === 0 || columns.length === 0}
            className="btn-primary focus-ring"
          >
            {saving ? 'Saving…' : initial.id ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="field mt-1.5"
            placeholder="e.g. Engineering Pipeline"
          />
        </label>
        <label className="block">
          <span className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="field mt-1.5"
            placeholder="What is this board for?"
          />
        </label>
        <fieldset>
          <legend className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">
            Kinds <span className="font-normal normal-case text-ink-4">(empty = all kinds)</span>
          </legend>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {KINDS.map((k) => {
              const checked = kinds.includes(k);
              return (
                <label
                  key={k}
                  className={`focus-ring inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
                    checked
                      ? 'border-brand-500/50 bg-brand-500/10 text-brand-500'
                      : 'border-border-subtle bg-bg-surface text-ink-2 hover:border-border-default'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) =>
                      setKinds(e.target.checked ? [...kinds, k] : kinds.filter((x) => x !== k))
                    }
                    className="sr-only"
                  />
                  {k}
                </label>
              );
            })}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-[13px] text-ink-1">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="h-4 w-4 rounded border-border-default bg-bg-surface accent-brand-500"
          />
          Set as default board
        </label>

        <fieldset>
          <legend className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">Columns</legend>
          <div className="mt-2 space-y-2">
            {columns.map((c, idx) => (
              <div key={c.id} className="card-inset space-y-2 p-3">
                <div className="grid gap-2 md:grid-cols-2">
                  <input
                    value={c.id}
                    onChange={(e) => updateColumn(idx, { id: e.target.value })}
                    placeholder="column id"
                    className="field"
                  />
                  <input
                    value={c.label}
                    onChange={(e) => updateColumn(idx, { label: e.target.value })}
                    placeholder="label"
                    className="field"
                  />
                </div>
                <input
                  value={c.statuses.join(',')}
                  onChange={(e) =>
                    updateColumn(idx, {
                      statuses: e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder="statuses (comma-separated, e.g. task.in_progress, ticket.in_progress)"
                  className="field"
                />
                <div className="flex justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => moveColumn(idx, -1)}
                    disabled={idx === 0}
                    className="btn-ghost focus-ring !px-2 !py-0.5 text-[12px]"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => moveColumn(idx, 1)}
                    disabled={idx === columns.length - 1}
                    className="btn-ghost focus-ring !px-2 !py-0.5 text-[12px]"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => removeColumn(idx)}
                    className="btn-ghost focus-ring !px-2 !py-0.5 text-[12px] text-status-blocked"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
            <button type="button" onClick={addColumn} className="btn-ghost focus-ring border border-dashed border-border-default w-full">
              + Add column
            </button>
          </div>
        </fieldset>

        {error ? <p className="text-[13px] text-status-blocked">{(error as Error).message}</p> : null}
      </div>
    </Modal>
  );
}
