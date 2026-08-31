'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Board, BoardColumn, WorkItemKind } from '@worktracker/types';
import { api } from '../../../lib/api';

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
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Boards</h1>
          <p className="text-sm text-slate-500">
            Saved kanban views. Each board pins a list of columns (label + statuses) and an optional kind filter.
            The default board is the first thing every user sees on the kanban.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => refetch()}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            New board
          </button>
        </div>
      </header>

      {isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {error ? <p className="text-sm text-rose-600">Failed to load boards.</p> : null}

      {!isLoading && boards.length === 0 ? (
        <div className="card p-6 text-center text-sm text-slate-500">
          <p>No boards yet.</p>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="mt-3 rounded bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            Create the first one
          </button>
        </div>
      ) : null}

      <ul className="space-y-3">
        {boards.map((b) => (
          <li key={b.id} className="card p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-semibold">
                  {b.name}
                  {b.is_default ? (
                    <span className="ml-2 rounded bg-brand-100 px-1.5 py-0.5 text-xs text-brand-700">default</span>
                  ) : null}
                </p>
                {b.description ? (
                  <p className="mt-1 text-sm text-slate-600">{b.description}</p>
                ) : null}
                <p className="mt-1 text-xs text-slate-400">
                  {b.columns.length} columns
                  {b.kinds ? ` · kinds: ${b.kinds.join(', ')}` : ' · all kinds'}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(b)}
                  className="rounded border border-slate-300 px-3 py-1.5 text-sm"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm(`Delete board "${b.name}"?`)) deleteBoard.mutate(b.id);
                  }}
                  disabled={b.is_default || deleteBoard.isPending}
                  title={b.is_default ? 'Unset default before deleting' : undefined}
                  className="rounded border border-rose-300 px-3 py-1.5 text-sm text-rose-700 disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {b.columns.map((c) => (
                <span
                  key={c.id}
                  className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs"
                >
                  <span className="font-medium">{c.label}</span>
                  <span className="ml-1 text-slate-500">({c.statuses.join(', ')})</span>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="card w-full max-w-2xl p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">{initial.id ? 'Edit board' : 'New board'}</h2>
        <div className="mt-3 space-y-3">
          <label className="block">
            <span className="text-sm text-slate-700">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 block w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm text-slate-700">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="mt-1 block w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
          <fieldset>
            <legend className="text-sm text-slate-700">Kinds (empty = all)</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {KINDS.map((k) => (
                <label key={k} className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={kinds.includes(k)}
                    onChange={(e) =>
                      setKinds(e.target.checked ? [...kinds, k] : kinds.filter((x) => x !== k))
                    }
                  />
                  {k}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
            />
            Default board
          </label>

          <fieldset>
            <legend className="text-sm text-slate-700">Columns</legend>
            <div className="mt-1 space-y-2">
              {columns.map((c, idx) => (
                <div key={c.id} className="rounded border border-slate-200 p-2">
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      value={c.id}
                      onChange={(e) => updateColumn(idx, { id: e.target.value })}
                      placeholder="column id"
                      className="rounded border border-slate-300 px-2 py-1 text-xs"
                    />
                    <input
                      value={c.label}
                      onChange={(e) => updateColumn(idx, { label: e.target.value })}
                      placeholder="label"
                      className="rounded border border-slate-300 px-2 py-1 text-xs"
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
                    placeholder="statuses (comma-separated)"
                    className="mt-2 block w-full rounded border border-slate-300 px-2 py-1 text-xs"
                  />
                  <div className="mt-2 flex justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => moveColumn(idx, -1)}
                      disabled={idx === 0}
                      className="rounded border border-slate-300 px-2 py-0.5 text-xs"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveColumn(idx, 1)}
                      disabled={idx === columns.length - 1}
                      className="rounded border border-slate-300 px-2 py-0.5 text-xs"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => removeColumn(idx)}
                      className="rounded border border-rose-300 px-2 py-0.5 text-xs text-rose-700"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={addColumn}
                className="rounded border border-dashed border-slate-300 px-3 py-1.5 text-sm"
              >
                + Add column
              </button>
            </div>
          </fieldset>

          {error ? <p className="text-sm text-rose-600">{(error as Error).message}</p> : null}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm"
          >
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
            className="rounded bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : initial.id ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
