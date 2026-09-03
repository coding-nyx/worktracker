/**
 * REST + MCP client for the WorkTracker web UI. Authenticates
 * with a Firebase Auth ID token when one is available
 * (`getFirebaseAuth().currentUser`), falling back to the
 * admin token in localStorage for source-bearer flows.
 *
 * Firebase Auth is the primary auth path; the admin-token
 * fallback is for operator scripts, MCP, and the deep-link
 * hash bootstrap.
 *
 * Slice 2: the `sources` and `api_tokens` REST surfaces are
 * consolidated under `/api/clients`. `clients` is the unified
 * shape for any authenticated identity — agents (MCP servers,
 * bridges) and users (personal access tokens). Connectors are
 * a separate admin-only REST surface at `/api/connectors`.
 */

import type {
  Board,
  Client,
  ClientKind,
  ClientManifest,
  Command,
  CommandFailuresResponse,
  Connector,
  ConnectorKind,
  CreateBoardRequest,
  EnrichRequest,
  IntrospectClientResponse,
  LinkRequest,
  ListBoardsResponse,
  ListClientsResponse,
  ListConnectorsResponse,
  ListItemsResponse,
  TransitionRequest,
  UpdateBoardRequest,
  WorkItem,
  WorkItemEvent,
  WorktrackerUser,
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

export type ApiTokenScope = 'read' | 'read_write' | 'admin';

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

  // ---- Clients (slice 2) ----
  // Unified surface for any authenticated identity — agent clients
  // (MCP servers, bridges) and user clients (personal access tokens).
  // The "register agent" POST is admin-only; the "mint user" POST is
  // a logged-in user minting a personal client for themselves.
  listClients: () => request<ListClientsResponse>('GET', '/api/clients'),
  getClient: (name: string) => request<{ client: Client }>('GET', `/api/clients/${encodeURIComponent(name)}`),
  introspectClient: () => request<IntrospectClientResponse>('GET', '/api/clients/introspect'),
  registerClient: (body: { manifest: ClientManifest; bearer?: string; scope?: ApiTokenScope }) =>
    request<{ client: Client; bearer: string }>('POST', '/api/clients', body),
  patchClient: (name: string, patch: { enabled?: boolean; scope?: ApiTokenScope; display_name?: string }) =>
    request<{ client: Client }>('PATCH', `/api/clients/${encodeURIComponent(name)}`, patch),
  rotateClient: (name: string) =>
    request<{ client: Client; bearer: string }>('POST', `/api/clients/${encodeURIComponent(name)}/rotate`),
  revokeClient: (name: string) =>
    request<{ name: string; revoked?: boolean; disabled?: boolean }>('DELETE', `/api/clients/${encodeURIComponent(name)}`),
  mintClient: (body: { name: string; scope: ApiTokenScope; owner_uid: string; owner_email: string }) =>
    request<{ client: Client; bearer: string }>('POST', '/api/clients/mint', body),

  // ---- Connectors (slice 2, admin-only) ----
  // The integrations the API talks to. Hermes, OpenClaw, GitHub
  // mirror, etc. — separate from clients because a client is who
  // calls us; a connector is what we call.
  listConnectors: () => request<ListConnectorsResponse>('GET', '/api/connectors'),
  getConnector: (name: string) =>
    request<{ connector: Connector }>('GET', `/api/connectors/${encodeURIComponent(name)}`),
  registerConnector: (body: {
    name: string;
    kind: ConnectorKind;
    protocol: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
  }) => request<{ connector: Connector }>('POST', '/api/connectors', body),
  patchConnector: (name: string, patch: { enabled?: boolean; config?: Record<string, unknown>; protocol?: string }) =>
    request<{ connector: Connector }>('PATCH', `/api/connectors/${encodeURIComponent(name)}`, patch),
  testConnector: (name: string) =>
    request<{ ok: boolean; connector: Connector; note?: string }>(
      'POST',
      `/api/connectors/${encodeURIComponent(name)}/test`,
    ),

  // Admin: user management. listUsers / updateUser / inviteUser.
  // All three require an admin (is_admin: true) bearer; the API
  // returns 403 otherwise.
  listUsers: () => request<{ users: WorktrackerUser[] }>('GET', '/api/admin/users'),
  updateUser: (uid: string, patch: { is_admin?: boolean; enabled?: boolean; display_name?: string | null }) =>
    request<{ user: WorktrackerUser }>('PATCH', `/api/admin/users/${uid}`, patch),
  inviteUser: (body: { email: string; password: string; display_name?: string; is_admin?: boolean }) =>
    request<{ user: WorktrackerUser }>('POST', '/api/admin/users/invite', body),

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

  // Slice 6+7: wizard + analytics.
  inviteConnector: (name: string) =>
    request<{
      protocol: { name: string; display_name: string; blurb: string; install_steps: string[] };
      bearer: string;
      endpoint: string;
      verify_command: string;
    }>('POST', `/api/connectors/${encodeURIComponent(name)}/invite`),
  listCallTraces: (q: { outcome?: string; agent?: string; tool?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined && v !== '') params.set(k, String(v));
    }
    const qs = params.toString();
    return request<{
      traces: Array<{
        id: string;
        ts: string;
        agent: string;
        bearer_id: string;
        tool?: string;
        outcome: string;
        response?: { status: number; latency_ms: number };
        error?: { code: number; message: string };
      }>;
      next_cursor: string | null;
      summary: { total: number; success: number; auth_failed: number; server_error: number; client_error: number };
    }>('GET', `/api/analytics/call-traces${qs ? `?${qs}` : ''}`);
  },
  callTracesSummary: () =>
    request<{ summary: { total: number; success: number; auth_failed: number; server_error: number; client_error: number } }>(
      'GET',
      '/api/analytics/call-traces/summary',
    ),
};

// Re-export the kinds the UI cares about for tight imports.
export type { Client, ClientKind, ClientManifest, Connector, ConnectorKind };
