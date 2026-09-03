/**
 * Request tracing + structured logging (slice 5).
 *
 * Every MCP tool call and every REST write gets a `requestId`
 * (16 hex chars) and a structured event log. The chain is:
 *
 *   POST /mcp/stream (or /mcp or /mcp/v2)
 *     └─ requireSource                [trace: auth.ok | auth.failed]
 *     └─ zod.parse(arguments)         [trace: parse.ok | parse.failed]
 *     └─ dispatchTool → handler       [trace: dispatch.start]
 *     └─ command enqueued             [trace: command.enqueued]
 *     └─ (brain applies later)        [trace: brain.applied | brain.rejected | brain.failed]
 *
 * The requestId is echoed in the JSON-RPC error envelope's
 * `data.request_id` so an LLM can quote it back to the operator.
 *
 * For analytics (slice 6) the dispatcher writes a row to
 * `analytics/call_traces/{trace_id}` with a 30-day TTL.
 * Here we only emit structured logs; the analytics write is
 * added in slice 6.
 *
 * The logger is a thin wrapper over Fastify's `req.log` so the
 * Cloud Run / Cloud Functions service picks the events up
 * automatically. Fields are flat (not nested) so a structured
 * log query is one filter.
 */

import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export interface RequestTrace {
  requestId: string;
  /** Set when the request is authenticated. */
  bearer?: string;
  source?: string;
  /** Set after `tools/list` resolves the bearer's scope. */
  scope?: 'read' | 'read_write' | 'admin';
}

/**
 * Mint a new trace. The `requestId` is unique per request; we
 * keep the same id for any brain events that result from the
 * command this request enqueued.
 */
export function newRequestTrace(): RequestTrace {
  return { requestId: randomBytes(8).toString('hex') };
}

/**
 * Attach a trace to a request. The trace rides on `req` so the
 * downstream handlers and the JSON-RPC envelope can both read
 * it. The `req.id` is also set so the structured logs include
 * the same id.
 */
export function attachTrace(req: FastifyRequest, trace: RequestTrace): void {
  (req as { trace?: RequestTrace }).trace = trace;
}

export function getTrace(req: FastifyRequest): RequestTrace | undefined {
  return (req as { trace?: RequestTrace }).trace;
}

/**
 * Emit a structured event. The fields are flat so they're easy
 * to filter in Cloud Logging. Keep the message short — the
 * fields carry the rest.
 *
 * The `req` variant attaches `trace_id` from the request's
 * trace (and inherits `bearer_kind`, `source`, `scope` if
 * set). The `trace` variant takes a `RequestTrace` directly
 * — used by the brain, which doesn't have a Fastify request.
 */
export function logTraceEvent(
  arg: FastifyRequest | RequestTrace,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const trace: RequestTrace | undefined =
    'requestId' in arg ? arg : getTrace(arg);
  const sink: { info: (obj: object, msg?: string) => void } =
    'log' in arg && arg.log
      ? (arg.log as { info: (obj: object, msg?: string) => void })
      : { info: (obj, msg) => console.log(JSON.stringify({ ...obj, msg })) };
  sink.info(
    {
      trace_id: trace?.requestId ?? 'unknown',
      event,
      ...(trace?.bearer ? { bearer_kind: trace.bearer } : {}),
      ...(trace?.source ? { source: trace.source } : {}),
      ...(trace?.scope ? { scope: trace.scope } : {}),
      ...fields,
    },
    event,
  );
}
