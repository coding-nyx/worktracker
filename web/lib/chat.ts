/**
 * API client for the AI chat route. The chat panel sends the
 * full conversation history; the server returns a single
 * assistant message + a tool trace.
 */

import type { WorktrackerUser } from '@worktracker/types';
import { getFirebaseAuth } from './firebase';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolTraceEntry {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface ChatResponse {
  message: { role: 'assistant' | string; content: string; tool_calls?: unknown };
  tool_trace: ToolTraceEntry[];
  configured: boolean;
  truncated: boolean;
}

export class ChatError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function sendChat(messages: ChatTurn[]): Promise<ChatResponse> {
  const auth = getFirebaseAuth();
  const user = auth.currentUser;
  if (!user) throw new ChatError(401, 'unauthenticated', 'sign in to use the AI');

  const apiBase =
    (typeof window !== 'undefined' && window.localStorage.getItem('worktracker.api_base')) ||
    process.env.NEXT_PUBLIC_API_BASE ||
    '';
  const idToken = await user.getIdToken();
  const res = await fetch(`${apiBase}/api/ai/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ messages }),
  });
  const text = await res.text();
  if (!res.ok) {
    let parsed: { error?: { code: string; message: string } } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      // non-JSON
    }
    const err = parsed.error ?? { code: 'unknown', message: text || res.statusText };
    throw new ChatError(res.status, err.code, err.message);
  }
  return JSON.parse(text) as ChatResponse;
}

export async function sendChatTurn(
  history: ChatTurn[],
  currentUser: WorktrackerUser | null,
): Promise<{ reply: ChatTurn; trace: ToolTraceEntry[]; truncated: boolean }> {
  const res = await sendChat(history);
  return {
    reply: { role: 'assistant', content: res.message.content ?? '' },
    trace: res.tool_trace ?? [],
    truncated: res.truncated ?? false,
  };
}
