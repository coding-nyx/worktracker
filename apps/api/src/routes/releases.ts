/**
 * Release routes — slice 10.
 *
 *   GET    /api/releases              list (filter by project_id, status)
 *   GET    /api/releases/:id          get one
 *   POST   /api/releases              create (admin)
 *   PATCH  /api/releases/:id          update (admin)
 *   DELETE /api/releases/:id          archive (soft; admin)
 *
 * A Release is a versioned batch inside a Project. The
 * `WorkItem.release_id` is optional — an item can live in a
 * Project without targeting a specific release. When set, the
 * server enforces that `release.project_id === item.project_id`.
 *
 * Releases are listed newest-first by `created_at` so the admin
 * UI can show the most recent release at the top.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ulid, nowIso } from '../ids.js';
import { getDb } from '../firestore.js';
import { requireSource, requireAdmin } from '../auth.js';
import { NotFoundError } from '../errors.js';
import {
  RELEASE_STATUSES,
  type CreateReleaseRequest,
  type ListReleasesResponse,
  type Release,
  type UpdateReleaseRequest,
} from '@worktracker/types';

const CreateReleaseSchema = z.object({
  project_id: z.string().min(1),
  version: z.string().min(1).max(64),
  status: z.enum(RELEASE_STATUSES).optional(),
  release_at: z.string().min(1).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
}) satisfies z.ZodType<CreateReleaseRequest>;

const UpdateReleaseSchema = z.object({
  version: z.string().min(1).max(64).optional(),
  status: z.enum(RELEASE_STATUSES).optional(),
  release_at: z.string().min(1).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
}) satisfies z.ZodType<UpdateReleaseRequest>;

const ListQuery = z.object({
  project_id: z.string().min(1).optional(),
  status: z.enum(RELEASE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export async function releasesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/releases', { preHandler: requireSource }, async (req) => {
    const q = ListQuery.parse(req.query);
    let ref = getDb().collection('releases').orderBy('created_at', 'desc').limit(q.limit);
    if (q.project_id) ref = ref.where('project_id', '==', q.project_id) as never;
    if (q.status) ref = ref.where('status', '==', q.status) as never;
    const snap = await ref.get();
    return { releases: snap.docs.map((d) => d.data() as Release) } satisfies ListReleasesResponse;
  });

  app.get('/api/releases/:id', { preHandler: requireSource }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const snap = await getDb().collection('releases').doc(id).get();
    if (!snap.exists) throw new NotFoundError(`release ${id} not found`);
    return { release: snap.data() as Release };
  });

  app.post('/api/releases', { preHandler: requireAdmin }, async (req, reply) => {
    const body = CreateReleaseSchema.parse(req.body);
    const db = getDb();
    // Verify project exists; prevents orphan releases.
    const project = await db.collection('projects').doc(body.project_id).get();
    if (!project.exists) throw new NotFoundError(`project ${body.project_id} not found`);
    const now = nowIso();
    const release: Release = {
      id: ulid(),
      project_id: body.project_id,
      version: body.version,
      status: body.status ?? 'planned',
      release_at: body.release_at ?? null,
      notes: body.notes ?? null,
      created_at: now,
      updated_at: now,
    };
    await db.collection('releases').doc(release.id).set(release);
    reply.code(201);
    return { release };
  });

  app.patch<{ Params: { id: string } }>(
    '/api/releases/:id',
    { preHandler: requireAdmin },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const body = UpdateReleaseSchema.parse(req.body);
      const ref = getDb().collection('releases').doc(id);
      const snap = await ref.get();
      if (!snap.exists) throw new NotFoundError(`release ${id} not found`);
      const update: Record<string, unknown> = { updated_at: nowIso() };
      if (body.version !== undefined) update.version = body.version;
      if (body.status !== undefined) update.status = body.status;
      if (body.release_at !== undefined) update.release_at = body.release_at;
      if (body.notes !== undefined) update.notes = body.notes;
      await ref.update(update);
      const fresh = await ref.get();
      return { release: fresh.data() as Release };
    },
  );

  // Soft delete: mark status='archived'. We never hard-delete a
  // release because items still reference its id; archiving keeps
  // the picker clean without breaking read-back.
  app.delete<{ Params: { id: string } }>(
    '/api/releases/:id',
    { preHandler: requireAdmin },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const ref = getDb().collection('releases').doc(id);
      const snap = await ref.get();
      if (!snap.exists) throw new NotFoundError(`release ${id} not found`);
      await ref.update({ status: 'archived', updated_at: nowIso() });
      return { id, archived: true };
    },
  );
}
