/**
 * AI chat route. Single endpoint, request/response (no
 * streaming in v0). The frontend posts the full conversation
 * history; the server adds the system prompt, calls the
 * OpenAI-compatible provider, runs any tool calls locally
 * (via the same dispatch as MCP, with the user's auth), and
 * returns the final assistant message along with a tool
 * trace so the UI can render "fetched items…", "created
 * board…", etc.
 *
 * Auth: any signed-in Firebase user (worktracker_users).
 * The AI acts on behalf of the user — its tool calls go
 * through the same RBAC as the MCP server.
 *
 * Env vars (read once at module load by client.ts):
 *   AI_BASE_URL  e.g. https://api.openai.com/v1
 *   AI_API_KEY   the provider's bearer
 *   AI_MODEL     e.g. gpt-4o-mini
 *
 * Until AI_API_KEY is set the endpoint returns 503 — the
 * chat UI handles the empty-state gracefully.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { WorktrackerUser } from '@worktracker/types';
import { requireSource } from '../auth.js';
import { AI_TOOLS } from '../ai/tools.js';
import { chatCompletion, isAiConfigured, type ChatMessage, type ToolCall } from '../ai/client.js';
import { buildSystemPrompt } from '../ai/prompts.js';
import { dispatchTool } from '../mcp-tools.js';

const MAX_TOOL_TURNS = 8; // safety: cap the agent loop

const RequestBody = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string(),
      }),
    )
    .min(1)
    .max(50),
});

export interface AiChatResponse {
  message: ChatMessage;
  tool_trace: Array<{
    name: string;
    args: Record<string, unknown>;
    ok: boolean;
    result?: unknown;
    error?: string;
  }>;
  /** Echoes whether the provider is configured, for the UI's empty state. */
  configured: boolean;
  /** True when the AI hit MAX_TOOL_TURNS without a final text response. */
  truncated: boolean;
}

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/ai/chat', { preHandler: requireSource }, async (req, reply) => {
    // requireSource must have set `kind: 'user'` for the AI to
    // have a worktracker identity. Admin and source tokens
    // don't have a user record, so we reject them.
    if (req.auth?.kind !== 'user' || !req.auth.user) {
      reply.code(403).send({
        error: { code: 'not_a_user', message: 'sign in with email/password to use the AI' },
      });
      return;
    }
    if (!isAiConfigured()) {
      reply.code(503).send({
        error: {
          code: 'ai_not_configured',
          message:
            'AI provider is not configured. Set AI_API_KEY (and optionally AI_BASE_URL, AI_MODEL) on the API and redeploy.',
        },
      });
      return;
    }

    const parsed = RequestBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({
        error: { code: 'invalid_input', message: 'invalid request', details: parsed.error.issues },
      });
      return;
    }

    const user = req.auth.user;
    const systemPrompt = await buildSystemPrompt(user);
    const incoming: ChatMessage[] = parsed.data.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...incoming,
    ];

    const toolTrace: AiChatResponse['tool_trace'] = [];
    let truncated = false;
    let last: ChatMessage | null = null;

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
      let response;
      try {
        response = await chatCompletion({
          messages,
          tools: AI_TOOLS,
          tool_choice: 'auto',
          temperature: 0.4,
        });
      } catch (err) {
        reply.code(502).send({
          error: { code: 'ai_provider_error', message: (err as Error).message },
        });
        return;
      }
      const choice = response.choices?.[0];
      if (!choice) {
        reply.code(502).send({
          error: { code: 'ai_provider_error', message: 'no choices in response' },
        });
        return;
      }
      const msg = choice.message;
      messages.push(msg);
      last = msg;

      // No tool calls → the model is done.
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        break;
      }

      // Execute each tool call in the same Fastify request
      // context (so writes go through the same auth). Run them
      // in parallel for speed; the dispatch is a pure function
      // over the user's auth, so there's no shared mutable
      // state.
      const toolResults = await Promise.all(
        msg.tool_calls.map(async (tc: ToolCall) => {
          const args = safeParseArgs(tc.function.arguments);
          const result = await runToolLocally(tc.function.name, args, user, req);
          return { tc, args, result };
        }),
      );
      for (const { tc, args, result } of toolResults) {
        if (result.ok) {
          toolTrace.push({ name: tc.function.name, args, ok: true, result: result.value });
        } else {
          toolTrace.push({ name: tc.function.name, args, ok: false, error: result.error });
        }
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          // The model expects a stringified JSON payload. Keep
          // errors explicit so the model can react.
          content: JSON.stringify(
            result.ok
              ? { ok: true, result: result.value }
              : { ok: false, error: result.error },
          ),
        });
      }
    }

    if (!last) {
      // Should not happen — the loop always pushes at least one
      // assistant message.
      reply.code(502).send({ error: { code: 'ai_provider_error', message: 'no response' } });
      return;
    }
    if ((last.tool_calls?.length ?? 0) > 0) {
      truncated = true;
    }

    const body: AiChatResponse = {
      message: last,
      tool_trace: toolTrace,
      configured: true,
      truncated,
    };
    reply.send(body);
  });
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

type ToolRunResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * Dispatch a single tool call locally with the user's auth.
 * Calls the shared `dispatchTool` directly (no JSON-RPC envelope
 * — that wrapping lives in mcp.ts and mcp-v2.ts; the AI uses
 * the raw result).
 */
async function runToolLocally(
  name: string,
  args: Record<string, unknown>,
  user: WorktrackerUser,
  _httpReq: FastifyRequest,
): Promise<ToolRunResult> {
  // The dispatch reads `auth` and `log` from the request; the
  // rest can be empty. Pass a typed-shaped stub.
  const fakeReq = { auth: { kind: 'user' as const, user }, log: _httpReq.log } as unknown as FastifyRequest;
  try {
    const result = await dispatchTool(name, args, fakeReq);
    if (result.ok) {
      return { ok: true, value: result.value };
    }
    return { ok: false, error: result.error ?? 'internal error' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
