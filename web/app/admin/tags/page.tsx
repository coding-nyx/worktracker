'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateTagRequest, ProjectColor, TagTaxonomy } from '@worktracker/types';
import { api } from '../../../lib/api';
import { Modal } from '../../../components/Modal';
import { EmptyState } from '../../../components/EmptyState';
import { Pill } from '../../../components/Pill';

const COLORS: ProjectColor[] = [
  'cyan', 'magenta', 'amber', 'emerald', 'violet', 'rose', 'slate',
];

/**
 * /admin/tags — managed label set.
 *
 * Tags are a controlled vocabulary. Work items reference slugs;
 * the kanban filter and detail view resolve the slug to
 * label + color via this table. Free-form `data.tags` from
 * older items is read-only and surfaced as "legacy".
 */
export default function TagsAdminPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['tags'],
    queryFn: () => api.listTags(),
  });
  const tags = data?.tags ?? [];
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<TagTaxonomy | null>(null);

  const createTag = useMutation({
    mutationFn: (body: CreateTagRequest) => api.createTag(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      setCreating(false);
    },
  });
  const updateTag = useMutation({
    mutationFn: ({ slug, body }: { slug: string; body: Parameters<typeof api.updateTag>[1] }) =>
      api.updateTag(slug, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      setEditing(null);
    },
  });
  const deleteTag = useMutation({
    mutationFn: (slug: string) => api.deleteTag(slug),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tags'] });
    },
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">// structure</p>
          <h1 className="text-2xl font-bold tracking-tight text-ink-1">Tags</h1>
          <p className="max-w-2xl text-[13px] text-ink-2">
            Managed label set. Items reference tags by slug; this table is the source of truth for
            label and color. Slugs are stable across renames, so renaming a tag doesn't break
            existing items.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => refetch()} className="btn-secondary focus-ring">
            Refresh
          </button>
          <button type="button" onClick={() => setCreating(true)} className="btn-primary focus-ring">
            New tag
          </button>
        </div>
      </header>

      {isLoading ? (
        <ul className="grid gap-3 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <li key={i} className="skeleton h-16" />
          ))}
        </ul>
      ) : null}

      {!isLoading && tags.length === 0 ? (
        <EmptyState
          title="No tags yet"
          body="Add tags here to give work items a shared label vocabulary. Items created without a tag stay tag-less until the operator assigns one."
          action={
            <button type="button" onClick={() => setCreating(true)} className="btn-primary focus-ring">
              Create the first tag
            </button>
          }
        />
      ) : null}

      <ul className="grid gap-3 md:grid-cols-3">
        {tags.map((t) => (
          <li
            key={t.slug}
            className="card group p-4 transition-all duration-200 ease-out-quint hover:border-border-default hover:shadow-card-lg"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={`inline-block h-2 w-2 rounded-full bg-status-${t.color}-500`}
                  />
                  <span className="truncate text-[13.5px] font-semibold text-ink-1">{t.label}</span>
                </div>
                <p className="font-mono text-[11px] text-ink-3">/{t.slug}</p>
                {t.description ? (
                  <p className="line-clamp-2 text-[11.5px] text-ink-2">{t.description}</p>
                ) : null}
              </div>
              <div className="shrink-0 space-y-1 text-right">
                <button
                  type="button"
                  onClick={() => setEditing(t)}
                  className="btn-ghost focus-ring text-[11px] text-ink-2"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm(`Delete tag "${t.label}"? Items will still reference the slug but show as unknown.`))
                      deleteTag.mutate(t.slug);
                  }}
                  disabled={deleteTag.isPending}
                  className="btn-ghost focus-ring text-[11px] text-status-blocked-600 disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {creating ? (
        <TagModal
          onClose={() => setCreating(false)}
          onSubmit={(body) => createTag.mutate(body)}
          isPending={createTag.isPending}
          error={createTag.error ? (createTag.error as Error).message : null}
        />
      ) : null}
      {editing ? (
        <TagModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSubmit={(body) => {
            updateTag.mutate({
              slug: editing.slug,
              body: { label: body.label, color: body.color, description: body.description ?? null },
            });
          }}
          isPending={updateTag.isPending}
          error={updateTag.error ? (updateTag.error as Error).message : null}
        />
      ) : null}
    </div>
  );
}

function TagModal({
  initial,
  onClose,
  onSubmit,
  isPending,
  error,
}: {
  initial?: TagTaxonomy;
  onClose: () => void;
  onSubmit: (body: CreateTagRequest) => void;
  isPending: boolean;
  error: string | null;
}) {
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [color, setColor] = useState<ProjectColor>(initial?.color ?? 'cyan');
  const [description, setDescription] = useState(initial?.description ?? '');

  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? 'Edit tag' : 'New tag'}
      size="md"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-secondary focus-ring">
            Cancel
          </button>
          <button
            type="button"
            disabled={isPending || !label || !slug}
            onClick={() => onSubmit({ slug, label, color, description: description || null })}
            className="btn-primary focus-ring disabled:opacity-50"
          >
            {isPending ? 'Saving…' : initial ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Label">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="field"
            placeholder="needs-review"
          />
        </Field>
        <Field label="Slug" hint="URL-safe; used in tag_slugs[]">
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
            className="field font-mono"
            placeholder="needs-review"
            disabled={!!initial}
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
        <Field label="Description">
          <textarea
            value={description ?? ''}
            onChange={(e) => setDescription(e.target.value)}
            className="field h-20"
            placeholder="When should an item carry this tag?"
          />
        </Field>
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
