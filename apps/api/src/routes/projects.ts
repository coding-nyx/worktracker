/**
 * Project routes — slice 10.
 *
 *   GET    /api/projects              list (all + archived filter)
 *   GET    /api/projects/:id          get one
 *   POST   /api/projects              create (admin)
 *   PATCH  /api/projects/:id          update (admin)
 *   DELETE /api/projects/:id          archive (soft; admin)
 *
 * Projects are top-level containers. They own Releases. Items
 * reference projects via `WorkItem.project_id`. The kanban filter
 * reads them to render the project picker chips.
 *
 * Slug is URL-safe and unique. We don't allow a soft-deleted project
 * to be re-created with the same slug; rename instead.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ulid, nowIso } from '../ids.js';
import { getDb } from '../firestore.js';
import { requireSource, requireAdmin } from '../auth.js';
import { InvalidInputError, NotFoundError } from '../errors.js';
import {
  PROJECT_COLORS,
  type CreateProjectRequest,
  type ListProjectsResponse,
  type Project,
  type UpdateProjectRequest,
} from '@worktracker/types';

const SlugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits, hyphen; must start with [a-z0-9]');

const CreateProjectSchema = z.object({
  slug: SlugSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  color: z.enum(PROJECT_COLORS).optional(),
  owner: z.string().min(1).max(120).nullable().optional(),
}) satisfies z.ZodType<CreateProjectRequest>;

const UpdateProjectSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  color: z.enum(PROJECT_COLORS).optional(),
  owner: z.string().min(1).max(120).nullable().optional(),
  archived: z.boolean().optional(),
}) satisfies z.ZodType<UpdateProjectRequest>;

const ListQuery = z.object({
  include_archived: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export async function projectsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/projects', { preHandler: requireSource }, async (req) => {
    const q = ListQuery.parse(req.query);
    let ref = getDb().collection('projects').orderBy('created_at', 'desc').limit(q.limit);
    if (!q.include_archived) ref = ref.where('archived', '==', false) as never;
    const snap = await ref.get();
    return { projects: snap.docs.map((d) => d.data() as Project) } satisfies ListProjectsResponse;
  });

  app.get('/api/projects/:id', { preHandler: requireSource }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const snap = await getDb().collection('projects').doc(id).get();
    if (!snap.exists) throw new NotFoundError(`project ${id} not found`);
    return { project: snap.data() as Project };
  });

  app.post('/api/projects', { preHandler: requireAdmin }, async (req, reply) => {
    const body = CreateProjectSchema.parse(req.body);
    const db = getDb();
    // Slugs must be unique across non-archived projects. Archived
    // projects keep their slug so a future restore doesn't fight
    // a new project's slug.
    const dup = await db
      .collection('projects')
      .where('slug', '==', body.slug)
      .where('archived', '==', false)
      .limit(1)
      .get();
    if (!dup.empty) {
      throw new InvalidInputError(`project slug "${body.slug}" already in use`);
    }
    const now = nowIso();
    const project: Project = {
      id: ulid(),
      slug: body.slug,
      name: body.name,
      description: body.description ?? null,
      color: body.color ?? 'cyan',
      owner: body.owner ?? null,
      archived: false,
      created_at: now,
      updated_at: now,
    };
    await db.collection('projects').doc(project.id).set(project);
    reply.code(201);
    return { project };
  });

  app.patch<{ Params: { id: string } }>(
    '/api/projects/:id',
    { preHandler: requireAdmin },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const body = UpdateProjectSchema.parse(req.body);
      const ref = getDb().collection('projects').doc(id);
      const snap = await ref.get();
      if (!snap.exists) throw new NotFoundError(`project ${id} not found`);
      const update: Record<string, unknown> = { updated_at: nowIso() };
      if (body.name !== undefined) update.name = body.name;
      if (body.description !== undefined) update.description = body.description;
      if (body.color !== undefined) update.color = body.color;
      if (body.owner !== undefined) update.owner = body.owner;
      if (body.archived !== undefined) update.archived = body.archived;
      await ref.update(update);
      const fresh = await ref.get();
      return { project: fresh.data() as Project };
    },
  );

  // Soft delete = archive. We never hard-delete a project because
  // existing work items still reference its id; archiving keeps
  // the kanban filter clean without breaking read-back.
  app.delete<{ Params: { id: string } }>(
    '/api/projects/:id',
    { preHandler: requireAdmin },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const ref = getDb().collection('projects').doc(id);
      const snap = await ref.get();
      if (!snap.exists) throw new NotFoundError(`project ${id} not found`);
      await ref.update({ archived: true, updated_at: nowIso() });
      return { id, archived: true };
    },
  );
}
