/**
 * Source registration routes. Admin-only.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nowIso } from '../ids.js';
import { getDb } from '../firestore.js';
import { requireAdmin, requireSource, hashApiKey } from '../auth.js';
import type { ApiTokenScope, CreateSourceRequest, CreateSourceResponse, SourceManifest, SourceRegistration } from '@worktracker/types';
import { API_TOKEN_SCOPES } from '@worktracker/types';
import { randomBytes } from 'node:crypto';

const ManifestSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/, 'lowercase letters, digits, underscore, hyphen only'),
  display_name: z.string().min(1).max(200),
  kind: z.enum(['agent', 'human', 'system', 'webhook']),
  capabilities: z.array(z.string()).min(0),
  webhook_url: z.string().url().nullable().optional(),
  icon: z.string().nullable().optional(),
  version: z.string().min(1),
  enricher: z
    .object({
      grill: z
        .object({
          kind: z.literal('skill'),
          skill_path: z.string(),
          command: z.string(),
        })
        .optional(),
      wayfind: z
        .object({
          kind: z.literal('skill'),
          skill_path: z.string(),
          command: z.string(),
        })
        .optional(),
    })
    .optional(),
});

const CreateSourceSchema = z.object({
  manifest: ManifestSchema,
  api_key: z.string().min(16).max(256).optional(),
  // Slice 1: every source declares its scope at registration.
  // Defaults to `read_write` (the v0.4 implicit default). Admin
  // callers can pass `admin` to mint an admin-scope source
  // (used for the new Hermes connector, the operator's
  // personal agent, etc.).
  scope: z.enum(API_TOKEN_SCOPES).default('read_write'),
});

const PatchSourceSchema = z.object({
  enabled: z.boolean().optional(),
  rotate_api_key: z.boolean().optional(),
  capabilities: z.array(z.string()).optional(),
  webhook_secret: z.string().nullable().optional(),
});

export async function sourcesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sources', { preHandler: requireSource }, async () => {
    const snap = await getDb().collection('sources').get();
    return { sources: snap.docs.map((d) => d.data() as SourceRegistration) };
  });

  app.get('/api/sources/:name', { preHandler: requireSource }, async (req) => {
    const { name } = z.object({ name: z.string() }).parse(req.params);
    const doc = await getDb().collection('sources').doc(name).get();
    if (!doc.exists) return { source: null };
    return { source: doc.data() as SourceRegistration };
  });

  app.post('/api/sources', { preHandler: requireAdmin }, async (req, reply) => {
    const body = CreateSourceSchema.parse(req.body) satisfies CreateSourceRequest;
    const manifest = body.manifest satisfies SourceManifest;
    const scope: ApiTokenScope = body.scope;
    const plaintext = body.api_key ?? randomBytes(24).toString('base64url');
    const hash = await hashApiKey(plaintext);
    const now = nowIso();
    const source: SourceRegistration = {
      name: manifest.name,
      display_name: manifest.display_name,
      kind: manifest.kind,
      scope,
      manifest,
      capabilities: manifest.capabilities,
      webhook_secret: null,
      enabled: true,
      last_sync_at: null,
      last_error: null,
      created_at: now,
      updated_at: now,
    };
    // Store the api_key_hash as a separate top-level field so it
    // can be rotated without rewriting the whole document.
    await getDb()
      .collection('sources')
      .doc(manifest.name)
      .set({ ...source, api_key_hash: hash });
    const response: CreateSourceResponse = { source, api_key: plaintext };
    reply.code(201);
    return response;
  });

  app.patch('/api/sources/:name', { preHandler: requireAdmin }, async (req) => {
    const { name } = z.object({ name: z.string() }).parse(req.params);
    const body = PatchSourceSchema.parse(req.body);
    const ref = getDb().collection('sources').doc(name);
    const update: Record<string, unknown> = { updated_at: nowIso() };
    if (body.enabled !== undefined) update.enabled = body.enabled;
    if (body.capabilities !== undefined) update.capabilities = body.capabilities;
    if (body.webhook_secret !== undefined) update.webhook_secret = body.webhook_secret;
    if (body.rotate_api_key) {
      const plaintext = randomBytes(24).toString('base64url');
      update.api_key_hash = await hashApiKey(plaintext);
      await ref.update(update);
      return { rotated: true, api_key: plaintext };
    }
    await ref.update(update);
    const fresh = await ref.get();
    return { source: fresh.data() as SourceRegistration };
  });

  app.delete('/api/sources/:name', { preHandler: requireAdmin }, async (req) => {
    const { name } = z.object({ name: z.string() }).parse(req.params);
    await getDb().collection('sources').doc(name).update({
      enabled: false,
      updated_at: nowIso(),
    });
    return { name, disabled: true };
  });
}
