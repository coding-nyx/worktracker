/**
 * REST + MCP client for the WorkTracker web UI. Uses the
 * admin token (in the `WORKTRACKER_ADMIN_TOKEN` env at deploy
 * time, stored in localStorage in the browser) for all calls.
 *
 * Single-user v0: the UI is always running as the admin.
 */

import type {
  Command,
  CommandFailuresResponse,
  CreateSourceRequest,
  CreateSourceResponse,
  EnrichRequest,
  LinkRequest,
  ListItemsResponse,
  SourceRegistration,
  TransitionRequest,
  WorkItem,
  WorkItemEvent,
} from '@worktracker/types';

const TOKEN_KEY = 'worktracker.admin_token';
const API_BASE_KEY = 'worktracker.api_base';

function apiBase(): string {
  if (typeof window !== 'undefined') {
    const stored = window.localStorage.getItem(API_BASE_KEY);
    if (stored) return stored;
  }
  return process.env.NEXT_PUBLIC_API_BASE ?? '';
}

function token(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setCredentials(apiBaseUrl: string, adminToken: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(API_BASE_KEY, apiBaseUrl);
  window.localStorage.setItem(TOKEN_KEY, adminToken);
}

export function getCredentials(): { apiBase: string; token: string } {
  return { apiBase: apiBase(), token: token() };
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
  const headers: Record<string, string> = { Authorization: `Bearer ${token()}` };
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
    return request<ListItemsResponse>('GET', `/items${qs ? `?${qs}` : ''}`);
  },
  getItem: (id: string) => request<WorkItem>('GET', `/items/${id}`),
  getItemEvents: (id: string) => request<{ events: WorkItemEvent[] }>('GET', `/items/${id}/events`),
  createItem: (body: {
    kind: WorkItem['kind'];
    title: string;
    body?: string;
    severity?: WorkItem['severity'];
    priority?: WorkItem['priority'];
    owner?: string;
    due_at?: string;
  }) => request<{ command_id: string; status: 'queued' }>('POST', '/items', body),
  transition: (id: string, body: TransitionRequest) =>
    request<{ command_id: string; status: 'queued' }>('POST', `/items/${id}/transition`, body),
  comment: (id: string, body: { body: string; expected_version?: number }) =>
    request<{ command_id: string; status: 'queued' }>('POST', `/items/${id}/comment`, body),
  link: (id: string, body: LinkRequest) =>
    request<{ command_id: string; status: 'queued' }>('POST', `/items/${id}/link`, body),
  enrich: (id: string, body: EnrichRequest) =>
    request<{ command_id: string; status: 'queued' }>('POST', `/items/${id}/enrich`, body),

  listSources: () => request<{ sources: SourceRegistration[] }>('GET', '/sources'),
  createSource: (body: CreateSourceRequest) => request<CreateSourceResponse>('POST', '/sources', body),

  // Dead-letter admin surface.
  listCommands: (q: { status?: 'queued' | 'evaluating' | 'applied' | 'rejected' | 'failed'; limit?: number } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    return request<{ commands: Command[] }>('GET', `/commands${qs ? `?${qs}` : ''}`);
  },
  getCommand: (id: string) =>
    request<{ command: Command | null }>('GET', `/commands/${id}`),
  listCommandFailures: (id: string) =>
    request<CommandFailuresResponse>('GET', `/commands/${id}/failures`),
  replayCommand: (id: string) =>
    request<{ command_id: string; status: 'queued'; requeued_at: string }>(
      'POST',
      `/commands/${id}/replay`,
    ),
};
