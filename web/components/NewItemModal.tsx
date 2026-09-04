'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkItem, WorkItemKind } from '@worktracker/types';
import { api } from '../lib/api';
import { Modal } from './Modal';

const KINDS: WorkItemKind[] = ['task', 'ticket', 'decision', 'review'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
const PRIORITIES = ['low', 'medium', 'high'] as const;

export function NewItemModal({
  open,
  onClose,
  defaultKind = 'task',
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  defaultKind?: WorkItemKind;
  onCreated?: (itemId: string) => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<WorkItemKind>(defaultKind);
  const [severity, setSeverity] = useState<string>('');
  const [priority, setPriority] = useState<string>('');
  const [owner, setOwner] = useState('');
  const [due, setDue] = useState(''); // YYYY-MM-DD
  // Slice 10: project / release / tag taxonomy. The release
  // dropdown is filtered to the selected project so the operator
  // can't accidentally point a release from project A at an
  // item in project B.
  const [projectId, setProjectId] = useState<string>('');
  const [releaseId, setReleaseId] = useState<string>('');
  const [tagSlugs, setTagSlugs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Lazy-load the structural primitives. The pickers fall
  // back to "(none)" if the lists are empty.
  const { data: projectsData } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects(),
    enabled: open,
  });
  const projects = projectsData?.projects ?? [];
  const { data: tagsData } = useQuery({
    queryKey: ['tags'],
    queryFn: () => api.listTags(),
    enabled: open,
  });
  const tags = tagsData?.tags ?? [];
  const { data: releasesData } = useQuery({
    queryKey: ['releases', projectId],
    queryFn: () => api.listReleases(projectId ? { project_id: projectId } : {}),
    enabled: open && !!projectId,
  });
  const releases = releasesData?.releases ?? [];

  const create = useMutation({
    mutationFn: () =>
      api.createItem({
        kind,
        title: title.trim(),
        body: body.trim() || undefined,
        severity: (severity || undefined) as WorkItem['severity'],
        priority: (priority || undefined) as WorkItem['priority'],
        owner: owner.trim() || undefined,
        due_at: due ? new Date(`${due}T17:00:00Z`).toISOString() : undefined,
        project_id: projectId || undefined,
        release_id: releaseId || undefined,
        tag_slugs: tagSlugs.length > 0 ? tagSlugs : undefined,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['items'] });
      onCreated?.(res.command_id);
      reset();
      onClose();
    },
    onError: (err) => {
      setError((err as Error).message);
    },
  });

  function reset() {
    setTitle('');
    setBody('');
    setKind(defaultKind);
    setSeverity('');
    setPriority('');
    setOwner('');
    setDue('');
    setProjectId('');
    setReleaseId('');
    setTagSlugs([]);
    setError(null);
  }

  function toggleTag(slug: string) {
    setTagSlugs((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    );
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (create.isPending) return;
    if (!title.trim()) {
      setError('Title is required.');
      return;
    }
    setError(null);
    create.mutate();
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (create.isPending) return;
        reset();
        onClose();
      }}
      title="New work item"
      size="md"
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Title" required>
          <input
            type="text"
            autoFocus
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="field w-full text-[14px]"
            placeholder="What needs to be done?"
            disabled={create.isPending}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Kind">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as WorkItemKind)}
              className="field w-full text-[14px]"
              disabled={create.isPending}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              className="field w-full text-[14px]"
              disabled={create.isPending}
            >
              <option value="">none</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </Field>
          <Field label="Severity">
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
              className="field w-full text-[14px]"
              disabled={create.isPending}
            >
              <option value="">none</option>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="Owner">
            <input
              type="text"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              className="field w-full text-[14px]"
              placeholder="@handle or email"
              disabled={create.isPending}
            />
          </Field>
        </div>

        {/* Slice 10 — project / release / tag pickers. The release
            dropdown is filtered to the selected project so a release
            from project A can't be assigned to an item in project B. */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Project">
            <select
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setReleaseId(''); // clear stale release
              }}
              className="field w-full text-[14px]"
              disabled={create.isPending}
            >
              <option value="">none</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Release" hint={!projectId ? 'Pick a project first' : undefined}>
            <select
              value={releaseId}
              onChange={(e) => setReleaseId(e.target.value)}
              className="field w-full text-[14px]"
              disabled={create.isPending || !projectId}
            >
              <option value="">none</option>
              {releases.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.version} {r.status === 'shipped' ? '(shipped)' : r.status === 'archived' ? '(archived)' : ''}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {tags.length > 0 ? (
          <Field label="Tags" hint="Click to toggle. Managed in /admin/tags.">
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => {
                const on = tagSlugs.includes(t.slug);
                return (
                  <button
                    key={t.slug}
                    type="button"
                    onClick={() => toggleTag(t.slug)}
                    disabled={create.isPending}
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11.5px] transition-colors disabled:opacity-50 ${
                      on
                        ? 'border-brand-500/60 bg-brand-500/10 text-ink-1'
                        : 'border-border-subtle bg-bg-sunken/40 text-ink-2 hover:bg-bg-sunken/70'
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`inline-block h-1.5 w-1.5 rounded-full bg-status-${t.color}-500`}
                    />
                    {t.label}
                  </button>
                );
              })}
            </div>
          </Field>
        ) : null}

        <Field label="Body">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            className="field w-full resize-y text-[14px]"
            placeholder="Optional context, acceptance criteria, links…"
            disabled={create.isPending}
          />
        </Field>

        <Field label="Due date">
          <input
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="field w-full text-[14px]"
            disabled={create.isPending}
          />
        </Field>

        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-status-blocked-500/40 bg-status-blocked-500/10 px-3 py-2 text-[12.5px] text-status-blocked-600"
          >
            {error}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={() => { reset(); onClose(); }}
            disabled={create.isPending}
            className="btn-ghost focus-ring text-[13px] text-ink-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={create.isPending || !title.trim()}
            className="btn-primary focus-ring inline-flex items-center gap-2 px-4 py-2 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create item'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, children, required, hint }: { label: string; children: React.ReactNode; required?: boolean; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[11.5px] font-medium uppercase tracking-wider text-ink-3">
        {label}{required ? <span className="text-status-blocked-500"> *</span> : null}
      </label>
      {children}
      {hint ? <p className="text-[11px] text-ink-4">{hint}</p> : null}
    </div>
  );
}
