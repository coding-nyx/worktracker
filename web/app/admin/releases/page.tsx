'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateReleaseRequest, Release, ReleaseStatus } from '@worktracker/types';
import { api } from '../../../lib/api';
import { Modal } from '../../../components/Modal';
import { EmptyState } from '../../../components/EmptyState';
import { Pill } from '../../../components/Pill';

const STATUSES: ReleaseStatus[] = ['planned', 'in_progress', 'shipped', 'archived'];

/**
 * /admin/releases — versioned batches inside a Project.
 *
 * A Release is a label like "v2.4" or "2024.10" that an item can
 * target. The kanban filter can show "what's in v2.4". Releases
 * are soft-archived; existing item references keep resolving.
 */
export default function ReleasesAdminPage() {
  const queryClient = useQueryClient();
  const { data: projectsData } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects(),
  });
  const projects = projectsData?.projects ?? [];
  const projectsById = new Map(projects.map((p) => [p.id, p] as const));

  const [filterProject, setFilterProject] = useState<string>('');
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['releases', filterProject],
    queryFn: () => api.listReleases(filterProject ? { project_id: filterProject } : {}),
  });
  const releases = data?.releases ?? [];
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Release | null>(null);

  const createRelease = useMutation({
    mutationFn: (body: CreateReleaseRequest) => api.createRelease(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['releases'] });
      setCreating(false);
    },
  });
  const updateRelease = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.updateRelease>[1] }) =>
      api.updateRelease(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['releases'] });
      setEditing(null);
    },
  });
  const deleteRelease = useMutation({
    mutationFn: (id: string) => api.deleteRelease(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['releases'] });
    },
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">// structure</p>
          <h1 className="text-2xl font-bold tracking-tight text-ink-1">Releases</h1>
          <p className="max-w-2xl text-[13px] text-ink-2">
            Versioned batches inside a project. Items can target a release so the kanban can filter
            "what's in v2.4". Releases are soft-archived; existing item references keep resolving.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => refetch()} className="btn-secondary focus-ring">
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setCreating(true)}
            disabled={projects.length === 0}
            className="btn-primary focus-ring disabled:opacity-50"
            title={projects.length === 0 ? 'Create a project first' : 'New release'}
          >
            New release
          </button>
        </div>
      </header>

      <div className="flex items-center gap-2 text-[12px]">
        <label className="text-ink-3">Filter by project:</label>
        <select
          value={filterProject}
          onChange={(e) => setFilterProject(e.target.value)}
          className="field w-auto"
        >
          <option value="">All</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <ul className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((i) => (
            <li key={i} className="skeleton h-24" />
          ))}
        </ul>
      ) : null}

      {!isLoading && releases.length === 0 ? (
        <EmptyState
          title="No releases yet"
          body={
            projects.length === 0
              ? 'Create a project first — every release lives inside one.'
              : 'Create a release to start grouping work items by version.'
          }
        />
      ) : null}

      <ul className="grid gap-4 md:grid-cols-2">
        {releases.map((r) => {
          const project = projectsById.get(r.project_id);
          return (
            <li
              key={r.id}
              className="card group relative overflow-hidden p-5 transition-all duration-200 ease-out-quint hover:border-border-default hover:shadow-card-lg"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <h3 className="font-mono text-[14px] font-semibold tracking-tight text-ink-1">
                      {r.version}
                    </h3>
                    <Pill
                      kind={
                        r.status === 'shipped'
                          ? 'done'
                          : r.status === 'in_progress'
                            ? 'progress'
                            : r.status === 'archived'
                              ? 'blocked'
                              : 'backlog'
                      }
                      dot={false}
                    >
                      {r.status}
                    </Pill>
                  </div>
                  <p className="text-[11.5px] text-ink-3">
                    project:{' '}
                    <span className="text-ink-2">{project?.name ?? r.project_id}</span>
                  </p>
                  {r.release_at ? (
                    <p className="text-[11px] text-ink-3">
                      ships: <span className="text-ink-2">{r.release_at.slice(0, 10)}</span>
                    </p>
                  ) : null}
                  {r.notes ? (
                    <p className="line-clamp-2 text-[12px] text-ink-2">{r.notes}</p>
                  ) : null}
                </div>
                <div className="shrink-0 space-y-1 text-right">
                  <button
                    type="button"
                    onClick={() => setEditing(r)}
                    className="btn-ghost focus-ring text-[11.5px] text-ink-2"
                  >
                    Edit
                  </button>
                  {r.status !== 'archived' ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm(`Archive release "${r.version}"?`)) deleteRelease.mutate(r.id);
                      }}
                      disabled={deleteRelease.isPending}
                      className="btn-ghost focus-ring text-[11.5px] text-status-blocked-600 disabled:opacity-50"
                    >
                      Archive
                    </button>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {creating ? (
        <ReleaseModal
          projects={projects}
          onClose={() => setCreating(false)}
          onSubmit={(body) => createRelease.mutate(body)}
          isPending={createRelease.isPending}
          error={createRelease.error ? (createRelease.error as Error).message : null}
        />
      ) : null}
      {editing ? (
        <ReleaseModal
          initial={editing}
          projects={projects}
          onClose={() => setEditing(null)}
          onSubmit={(body) => {
            updateRelease.mutate({
              id: editing.id,
              body: {
                version: body.version,
                status: body.status,
                release_at: body.release_at ?? null,
                notes: body.notes ?? null,
              },
            });
          }}
          isPending={updateRelease.isPending}
          error={updateRelease.error ? (updateRelease.error as Error).message : null}
        />
      ) : null}
    </div>
  );
}

function ReleaseModal({
  initial,
  projects,
  onClose,
  onSubmit,
  isPending,
  error,
}: {
  initial?: Release;
  projects: { id: string; name: string }[];
  onClose: () => void;
  onSubmit: (body: CreateReleaseRequest) => void;
  isPending: boolean;
  error: string | null;
}) {
  const [projectId, setProjectId] = useState(initial?.project_id ?? projects[0]?.id ?? '');
  const [version, setVersion] = useState(initial?.version ?? '');
  const [status, setStatus] = useState<ReleaseStatus>(initial?.status ?? 'planned');
  const [releaseAt, setReleaseAt] = useState(initial?.release_at?.slice(0, 10) ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');

  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? 'Edit release' : 'New release'}
      size="md"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-secondary focus-ring">
            Cancel
          </button>
          <button
            type="button"
            disabled={isPending || !version || !projectId}
            onClick={() =>
              onSubmit({
                project_id: projectId,
                version,
                status,
                release_at: releaseAt ? new Date(releaseAt).toISOString() : null,
                notes: notes || null,
              })
            }
            className="btn-primary focus-ring disabled:opacity-50"
          >
            {isPending ? 'Saving…' : initial ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Project">
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="field"
            disabled={!!initial}
          >
            {projects.length === 0 ? <option value="">No projects yet</option> : null}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Version">
          <input
            type="text"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            className="field font-mono"
            placeholder="v2.4"
            disabled={!!initial}
          />
        </Field>
        <Field label="Status">
          <div className="flex flex-wrap gap-2">
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                className={`rounded-md border px-2.5 py-1.5 text-[12px] transition-colors ${
                  status === s
                    ? 'border-brand-500/60 bg-brand-500/10 text-ink-1'
                    : 'border-border-subtle bg-bg-sunken/30 text-ink-2 hover:bg-bg-sunken/60'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Release date">
          <input
            type="date"
            value={releaseAt}
            onChange={(e) => setReleaseAt(e.target.value)}
            className="field"
          />
        </Field>
        <Field label="Notes">
          <textarea
            value={notes ?? ''}
            onChange={(e) => setNotes(e.target.value)}
            className="field h-20"
            placeholder="What ships in this release?"
          />
        </Field>
        {error ? <p className="text-[12px] text-status-blocked-600">{error}</p> : null}
      </div>
    </Modal>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[11px] font-medium uppercase tracking-wider text-ink-3">
        {label}
      </label>
      {children}
    </div>
  );
}
