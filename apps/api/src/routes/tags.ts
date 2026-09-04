/**
 * Tag taxonomy routes — slice 10.
 *
 *   GET    /api/tags                  list (filter archived)
 *   GET    /api/tags/:slug            get one
 *   POST   /api/tags                  create (admin)
 *   PATCH  /api/tags/:slug            update (admin)
 *   DELETE /api/tags/:slug            archive (soft; admin)
 *
 * Tags are managed labels. The slug is the doc id, so lookups
 * are O(1) and the kanban filter can resolve a `WorkItem.tag_slugs`
 * list to label+color in one batched `getAll` call.
 *
 * Slugs are stable across renames (the doc id doesn't change when
 * the label changes), so `WorkItem.tag_slugs` stays valid even if
 * the operator renames a tag.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nowIso } from '../ids.js';
import { getDb } from '../firestore.js';
import { requireSource, requireAdmin } from '../auth.js';
import { NotFoundError } from '../errors.js';
import {
  PROJECT_COLORS,
  type CreateTagRequest,
  type ListTagsResponse,
  type TagTaxonomy,
  type UpdateTagRequest,
} from '@worktracker/types';

const SlugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits, hyphen; must start with [a-z0-9]');

const CreateTagSchema = z.object({
  slug: SlugSchema,
  label: z.string().min(1).max(64),
  color: z.enum(PROJECT_COLORS).optional(),
  description: z.string().max(500).nullable().optional(),
}) satisfies z.ZodType<CreateTagRequest>;

const UpdateTagSchema = z.object({
  label: z.string().min(1).max(64).optional(),
  color: z.enum(PROJECT_COLORS).optional(),
  description: z.string().max(500).nullable().optional(),
}) satisfies z.ZodType<UpdateTagRequest>;

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export async function tagsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tags', { preHandler: requireSource }, async (req) => {
    const q = ListQuery.parse(req.query);
    const snap = await getDb()
      .collection('tag_taxonomy')
      .orderBy('label', 'asc')
      .limit(q.limit)
      .get();
    return { tags: snap.docs.map((d) => d.data() as TagTaxonomy) } satisfies ListTagsResponse;
  });

  app.get('/api/tags/:slug', { preHandler: requireSource }, async (req) => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const snap = await getDb().collection('tag_taxonomy').doc(slug).get();
    if (!snap.exists) throw new NotFoundError(`tag ${slug} not found`);
    return { tag: snap.data() as TagTaxonomy };
  });

  app.post('/api/tags', { preHandler: requireAdmin }, async (req, reply) => {
    const body = CreateTagSchema.parse(req.body);
    const ref = getDb().collection('tag_taxonomy').doc(body.slug);
    const existing = await ref.get();
    if (existing.exists) throw new NotFoundError(`tag ${body.slug} already exists`);
    const now = nowIso();
    const tag: TagTaxonomy = {
      slug: body.slug,
      label: body.label,
      color: body.color ?? 'cyan',
      description: body.description ?? null,
      created_at: now,
      updated_at: now,
    };
    await ref.set(tag);
    reply.code(201);
    return { tag };
  });

  app.patch<{ Params: { slug: string } }>(
    '/api/tags/:slug',
    { preHandler: requireAdmin },
    async (req) => {
      const { slug } = z.object({ slug: z.string() }).parse(req.params);
      const body = UpdateTagSchema.parse(req.body);
      const ref = getDb().collection('tag_taxonomy').doc(slug);
      const snap = await ref.get();
      if (!snap.exists) throw new NotFoundError(`tag ${slug} not found`);
      const update: Record<string, unknown> = { updated_at: nowIso() };
      if (body.label !== undefined) update.label = body.label;
      if (body.color !== undefined) update.color = body.color;
      if (body.description !== undefined) update.description = body.description;
      await ref.update(update);
      const fresh = await ref.get();
      return { tag: fresh.data() as TagTaxonomy };
    },
  );

  // Soft delete: delete the doc but keep slug referenceable from
  // existing work items. The kanban filter renders legacy slugs
  // as "unknown:<slug>" so the operator can clean them up later.
  // A future "vacuum" job can clear dead slugs from `tag_slugs[]`.
  app.delete<{ Params: { slug: string } }>(
    '/api/tags/:slug',
    { preHandler: requireAdmin },
    async (req) => {
      const { slug } = z.object({ slug: z.string() }).parse(req.params);
      const ref = getDb().collection('tag_taxonomy').doc(slug);
      const snap = await ref.get();
      if (!snap.exists) throw new NotFoundError(`tag ${slug} not found`);
      await ref.delete();
      return { slug, deleted: true };
    },
  );
}
