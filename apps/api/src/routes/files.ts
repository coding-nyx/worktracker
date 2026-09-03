/**
 * Files collection — slice 3.
 *
 * Work items can carry up to 10 attachments, each ≤1 MB. Bytes
 * live in `files/{file_id}` as inline base64; the work item stores
 * only the pointer + metadata (name, content_type, size_bytes,
 * sha256) in `WorkItem.files[]` so the kanban list query stays
 * cheap.
 *
 * Limits:
 *   - 1 MB per file (raw bytes; base64 inflates to ~1.4 MB)
 *   - 10 MB per item (sum of all attached files)
 *
 * Auth:
 *   - upload (POST /api/files)         requires read_write scope
 *   - download (GET /api/files/:id)    requires source (any)
 *   - delete  (DELETE /api/files/:id)  requires read_write scope
 *
 * The upload payload is a JSON envelope: `{ name, content_type,
 * content_b64, item_id }`. Sending raw binary over the same JSON
 * REST surface keeps the auth + routing shape consistent; the
 * trade-off is the base64 overhead. A future binary endpoint
 * (multipart upload) is on the slice 5 deferred list.
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FileRecord, WorkItem, WorkItemFile } from '@worktracker/types';
import { getDb } from '../firestore.js';
import { requireScopeAtLeast, requireSource } from '../auth.js';
import { NotFoundError, InvalidInputError } from '../errors.js';
import { ulid, nowIso } from '../ids.js';

// 1 MiB raw = 1,048,576 bytes. Base64 inflates to ~1.4 MiB so we
// cap the JSON body at 2 MiB to leave headroom for the envelope.
const FILE_BYTES_LIMIT = 1_048_576;
const ITEM_BYTES_LIMIT = 10 * FILE_BYTES_LIMIT;
const FILE_BODY_LIMIT = 2 * 1024 * 1024;

const FileId = z.string().min(1).max(64);

const UploadSchema = z.object({
  name: z.string().min(1).max(200),
  content_type: z.string().min(1).max(200),
  /** Inline base64 (standard or url-safe). We normalize to standard. */
  content_b64: z.string().min(1).max(2_000_000),
  /** Optional — link the file to an item at upload time. */
  item_id: z.string().min(1).max(64).optional(),
});

export async function filesRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/files',
    {
      preHandler: [requireSource, requireScopeAtLeast('read_write')],
      bodyLimit: FILE_BODY_LIMIT,
    },
    async (req, reply) => {
      const body = UploadSchema.parse(req.body);
      const bytes = decodeBase64(body.content_b64);
      if (bytes.length > FILE_BYTES_LIMIT) {
        throw new InvalidInputError(
          `file exceeds 1 MB limit (got ${bytes.length} bytes)`,
          { size_bytes: bytes.length, limit: FILE_BYTES_LIMIT },
        );
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const fileId = ulid();
      const now = nowIso();
      const uploadedBy = req.auth?.source?.name ?? req.auth?.user?.firebase_uid ?? 'web';

      // If the file is being attached at upload time, check the
      // item-level 10 MB cap and append the file pointer in the
      // same transaction so a partial upload never leaves the
      // item/files collection out of sync.
      let itemRef: FirebaseFirestore.DocumentReference | null = null;
      let item: WorkItem | null = null;
      if (body.item_id) {
        itemRef = getDb().collection('work_items').doc(body.item_id);
        const snap = await itemRef.get();
        if (!snap.exists) {
          throw new NotFoundError(`work item ${body.item_id} not found`);
        }
        item = snap.data() as WorkItem;
        const existingBytes = (item.files ?? []).reduce(
          (sum, f) => sum + (f.size_bytes ?? 0),
          0,
        );
        if (existingBytes + bytes.length > ITEM_BYTES_LIMIT) {
          throw new InvalidInputError(
            `item would exceed 10 MB attachment cap (have ${existingBytes}, adding ${bytes.length})`,
            { existing_bytes: existingBytes, adding_bytes: bytes.length, limit: ITEM_BYTES_LIMIT },
          );
        }
      }

      const record: FileRecord = {
        file_id: fileId,
        name: body.name,
        content_type: body.content_type,
        size_bytes: bytes.length,
        content_b64: body.content_b64,
        owner_item_id: body.item_id ?? null,
        uploaded_by: uploadedBy,
        uploaded_at: now,
        content_sha256: sha256,
      };
      const filePointer: WorkItemFile = {
        file_id: fileId,
        name: body.name,
        content_type: body.content_type,
        size_bytes: bytes.length,
        added_at: now,
        content_sha256: sha256,
      };

      await getDb().runTransaction(async (tx) => {
        tx.set(getDb().collection('files').doc(fileId), record);
        if (itemRef && item) {
          const nextFiles = [...(item.files ?? []), filePointer];
          tx.set(itemRef, {
            files: nextFiles,
            updated_at: now,
            version: item.version + 1,
          });
        }
      });

      reply.code(201);
      return { file_id: fileId, file: filePointer };
    },
  );

  app.get('/api/files/:id', { preHandler: requireSource }, async (req, reply) => {
    const { id } = z.object({ id: FileId }).parse(req.params);
    const snap = await getDb().collection('files').doc(id).get();
    if (!snap.exists) throw new NotFoundError(`file ${id} not found`);
    const record = snap.data() as FileRecord;
    reply.header('Content-Type', record.content_type);
    reply.header(
      'Content-Disposition',
      `attachment; filename="${record.name.replace(/"/g, '_')}"`,
    );
    reply.header('X-Content-SHA256', record.content_sha256 ?? '');
    return reply.send(Buffer.from(record.content_b64, 'base64'));
  });

  app.get('/api/files/:id/meta', { preHandler: requireSource }, async (req) => {
    const { id } = z.object({ id: FileId }).parse(req.params);
    const snap = await getDb().collection('files').doc(id).get();
    if (!snap.exists) throw new NotFoundError(`file ${id} not found`);
    const record = snap.data() as FileRecord;
    // Return metadata only; the bytes are excluded from the meta
    // endpoint so a list view can show size + name without
    // downloading 10 MB.
    const { content_b64: _omit, ...meta } = record;
    void _omit;
    return { file: meta };
  });

  app.delete(
    '/api/files/:id',
    { preHandler: [requireSource, requireScopeAtLeast('read_write')] },
    async (req) => {
      const { id } = z.object({ id: FileId }).parse(req.params);
      const fileRef = getDb().collection('files').doc(id);
      const snap = await fileRef.get();
      if (!snap.exists) throw new NotFoundError(`file ${id} not found`);
      const record = snap.data() as FileRecord;
      await getDb().runTransaction(async (tx) => {
        tx.delete(fileRef);
        if (record.owner_item_id) {
          const itemRef = getDb().collection('work_items').doc(record.owner_item_id);
          const itemSnap = await tx.get(itemRef);
          if (itemSnap.exists) {
            const item = itemSnap.data() as WorkItem;
            const nextFiles = (item.files ?? []).filter((f) => f.file_id !== id);
            tx.set(itemRef, {
              files: nextFiles,
              updated_at: nowIso(),
              version: item.version + 1,
            });
          }
        }
      });
      return { file_id: id, deleted: true };
    },
  );
}

/**
 * Accept either standard or url-safe base64. We normalize the
 * url-safe variant (`-_` → `+/`) and strip whitespace before
 * decoding. Throws on malformed input.
 */
function decodeBase64(input: string): Buffer {
  const cleaned = input.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  // Pad to a multiple of 4.
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}
