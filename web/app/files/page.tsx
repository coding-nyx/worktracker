'use client';

import { useState, useRef, type ChangeEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { EmptyState } from '../../components/EmptyState';
import { Pill } from '../../components/Pill';
import { Modal } from '../../components/Modal';

/**
 * /files — Slice 11.
 *
 * Browse every file uploaded to the workspace. Click a row to
 * download. Click "Upload" to attach a new file (optionally
 * to a work item at upload time). Files are stored inline
 * base64 in the Firestore doc, capped at 1 MB per file.
 *
 * The list is filtered by item_id and mime prefix; mime
 * prefix "image/" shows only images, etc.
 */
export default function FilesPage() {
  const qc = useQueryClient();
  const [mimeFilter, setMimeFilter] = useState<string>('');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['files', mimeFilter],
    queryFn: () => api.listFiles({ mime_prefix: mimeFilter || undefined, limit: 200 }),
  });
  const files = data?.files ?? [];
  const [showUpload, setShowUpload] = useState(false);

  const totalBytes = files.reduce((acc, f) => acc + f.size_bytes, 0);

  const deleteFile = useMutation({
    mutationFn: (id: string) => api.deleteFile(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['files'] });
      qc.invalidateQueries({ queryKey: ['items'] });
    },
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">// attachments</p>
          <h1 className="text-2xl font-bold tracking-tight text-ink-1">Files</h1>
          <p className="max-w-2xl text-[13px] text-ink-2">
            Every file uploaded to the workspace. Stored inline base64 in
            <code className="rounded bg-bg-sunken px-1.5 py-0.5 text-ink-1">files/&#123;file_id&#125;</code>
            (≤1 MB per file, ≤10 MB per work item). Click a row to download.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => refetch()} className="btn-secondary focus-ring">
            Refresh
          </button>
          <button type="button" onClick={() => setShowUpload(true)} className="btn-primary focus-ring">
            Upload
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <label className="text-ink-3">Mime prefix:</label>
        <select
          value={mimeFilter}
          onChange={(e) => setMimeFilter(e.target.value)}
          className="field w-auto"
        >
          <option value="">All</option>
          <option value="image/">Images</option>
          <option value="application/pdf">PDF</option>
          <option value="text/">Text</option>
          <option value="application/json">JSON</option>
        </select>
        <span className="text-ink-4">·</span>
        <span className="text-ink-3">
          {files.length} files · {formatBytes(totalBytes)}
        </span>
      </div>

      {isLoading ? (
        <ul className="grid gap-3">
          {[0, 1, 2].map((i) => (
            <li key={i} className="skeleton h-16" />
          ))}
        </ul>
      ) : null}
      {error ? <p className="text-[13px] text-status-blocked-600">Failed to load files.</p> : null}

      {!isLoading && files.length === 0 ? (
        <EmptyState
          title="No files yet"
          body={
            mimeFilter
              ? `No files match the "${mimeFilter}" filter.`
              : 'Upload one to get started. You can also attach files when creating or editing a work item.'
          }
          action={
            <button type="button" onClick={() => setShowUpload(true)} className="btn-primary focus-ring">
              Upload the first file
            </button>
          }
        />
      ) : null}

      <ul className="grid gap-3">
        {files.map((f) => (
          <li
            key={f.file_id}
            className="card group flex items-center justify-between gap-3 p-4 transition-all hover:border-border-default hover:shadow-card-lg"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <a
                href={api.fileDownloadUrl(f.file_id)}
                download={f.name}
                className="focus-ring block truncate text-[14px] font-semibold text-ink-1 hover:underline"
              >
                {f.name}
              </a>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
                <Pill kind="backlog" dot={false} className="!ring-border-subtle !bg-bg-sunken !text-ink-2">
                  {f.content_type || 'application/octet-stream'}
                </Pill>
                <span>{formatBytes(f.size_bytes)}</span>
                <span aria-hidden>·</span>
                <span>
                  uploaded by{' '}
                  <span className="text-ink-2">{f.uploaded_by}</span>
                </span>
                {f.owner_item_id ? (
                  <>
                    <span aria-hidden>·</span>
                    <span>
                      attached to{' '}
                      <a
                        href={`/?item=${f.owner_item_id}`}
                        className="font-mono text-ink-2 hover:underline"
                      >
                        {f.owner_item_id.slice(0, 12)}…
                      </a>
                    </span>
                  </>
                ) : null}
                <span aria-hidden>·</span>
                <span>{new Date(f.uploaded_at).toLocaleString()}</span>
              </div>
            </div>
            <div className="shrink-0 flex items-center gap-1">
              <a
                href={api.fileDownloadUrl(f.file_id)}
                download={f.name}
                className="btn-ghost focus-ring text-[11.5px] text-ink-2"
              >
                Download
              </a>
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Delete "${f.name}"? The pointer will be removed from any work item it was attached to.`))
                    deleteFile.mutate(f.file_id);
                }}
                disabled={deleteFile.isPending}
                className="btn-ghost focus-ring text-[11.5px] text-status-blocked-600 disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>

      {showUpload ? <UploadModal onClose={() => setShowUpload(false)} /> : null}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function UploadModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [itemId, setItemId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('No file selected');
      const bytes = await file.arrayBuffer();
      // Server caps raw bytes at 1 MB.
      if (bytes.byteLength > 1_048_576) {
        throw new Error(`file exceeds 1 MB limit (got ${bytes.byteLength} bytes)`);
      }
      const b64 = arrayBufferToBase64(bytes);
      return api.uploadFileRaw({
        name: file.name,
        content_type: file.type || 'application/octet-stream',
        content_b64: b64,
        item_id: itemId.trim() || undefined,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['files'] });
      qc.invalidateQueries({ queryKey: ['items'] });
      onClose();
    },
    onError: (err) => setError((err as Error).message),
  });

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setError(null);
  }

  return (
    <Modal
      open
      onClose={() => {
        if (upload.isPending) return;
        onClose();
      }}
      title="Upload file"
      size="md"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-secondary focus-ring">
            Cancel
          </button>
          <button
            type="button"
            disabled={upload.isPending || !file}
            onClick={() => upload.mutate()}
            className="btn-primary focus-ring disabled:opacity-50"
          >
            {upload.isPending ? 'Uploading…' : 'Upload'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="File" hint="Max 1 MB. The bytes live inline in the Firestore doc.">
          <input
            ref={inputRef}
            type="file"
            onChange={onPick}
            className="block w-full cursor-pointer rounded-md border border-border-subtle bg-bg-sunken/40 text-[12.5px] text-ink-2 file:mr-3 file:rounded file:border-0 file:bg-brand-500/20 file:px-3 file:py-1.5 file:text-ink-1 hover:bg-bg-sunken/70"
          />
        </Field>
        {file ? (
          <p className="text-[12px] text-ink-3">
            selected: <span className="text-ink-2">{file.name}</span> ·{' '}
            {formatBytes(file.size)}
          </p>
        ) : null}
        <Field label="Attach to work item (optional)" hint="Paste an item id. Leave empty for a standalone file.">
          <input
            type="text"
            value={itemId}
            onChange={(e) => setItemId(e.target.value)}
            className="field font-mono"
            placeholder="01H..."
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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)) as number[],
    );
  }
  // btoa is available in the browser; for SSR (build time) it's
  // not — but this only runs in a click handler, so we're in the
  // browser. For Node test environments, fall back to Buffer.
  if (typeof btoa === 'function') return btoa(binary);
  // @ts-ignore — Node Buffer fallback
  return Buffer.from(binary, 'binary').toString('base64');
}
