/**
 * Connector routes — slice 2. Admin-only.
 *
 *   GET    /api/connectors              list
 *   GET    /api/connectors/:name        get one
 *   POST   /api/connectors              register
 *   PATCH  /api/connectors/:name        update config / pause / resume
 *   POST   /api/connectors/:name/test   run the impl's test op
 *
 * Hermes will be the first connector. Other connectors (OpenClaw
 * bridge, GitHub mirror) follow the same pattern.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nowIso } from '../ids.js';
import { getDb } from '../firestore.js';
import { requireSource, requireAdmin } from '../auth.js';
import { NotFoundError } from '../errors.js';
import type { Connector, ListConnectorsResponse } from '@worktracker/types';
import { findProtocol, renderEndpoint } from '../protocols.js';

const PatchSchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  protocol: z.string().optional(),
});

const RegisterSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
  kind: z.enum(['mirror', 'webhook-in', 'webhook-out', 'bridge']),
  protocol: z.string().min(1),
  config: z.record(z.unknown()).default({}),
  enabled: z.boolean().default(true),
});

export async function connectorsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/connectors', { preHandler: requireAdmin }, async () => {
    const snap = await getDb().collection('connectors').get();
    return { connectors: snap.docs.map((d) => d.data() as Connector) } satisfies ListConnectorsResponse;
  });

  app.get('/api/connectors/:name', { preHandler: requireAdmin }, async (req) => {
    const { name } = z.object({ name: z.string() }).parse(req.params);
    const doc = await getDb().collection('connectors').doc(name).get();
    if (!doc.exists) throw new NotFoundError(`connector ${name} not found`);
    return { connector: doc.data() as Connector };
  });

  app.post('/api/connectors', { preHandler: requireAdmin }, async (req, reply) => {
    const body = RegisterSchema.parse(req.body);
    const now = nowIso();
    const record: Connector = {
      name: body.name,
      kind: body.kind,
      protocol: body.protocol,
      config: body.config,
      enabled: body.enabled,
      last_run_at: null,
      last_status: null,
      last_error: null,
      created_at: now,
      updated_at: now,
    };
    await getDb().collection('connectors').doc(body.name).set(record);
    reply.code(201);
    return { connector: record };
  });

  app.patch<{ Params: { name: string } }>(
    '/api/connectors/:name',
    { preHandler: requireAdmin },
    async (req) => {
      const { name } = z.object({ name: z.string() }).parse(req.params);
      const body = PatchSchema.parse(req.body);
      const ref = getDb().collection('connectors').doc(name);
      const update: Record<string, unknown> = { updated_at: nowIso() };
      if (body.enabled !== undefined) update.enabled = body.enabled;
      if (body.config !== undefined) update.config = body.config;
      if (body.protocol !== undefined) update.protocol = body.protocol;
      await ref.update(update);
      const fresh = await ref.get();
      return { connector: fresh.data() as Connector };
    },
  );

  app.post<{ Params: { name: string } }>(
    '/api/connectors/:name/test',
    { preHandler: requireAdmin },
    async (req) => {
      const { name } = z.object({ name: z.string() }).parse(req.params);
      const doc = await getDb().collection('connectors').doc(name).get();
      if (!doc.exists) throw new NotFoundError(`connector ${name} not found`);
      const connector = doc.data() as Connector;
      // Slice 2 follow-up: dispatch to the registered impl.
      // For now, mark the test attempt and return a structured
      // "not yet implemented" response so the admin UI can
      // surface the "test" button without a hard error.
      await getDb()
        .collection('connectors')
        .doc(name)
        .set(
          {
            last_run_at: nowIso(),
            last_status: 'ok',
            last_error: null,
            updated_at: nowIso(),
          },
          { merge: true },
        );
      return {
        ok: true,
        connector: { ...connector, last_run_at: nowIso(), last_status: 'ok' as const },
        // The actual test op is a slice 2 follow-up; surface a
        // marker so the admin UI can render the "not wired yet"
        // state honestly.
        note: 'connector test op not yet implemented; this is a placeholder liveness check',
      };
    },
  );

  /**
   * Slice 6: "invite" endpoint. Returns the install config the
   * user pastes into their agent's MCP settings, plus a freshly
   * minted `kind: user` client bearer. The wizard (slice 7)
   * uses this; it's the API surface for the "issue me a token
   * I can plug into Claude Code" flow.
   */
  app.post<{ Params: { name: string } }>(
    '/api/connectors/:name/invite',
    { preHandler: requireAdmin },
    async (req) => {
      const { name } = z.object({ name: z.string() }).parse(req.params);
      const module = findProtocol(name);
      if (!module) {
        throw new NotFoundError(`unknown protocol module: ${name}`);
      }
      const owner = req.auth?.user;
      if (!owner) {
        throw new NotFoundError('invite requires a signed-in admin');
      }
      const { mintUserClient } = await import('../auth.js');
      const mint = await mintUserClient({
        name: `${name}-${Date.now().toString(36)}`,
        owner_uid: owner.firebase_uid,
        owner_email: owner.email,
        scope: 'read_write',
      });
      // The server URL: the wizard renders it into the
      // endpoint_template at render time, but for this endpoint
      // we don't have the URL on the server (Cloud Run gives
      // us the request URL via `req.headers.host`). Use that
      // and let the wizard's client do the final stringification
      // if it wants.
      const host = req.headers.host ?? 'worktracker-nyx.web.app';
      const proto = req.headers['x-forwarded-proto'] ?? 'https';
      const url = `${proto}://${host}`;
      return {
        protocol: module,
        bearer: mint.bearer,
        endpoint: renderEndpoint(module.endpoint_template, url, mint.bearer),
        verify_command: renderEndpoint(module.verify_command, url, mint.bearer),
        client: mint.record,
      };
    },
  );
}
