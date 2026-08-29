/**
 * Fastify app factory. Wires middleware, routes, and the MCP
 * server. Used by both the Cloud Function entry and the local
 * dev server.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { WorkTrackerError } from './errors.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
    },
    bodyLimit: 1024 * 1024, // 1 MiB; webhooks can be larger
    disableRequestLogging: false,
  });

  // Set up CORS for the browser UI. Bearer tokens mean we
  // can't use cookie auth, so wildcard origin is fine for
  // v0; tighten in v0.5.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    reply.header(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, X-WorkTracker-Signature, X-WorkTracker-Source-Event-Id',
    );
    if (req.method === 'OPTIONS') {
      reply.code(204).send();
    }
  });

  // Routes are registered under `/api/...` so both Firebase
  // Hosting rewrites (`/api/**` → Cloud Run with the path
  // preserved) and direct Cloud Run hits at the `/api/...`
  // paths land on the right handler. No path rewriting is
  // needed at runtime; Fastify uses the URL as-is.

  // Centralized error handler — every WorkTrackerError
  // becomes a structured JSON response with the right status.
  app.setErrorHandler((err: Error, req, reply) => {
    if (err instanceof WorkTrackerError) {
      reply.code(err.status).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      });
      return;
    }
    // Fastify validation errors (zod throws via fastify-type-provider
    // or our schema.parse) come through here.
    if (err.name === 'ZodError') {
      reply.code(400).send({
        error: {
          code: 'invalid_input',
          message: 'validation failed',
          details: (err as unknown as { issues: unknown }).issues,
        },
      });
      return;
    }
    req.log.error({ err }, 'unhandled error');
    reply.code(500).send({
      error: { code: 'internal_error', message: 'internal server error' },
    });
  });

  // Lazy route registration so the app can be built without
  // immediately hitting Firestore (important for the local
  // emulator cold-start path).
  const { healthRoutes } = await import('./routes/health.js');
  await healthRoutes(app);
  const { itemsRoutes } = await import('./routes/items.js');
  await itemsRoutes(app);
  const { sourcesRoutes } = await import('./routes/sources.js');
  await sourcesRoutes(app);
  const { commandsRoutes } = await import('./routes/commands.js');
  await commandsRoutes(app);
  const { webhookRoutes } = await import('./routes/webhooks.js');
  await webhookRoutes(app);
  const { mcpRoutes } = await import('./mcp.js');
  await mcpRoutes(app);

  return app;
}
