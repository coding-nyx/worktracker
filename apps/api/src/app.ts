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

  // Replace Fastify's default JSON content-type parser. The default
  // parser (rawBody, gated by parseAs:'string' or parseAs:'buffer')
  // waits for the request stream's `end` event before completing.
  // On Cloud Run's HTTP/1.1 frontend, `end` never fires after the
  // body is fully sent (the connection stays alive), so the parser
  // hangs until the 60s request timeout kills the request.
  //
  // The fix is to register a parser WITHOUT the `parseAs` option —
  // that bypasses the internal `rawBody` method and gives us the
  // raw payload stream directly. We then read it manually and
  // complete the parse as soon as Content-Length bytes have been
  // received, with `end` as a fallback for the no-Content-Length
  // case. See fastify/fastify#3382 for the matching Cloud
  // Functions bug; the same workaround applies to Cloud Run.
  app.removeContentTypeParser(['application/json']);
  app.addContentTypeParser('application/json', (req, payload, done) => {
    const contentLength = Number(req.headers['content-length']) || 0;
    const chunks: Buffer[] = [];
    let received = 0;
    let finished = false;

    const finish = (err: Error | null, value?: unknown): void => {
      if (finished) return;
      finished = true;
      payload.removeAllListeners('data');
      payload.removeAllListeners('end');
      payload.removeAllListeners('error');
      if (err) {
        (err as Error & { statusCode?: number }).statusCode =
          (err as Error & { statusCode?: number }).statusCode ?? 400;
        done(err, undefined);
        return;
      }
      done(null, value);
    };

    payload.on('data', (chunk: Buffer) => {
      if (finished) return;
      chunks.push(chunk);
      received += chunk.length;
      if (contentLength > 0 && received >= contentLength) {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          finish(null, body.length === 0 ? {} : JSON.parse(body));
        } catch (err) {
          finish(err as Error);
        }
      }
    });

    payload.on('end', () => {
      if (finished) return;
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        finish(null, body.length === 0 ? {} : JSON.parse(body));
      } catch (err) {
        finish(err as Error);
      }
    });

    payload.on('error', (err: Error) => finish(err));
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
    // The custom body parser above calls JSON.parse on the raw
    // request body. When the body has a literal control character
    // (e.g. a real newline inside a string) V8 throws a
    // SyntaxError like "Bad control character in string literal
    // in JSON at position N". Surface a clean 400 with a
    // useful message instead of leaking the V8 text.
    if (err instanceof SyntaxError || /Bad control character|Unexpected token|JSON/i.test(err.message)) {
      reply.code(400).send({
        error: {
          code: 'invalid_json',
          message:
            'Request body is not valid JSON. Escape control characters (newlines, tabs) in string values, or send the body with proper JSON encoding.',
          details: { reason: err.message },
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
  const { clientsRoutes } = await import('./routes/clients.js');
  await clientsRoutes(app);
  const { connectorsRoutes } = await import('./routes/connectors.js');
  await connectorsRoutes(app);
  const { filesRoutes } = await import('./routes/files.js');
  await filesRoutes(app);
  const { analyticsRoutes } = await import('./routes/analytics.js');
  await analyticsRoutes(app);
  const { commandsRoutes } = await import('./routes/commands.js');
  await commandsRoutes(app);
  const { commandsAdminRoutes } = await import('./routes/commands-admin.js');
  await commandsAdminRoutes(app);
  const { boardsRoutes } = await import('./routes/boards.js');
  await boardsRoutes(app);
  const { authRoutes } = await import('./routes/auth.js');
  await authRoutes(app);
  const { adminUsersRoutes } = await import('./routes/admin-users.js');
  await adminUsersRoutes(app);
  const { aiRoutes } = await import('./routes/ai.js');
  await aiRoutes(app);
  const { webhookRoutes } = await import('./routes/webhooks.js');
  await webhookRoutes(app);
  const { mcpRoutes } = await import('./mcp.js');
  await mcpRoutes(app);
  const { mcpRoutesV2 } = await import('./mcp-v2.js');
  await mcpRoutesV2(app);

  return app;
}
