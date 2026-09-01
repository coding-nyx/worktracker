/**
 * REST + MCP client for the WorkTracker web UI. Authenticates
 * with a Firebase Auth ID token when one is available
 * (`getFirebaseAuth().currentUser`), falling back to the
 * admin token in localStorage for source-bearer flows.
 *
 * Firebase Auth is the primary auth path; the admin-token
 * fallback is for operator scripts, MCP, and the deep-link
 * hash bootstrap.
 */

import type {
  Board,
  Command,
  CommandFailuresResponse,
  CreateSourceRequest,
  CreateSourceResponse,
  CreateBoardRequest,
  EnrichRequest,
  LinkRequest,
  ListItemsResponse,
  ListBoardsResponse,
  SourceRegistration,
  TransitionRequest,
  UpdateBoardRequest,
  WorkItem,
  WorkItemEvent,
} from '@worktracker/types';
import { getFirebaseAuth } from './firebase';

const TOKEN_KEY = 'worktracker.admin_token';
const API_BASE_KEY = 'worktracker.api_base';

function apiBase(): string {
  if (typeof window !== 'undefined') {
    const stored = window.localStorage.getItem(API_BASE_KEY);
    if (stored) return stored;
  }
  return process.env.NEXT_PUBLIC_API_BASE ?? '';
}

function adminToken(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(TOKEN_KEY) ?? '';
}

/**
 * Resolve the bearer for an outgoing request. Prefers the
 * Firebase Auth ID token (signed-in user); falls back to the
 * admin token in localStorage (source-bearer flow). The ID
 * token is force-refreshed when within 60s of expiry so a
 * long-lived page doesn't issue a request with a stale token.
 */
async function bearer(): Promise<string> {
  const auth = getFirebaseAuth();
  const u = auth.currentUser;
  if (u) {
    const token = await u.getIdToken();
    if (token) return token;
  }
  return adminToken();
}

export function setCredentials(apiBaseUrl: string, token: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(API_BASE_KEY, apiBaseUrl);
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function getCredentials(): { apiBase: string; token: string } {
  return { apiBase: apiBase(), token: adminToken() };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await bearer()}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let parsed: { error?: { code: string; message: string; details?: unknown } } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON body.
    }
    const err = parsed.error ?? { code: 'unknown', message: text || res.statusText };
    throw new ApiError(res.status, err.code, err.message, err.details);
  }
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export const api = {
  listItems: (q: { kind?: string; status?: string; source?: string; owner?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined && v !== '') params.set(k, String(v));
    }
    const qs = params.toString();
    return request<ListItemsResponse>('GET', `/api/items${qs ? `?${qs}` : ''}`);
  },
  getItem: (id: string) => request<WorkItem>('GET', `/api/items/${id}`),
  getItemEvents: (id: string) => request<{ events: WorkItemEvent[] }>('GET', `/api/items/${id}/events`),
  updateItem: (body: { id: string; patch: Record<string, unknown>; expected_version: number }) =>
    request<{ command_id: string; status: 'queued' }>('PATCH', `/api/items/${body.id}`, body),
  createItem: (body: {
    kind: WorkItem['kind'];
    title: string;
    body?: string;
    severity?: WorkItem['severity'];
    priority?: WorkItem['priority'];
    owner?: string;
    due_at?: string;
  }) => request<{ command_id: string; status: 'queued' }>('POST', '/api/items', body),
  transition: (id: string, body: TransitionRequest) =>
    request<{ command_id: string; status: 'queued' }>('POST', `/api/items/${id}/transition`, body),
  comment: (id: string, body: { body: string; expected_version?: number }) =>
    request<{ command_id: string; status: 'queued' }>('POST', `/api/items/${id}/comment`, body),
  link: (id: string, body: LinkRequest) =>
    request<{ command_id: string; status: 'queued' }>('POST', `/api/items/${id}/link`, body),
  enrich: (id: string, body: EnrichRequest) =>
    request<{ command_id: string; status: 'queued' }>('POST', `/api/items/${id}/enrich`, body),

  listSources: () => request<{ sources: SourceRegistration[] }>('GET', '/api/sources'),
  createSource: (body: CreateSourceRequest) => request<CreateSourceResponse>('POST', '/api/sources', body),

  // Boards: saved kanban views with named columns and a kind
  // filter. Read by anyone; create/update/delete are admin-only
  // (the server returns 403 if a non-admin tries).
  listBoards: () => request<ListBoardsResponse>('GET', '/api/boards'),
  getBoard: (id: string) => request<{ board: Board | null }>('GET', `/api/boards/${id}`),
  createBoard: (body: CreateBoardRequest) =>
    request<{ board: Board }>('POST', '/api/boards', body),
  updateBoard: (id: string, body: UpdateBoardRequest) =>
    request<{ board: Board }>('PATCH', `/api/boards/${id}`, body),
  deleteBoard: (id: string) =>
    request<{ id: string; deleted: boolean }>('DELETE', `/api/boards/${id}`),

  // Dead-letter admin surface.
  listCommands: (q: { status?: 'queued' | 'evaluating' | 'applied' | 'rejected' | 'failed'; limit?: number } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    return request<{ commands: Command[] }>('GET', `/api/commands${qs ? `?${qs}` : ''}`);
  },
  getCommand: (id: string) =>
    request<{ command: Command | null }>('GET', `/api/commands/${id}`),
  listCommandFailures: (id: string) =>
    request<CommandFailuresResponse>('GET', `/api/commands/${id}/failures`),
  replayCommand: (id: string) =>
    request<{ command_id: string; status: 'queued'; requeued_at: string }>(
      'POST',
      `/api/commands/${id}/replay`,
    ),
};
