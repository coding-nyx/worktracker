/**
 * Inbound webhooks for sources that prefer push over REST.
 * Each request carries an HMAC signature header
 * `X-WorkTracker-Signature: sha256=…` keyed by the source's
 * `webhook_secret`. We translate the payload into a command
 * document so the brain is still the only writer.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ulid, nowIso } from '../ids.js';
import { getDb } from '../firestore.js';
import { InvalidInputError, UnauthorizedError } from '../errors.js';
import type { Command } from '@worktracker/types';

const IncomingSchema = z.object({
  event: z.string().min(1),
  source_event_id: z.string().min(1),
  payload: z.record(z.unknown()),
});

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/webhooks/:source', async (req, reply) => {
    const { source } = z.object({ source: z.string() }).parse(req.params);
    const sourceDoc = await getDb().collection('sources').doc(source).get();
    if (!sourceDoc.exists) {
      throw new UnauthorizedError(`unknown source ${source}`);
    }
    const sourceData = sourceDoc.data() as { webhook_secret: string | null };
    const secret = sourceData.webhook_secret;
    if (!secret) {
      throw new UnauthorizedError(`source ${source} has no webhook_secret`);
    }
    const raw = JSON.stringify(req.body);
    const sigHeader = req.headers['x-worktracker-signature'];
    if (typeof sigHeader !== 'string') {
      throw new UnauthorizedError('missing signature');
    }
    const expected = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
    const a = Buffer.from(sigHeader);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedError('signature mismatch');
    }
    const body = IncomingSchema.parse(req.body);
    const command = translateWebhook(source, body);
    if (!command) {
      reply.code(202);
      return { accepted: true, command_id: null, ignored: true };
    }
    await getDb().collection('commands').doc(command.id).set(command);
    reply.code(202);
    return { accepted: true, command_id: command.id };
  });
}

function translateWebhook(
  source: string,
  body: z.infer<typeof IncomingSchema>,
): Command | null {
  const id = ulid();
  const now = nowIso();
  const base = {
    id,
    source,
    source_event_id: body.source_event_id,
    status: 'queued' as const,
    error: null,
    applied_event_id: null,
    created_at: now,
    applied_at: null,
    failure_count: 0,
    failed_at: null,
    requeued_at: null,
  };
  // Minimal mapping; expand per source as we wire connectors.
  switch (body.event) {
    case 'item.created':
      return {
        ...base,
        op: 'create',
        item_id: null,
        payload: body.payload as never,
      };
    case 'item.updated':
    case 'item.transitioned': {
      const itemId = (body.payload as { id?: string }).id;
      if (!itemId) throw new InvalidInputError('webhook item payload missing id');
      return {
        ...base,
        op: body.event === 'item.transitioned' ? 'transition' : 'update',
        item_id: itemId,
        payload: body.payload as never,
      };
    }
    default:
      // Unknown event type — ignore (the source might be sending
      // events we don't care about yet).
      return null;
  }
}
