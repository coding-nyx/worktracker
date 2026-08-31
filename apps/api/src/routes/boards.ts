/**
 * REST routes for boards. Every authenticated user can read; only
 * admin can create / update / delete. A board is just a saved
 * kanban view (name, columns, kind filter, default flag). The
 * actual work items live in `work_items`; the board is the lens.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  Board,
  BoardColumn,
  CreateBoardRequest,
  ListBoardsResponse,
  UpdateBoardRequest,
  WorkItemKind,
} from '@worktracker/types';
import { getDb } from '../firestore.js';
import { requireAdmin, requireSource } from '../auth.js';
import { NotFoundError, InvalidInputError } from '../errors.js';
import { ulid, nowIso } from '../ids.js';

const KINDS = ['task', 'ticket', 'decision', 'review'] as const;

const BoardColumnSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(64),
  statuses: z.array(z.string().min(1).max(64)).min(1),
  kinds: z.array(z.enum(KINDS)).optional(),
});

const BoardId = z.string().min(1).max(64);

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  kinds: z.array(z.enum(KINDS)).optional(),
  columns: z.array(BoardColumnSchema).min(1).max(20),
  is_default: z.boolean().optional(),
}) satisfies z.ZodType<CreateBoardRequest>;

const UpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  kinds: z.array(z.enum(KINDS)).optional(),
  columns: z.array(BoardColumnSchema).min(1).max(20).optional(),
  is_default: z.boolean().optional(),
}) satisfies z.ZodType<UpdateBoardRequest>;

export async function boardsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/boards', { preHandler: requireSource }, async () => {
    const snap = await getDb().collection('boards').orderBy('name').get();
    const boards = snap.docs.map((d) => d.data() as Board);
    const response: ListBoardsResponse = { boards };
    return response;
  });

  app.get('/api/boards/:id', { preHandler: requireSource }, async (req) => {
    const { id } = z.object({ id: BoardId }).parse(req.params);
    const doc = await getDb().collection('boards').doc(id).get();
    if (!doc.exists) throw new NotFoundError(`board ${id} not found`);
    return { board: doc.data() as Board };
  });

  app.post('/api/boards', { preHandler: requireAdmin }, async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    if (body.is_default) {
      await unsetExistingDefaults();
    }
    const now = nowIso();
    const board: Board = {
      id: ulid(),
      name: body.name,
      ...(body.description ? { description: body.description } : {}),
      ...(body.kinds ? { kinds: body.kinds } : {}),
      columns: body.columns,
      is_default: body.is_default ?? false,
      created_at: now,
      updated_at: now,
    };
    await getDb().collection('boards').doc(board.id).set(board);
    reply.code(201);
    return { board };
  });

  app.patch('/api/boards/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = z.object({ id: BoardId }).parse(req.params);
    const body = UpdateSchema.parse(req.body);
    const ref = getDb().collection('boards').doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundError(`board ${id} not found`);
    const current = snap.data() as Board;
    if (body.is_default && !current.is_default) {
      await unsetExistingDefaults();
    }
    const next: Board = {
      ...current,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.kinds !== undefined ? { kinds: body.kinds } : {}),
      ...(body.columns !== undefined ? { columns: body.columns } : {}),
      ...(body.is_default !== undefined ? { is_default: body.is_default } : {}),
      updated_at: nowIso(),
    };
    await ref.set(next);
    return { board: next };
  });

  app.delete('/api/boards/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = z.object({ id: BoardId }).parse(req.params);
    const ref = getDb().collection('boards').doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundError(`board ${id} not found`);
    const board = snap.data() as Board;
    if (board.is_default) {
      throw new InvalidInputError(
        `cannot delete the default board (${id}); set another board as default first`,
      );
    }
    await ref.delete();
    return { id, deleted: true };
  });
}

async function unsetExistingDefaults(): Promise<void> {
  const snap = await getDb()
    .collection('boards')
    .where('is_default', '==', true)
    .get();
  const batch = getDb().batch();
  for (const doc of snap.docs) {
    batch.update(doc.ref, { is_default: false, updated_at: nowIso() });
  }
  if (snap.docs.length > 0) await batch.commit();
}
