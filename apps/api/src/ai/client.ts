/**
 * Minimal OpenAI-compatible chat completions client. No SDK —
 * just fetch + JSON, so the same code works for OpenAI,
 * MiniMax, or any provider that follows the same wire format.
 *
 * Config is via env vars (read at module load, since the
 * provider is process-static):
 *
 *   AI_BASE_URL   e.g. https://api.openai.com/v1
 *                 or https://api.minimaxi.chat/v1
 *   AI_API_KEY    the provider's bearer token
 *   AI_MODEL      the model id, e.g. gpt-4o-mini
 *
 * Streaming is not used in v0; the chat endpoint returns the
 * full response so the web client renders it as a single
 * message. If we want token-by-token streaming later, swap
 * `stream: false` for `stream: true` and parse SSE.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** For tool result messages, the id of the tool_call being answered. */
  tool_call_id?: string;
  /** For assistant messages, the tool calls the model requested. */
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
}

export interface ChatResponse {
  id: string;
  choices: ChatChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

let cached: AiConfig | null = null;

export function loadAiConfig(): AiConfig {
  if (cached) return cached;
  const baseUrl = (process.env.AI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const apiKey = process.env.AI_API_KEY ?? '';
  const model = process.env.AI_MODEL ?? 'gpt-4o-mini';
  cached = { baseUrl, apiKey, model };
  return cached;
}

export function isAiConfigured(): boolean {
  return Boolean(loadAiConfig().apiKey);
}

/**
 * Single chat-completion round-trip. Throws on network or
 * non-2xx responses. The caller (the chat route) handles the
 * tool-use loop: when the model returns `finish_reason:
 * tool_calls`, the caller executes the tool calls, appends
 * the results, and calls again.
 */
export async function chatCompletion(req: ChatRequest): Promise<ChatResponse> {
  const cfg = loadAiConfig();
  if (!cfg.apiKey) {
    throw new Error('AI not configured: AI_API_KEY is empty');
  }
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: req.model ?? cfg.model,
      messages: req.messages,
      ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
      ...(req.tool_choice ? { tool_choice: req.tool_choice } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.max_tokens ? { max_tokens: req.max_tokens } : {}),
      stream: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AI provider ${res.status}: ${body.slice(0, 500)}`);
  }
  return (await res.json()) as ChatResponse;
}
