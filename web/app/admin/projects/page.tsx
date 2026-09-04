'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateProjectRequest, Project, ProjectColor } from '@worktracker/types';
import { api } from '../../../lib/api';
import { Modal } from '../../../components/Modal';
import { EmptyState } from '../../../components/EmptyState';
import { Pill } from '../../../components/Pill';

const COLORS: ProjectColor[] = [
  'cyan', 'magenta', 'amber', 'emerald', 'violet', 'rose', 'slate',
];

/**
 * /admin/projects — top-level structural container.
 *
 * A project owns Releases, can be color-tagged, and is what
 * the kanban filter uses to scope "what's in <project>".
 * Archived projects are hidden from the kanban picker but
 * keep their `WorkItem.project_id` references intact.
 */
export default function ProjectsAdminPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects(),
  });
  const projects = data?.projects ?? [];
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);

  const createProject = useMutation({
    mutationFn: (body: CreateProjectRequest) => api.createProject(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setCreating(false);
    },
  });
  const updateProject = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.updateProject>[1] }) =>
      api.updateProject(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setEditing(null);
    },
  });
  const deleteProject = useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">// structure</p>
          <h1 className="text-2xl font-bold tracking-tight text-ink-1">Projects</h1>
          <p className="max-w-2xl text-[13px] text-ink-2">
            Top-level containers. A project owns Releases; work items reference a project so the
            kanban can filter by it. Archived projects stay in the data so existing items keep
            resolving, but they're hidden from pickers.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => refetch()} className="btn-secondary focus-ring">
            Refresh
          </button>
          <button type="button" onClick={() => setCreating(true)} className="btn-primary focus-ring">
            New project
          </button>
        </div>
      </header>

      {isLoading ? (
        <ul className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((i) => (
            <li key={i} className="skeleton h-28" />
          ))}
        </ul>
      ) : null}
      {error ? <p className="text-[13px] text-status-blocked">Failed to load projects.</p> : null}

      {!isLoading && projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          body="Create your first project. The kanban filter will pick it up immediately."
          action={
            <button type="button" onClick={() => setCreating(true)} className="btn-primary focus-ring">
              Create the first one
            </button>
          }
        />
      ) : null}

      <ul className="grid gap-4 md:grid-cols-2">
        {projects.map((p) => (
          <li
            key={p.id}
            className="card group relative overflow-hidden p-5 transition-all duration-200 ease-out-quint hover:border-border-default hover:shadow-card-lg"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1.5">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={`inline-block h-2 w-2 rounded-full bg-status-${p.color}-500`}
                  />
                  <h3 className="truncate text-[15px] font-semibold tracking-tight text-ink-1">
                    {p.name}
                  </h3>
                  {p.archived ? (
                    <Pill kind="blocked" dot={false} className="!ring-status-blocked-500/30 !bg-status-blocked-500/10 !text-status-blocked-600">
                      archived
                    </Pill>
                  ) : null}
                </div>
                <p className="font-mono text-[11px] text-ink-3">/{p.slug}</p>
                {p.description ? (
                  <p className="line-clamp-2 text-[12.5px] text-ink-2">{p.description}</p>
                ) : null}
                <p className="text-[11px] text-ink-3">
                  created:{' '}
                  <span className="text-ink-2">{new Date(p.created_at).toLocaleString()}</span>
                </p>
              </div>
              <div className="shrink-0 space-y-1 text-right">
                <button
                  type="button"
                  onClick={() => setEditing(p)}
                  className="btn-ghost focus-ring text-[11.5px] text-ink-2"
                >
                  Edit
                </button>
                {!p.archived ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`Archive "${p.name}"?`)) deleteProject.mutate(p.id);
                    }}
                    disabled={deleteProject.isPending}
                    className="btn-ghost focus-ring text-[11.5px] text-status-blocked-600 disabled:opacity-50"
                  >
                    Archive
                  </button>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {creating ? (
        <ProjectModal
          onClose={() => setCreating(false)}
          onSubmit={(body) => createProject.mutate(body)}
          isPending={createProject.isPending}
          error={createProject.error ? (createProject.error as Error).message : null}
        />
      ) : null}
      {editing ? (
        <ProjectModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSubmit={(body) => {
            // The modal's signature uses CreateProjectRequest for
            // its onSubmit, but in edit mode the slug is locked.
            // Pass through the editable fields only.
            updateProject.mutate({
              id: editing.id,
              body: {
                name: body.name,
                description: body.description ?? null,
                color: body.color,
                archived: editing.archived,
              },
            });
          }}
          isPending={updateProject.isPending}
          error={updateProject.error ? (updateProject.error as Error).message : null}
        />
      ) : null}
    </div>
  );
}

function ProjectModal({
  initial,
  onClose,
  onSubmit,
  isPending,
  error,
}: {
  initial?: Project;
  onClose: () => void;
  // Discriminated submit: the create path needs slug; the
  // update path doesn't. The two bodies are separate.
  onSubmit: (body: CreateProjectRequest) => void;
  isPending: boolean;
  error: string | null;
}) {
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [color, setColor] = useState<ProjectColor>(initial?.color ?? 'cyan');
  const [archived, setArchived] = useState(initial?.archived ?? false);

  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? 'Edit project' : 'New project'}
      size="md"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-secondary focus-ring">
            Cancel
          </button>
          <button
            type="button"
            disabled={isPending || !name || !slug}
            onClick={() => onSubmit({ slug, name, description: description || null, color })}
            className="btn-primary focus-ring disabled:opacity-50"
          >
            {isPending ? 'Saving…' : initial ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="field"
            placeholder="Web client"
          />
        </Field>
        <Field label="Slug" hint="URL-safe; used in path lookups">
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
            className="field font-mono"
            placeholder="web-client"
            disabled={!!initial}
          />
        </Field>
        <Field label="Description">
          <textarea
            value={description ?? ''}
            onChange={(e) => setDescription(e.target.value)}
            className="field h-20"
            placeholder="What is this project about?"
          />
        </Field>
        <Field label="Color">
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors ${
                  color === c
                    ? 'border-brand-500/60 bg-brand-500/10 text-ink-1'
                    : 'border-border-subtle bg-bg-sunken/30 text-ink-2 hover:bg-bg-sunken/60'
                }`}
              >
                <span aria-hidden className={`inline-block h-2 w-2 rounded-full bg-status-${c}-500`} />
                {c}
              </button>
            ))}
          </div>
        </Field>
        {initial ? (
          <label className="flex items-center gap-2 text-[12px] text-ink-2">
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => setArchived(e.target.checked)}
              className="rounded border-border-subtle"
            />
            archived
          </label>
        ) : null}
        {error ? <p className="text-[12px] text-status-blocked-600">{error}</p> : null}
      </div>
    </Modal>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[11px] font-medium uppercase tracking-wider text-ink-3">
        {label}
      </label>
      {children}
      {hint ? <p className="text-[11px] text-ink-4">{hint}</p> : null}
    </div>
  );
}
