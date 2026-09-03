/**
 * Client routes — slice 2. Replaces the old `sources.ts` and
 * `api-tokens.ts` with a single REST surface for `clients/{name}`.
 *
 *   GET    /api/clients                list
 *   GET    /api/clients/:name          get one
 *   POST   /api/clients                register (admin)
 *   PATCH  /api/clients/:name          update / pause / resume
 *   DELETE /api/clients/:name          revoke (kind: 'user' soft; kind: 'agent' disabled)
 *   POST   /api/clients/:name/rotate   rotate bearer (admin)
 *   POST   /api/clients/mint           mint a kind: 'user' client (admin)
 *   GET    /api/clients/introspect     "who am I" (any auth)
 *
 * Wrecking ball: no `/api/sources` or `/api/auth/tokens` aliases.
 * The old routes are gone. Existing clients in the `sources`
 * collection with `kind: 'agent'` keep working unchanged; the
 * seed (slice 2 follow-up) re-registers them with explicit scope.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ulid, nowIso } from '../ids.js';
import { getDb } from '../firestore.js';
import { requireSource, requireAdmin, hashApiKey, rotateUserClient, mintUserClient } from '../auth.js';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../errors.js';
import {
  API_TOKEN_SCOPES,
  type ApiTokenScope,
  type Client,
  type ClientManifest,
  type CreateClientRequest,
  type CreateClientResponse,
  type IntrospectClientResponse,
  type ListClientsResponse,
  type RotateClientResponse,
} from '@worktracker/types';
import { randomBytes } from 'node:crypto';

const ManifestSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/, 'lowercase letters, digits, underscore, hyphen only'),
  display_name: z.string().min(1).max(200),
  kind: z.enum(['agent', 'user']),
  capabilities: z.array(z.string()).min(0),
  webhook_url: z.string().url().nullable().optional(),
  icon: z.string().nullable().optional(),
  version: z.string().min(1),
});

const CreateClientSchema = z.object({
  manifest: ManifestSchema,
  /** Optional initial bearer; if absent for `kind: 'agent'`, one is generated. Ignored for `kind: 'user'` (bearer is generated and returned). */
  bearer: z.string().min(16).max(256).optional(),
  /** Scope defaults to `read_write`. Admin callers can request `admin`. */
  scope: z.enum(API_TOKEN_SCOPES).default('read_write'),
  /** Required for `kind: 'user'`. */
  owner_uid: z.string().optional(),
  owner_email: z.string().email().optional(),
});

const PatchClientSchema = z.object({
  enabled: z.boolean().optional(),
  scope: z.enum(API_TOKEN_SCOPES).optional(),
  display_name: z.string().min(1).max(200).optional(),
});

const MintSchema = z.object({
  name: z.string().min(1).max(120),
  scope: z.enum(API_TOKEN_SCOPES).default('read_write'),
  owner_uid: z.string().min(1),
  owner_email: z.string().email(),
});

function requireUser(req: FastifyRequest): asserts req is FastifyRequest & {
  auth: { kind: 'user'; user: { firebase_uid: string; email: string } };
} {
  if (req.auth?.kind !== 'user' || !req.auth.user) {
    throw new UnauthorizedError('sign in to manage personal clients');
  }
}

export async function clientsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/clients', { preHandler: requireSource }, async () => {
    const snap = await getDb().collection('sources').get();
    return { clients: snap.docs.map((d) => d.data() as Client) } satisfies ListClientsResponse;
  });

  app.get('/api/clients/:name', { preHandler: requireSource }, async (req) => {
    const { name } = z.object({ name: z.string() }).parse(req.params);
    const doc = await getDb().collection('sources').doc(name).get();
    if (!doc.exists) throw new NotFoundError(`client ${name} not found`);
    return { client: doc.data() as Client };
  });

  app.get('/api/clients/introspect', { preHandler: requireSource }, async (req) => {
    if (!req.auth) throw new UnauthorizedError('not authenticated');
    const scope: ApiTokenScope =
      req.auth.scope ??
      (req.auth.kind === 'admin' ? 'admin' : 'read_write');
    const tools = await introspectTools(req.auth);
    const source = req.auth.source;
    const response: IntrospectClientResponse = {
      name: source?.name ?? 'operator',
      kind: source?.kind ?? 'user',
      scope,
      owner_uid: source?.owner_uid ?? null,
      last_used_at: source?.last_used_at ?? null,
      capabilities: source?.capabilities ?? [],
      server_version: '1.0.0',
      visible_tools: tools,
    };
    return response;
  });

  app.post('/api/clients', { preHandler: requireAdmin }, async (req, reply) => {
    const body = CreateClientSchema.parse(req.body) satisfies CreateClientRequest;
    const manifest: ClientManifest = body.manifest;
    const scope: ApiTokenScope = body.scope;
    const now = nowIso();

    if (manifest.kind === 'user') {
      // A user-kind client must be minted via /api/clients/mint so
      // the bearer can be returned exactly once. This route only
      // registers agent-kind clients.
      throw new ForbiddenError('use POST /api/clients/mint for kind: user clients');
    }

    if (scope === 'admin' && !req.auth?.user?.is_admin) {
      throw new ForbiddenError('only admins can register admin-scope clients');
    }

    const plaintext = body.bearer ?? randomBytes(24).toString('base64url');
    const hash = await hashApiKey(plaintext);
    const record: Client = {
      name: manifest.name,
      display_name: manifest.display_name,
      kind: 'agent',
      scope,
      owner_uid: null,
      manifest,
      capabilities: manifest.capabilities,
      webhook_secret: null,
      enabled: true,
      created_at: now,
      updated_at: now,
      last_used_at: null,
      rotated_at: null,
      revoked_at: null,
      api_key_hash: hash,
    };
    await getDb().collection('sources').doc(manifest.name).set(record);
    const response: CreateClientResponse = { client: record, bearer: plaintext };
    reply.code(201);
    return response;
  });

  app.patch<{ Params: { name: string } }>(
    '/api/clients/:name',
    { preHandler: requireAdmin },
    async (req) => {
      const { name } = z.object({ name: z.string() }).parse(req.params);
      const body = PatchClientSchema.parse(req.body);
      const ref = getDb().collection('sources').doc(name);
      const update: Record<string, unknown> = { updated_at: nowIso() };
      if (body.enabled !== undefined) update.enabled = body.enabled;
      if (body.scope !== undefined) update.scope = body.scope;
      if (body.display_name !== undefined) update.display_name = body.display_name;
      await ref.update(update);
      const fresh = await ref.get();
      return { client: fresh.data() as Client };
    },
  );

  app.post<{ Params: { name: string } }>(
    '/api/clients/:name/rotate',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { name } = z.object({ name: z.string() }).parse(req.params);
      const ref = getDb().collection('sources').doc(name);
      const snap = await ref.get();
      if (!snap.exists) throw new NotFoundError(`client ${name} not found`);
      const old = snap.data() as Client;
      if (old.kind !== 'user') {
        throw new ForbiddenError('rotate is only for kind: user clients; kind: agent uses the legacy <name>.<key> shape');
      }
      const mint = await rotateUserClient({
        name: old.display_name,
        owner_uid: old.owner_uid ?? '',
        owner_email: old.owner_email ?? '',
        scope: old.scope,
        old_bearer_id: old.bearer_id ?? name,
      });
      const response: RotateClientResponse = { client: mint.record, bearer: mint.bearer };
      reply.code(200);
      return response;
    },
  );

  app.delete<{ Params: { name: string } }>(
    '/api/clients/:name',
    { preHandler: requireAdmin },
    async (req) => {
      const { name } = z.object({ name: z.string() }).parse(req.params);
      const ref = getDb().collection('sources').doc(name);
      const snap = await ref.get();
      if (!snap.exists) throw new NotFoundError(`client ${name} not found`);
      const data = snap.data() as Client;
      if (data.kind === 'user') {
        // Soft delete: mark revoked; the bearer stops resolving.
        await ref.set({ revoked_at: nowIso(), updated_at: nowIso() }, { merge: true });
        return { name, revoked: true };
      }
      // For agent clients, soft-disable. The bearer still resolves
      // to a doc but `requireSource` rejects via `enabled: false`.
      await ref.set({ enabled: false, updated_at: nowIso() }, { merge: true });
      return { name, disabled: true };
    },
  );

  app.post('/api/clients/mint', { preHandler: requireAdmin }, async (req, reply) => {
    requireUser(req);
    const body = MintSchema.parse(req.body);
    if (body.scope === 'admin' && !req.auth.user.is_admin) {
      throw new ForbiddenError('only admins can mint admin-scope clients');
    }
    const mint = await mintUserClient({
      name: body.name,
      owner_uid: body.owner_uid,
      owner_email: body.owner_email,
      scope: body.scope,
    });
    // The Client record is the doc; expose the bearer once.
    const response: CreateClientResponse = { client: mint.record, bearer: mint.bearer };
    reply.code(201);
    return response;
  });
}

/**
 * Compute the visible tools for the calling client. Mirrors the
 * filter in `mcp.ts` (slice 1): the bearer's effective scope
 * determines which tools they see.
 */
async function introspectTools(auth: NonNullable<FastifyRequest['auth']>): Promise<string[]> {
  // Lazy import to avoid a circular dep at module load. Slice 4:
  // the registry replaces the old inline `TOOLS` array; the
  // visible_tools set is the same shape the MCP `tools/list`
  // returns, so a client can render its own palette from
  // `/api/clients/introspect` without making a separate call.
  const { listToolsForScope } = await import('../mcp-tools.js');
  const scope: ApiTokenScope = auth.scope ?? (auth.kind === 'admin' ? 'admin' : 'read_write');
  return listToolsForScope(scope).map((t) => t.name);
}
