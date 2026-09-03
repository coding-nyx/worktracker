/**
 * Shared types for WorkTracker. This package is the contract
 * between the backend, the Next.js UI, the Mac daemon, and any
 * connector implementation. Bump the version when these change.
 */

export {
  canTransition,
  getValidTransitions,
  isTerminal,
} from './state-machine.js';
export type { TransitionRejection, TransitionResult } from './state-machine.js';

// =====================================================================
// Work item kinds and status enums
// =====================================================================

export const WORK_ITEM_KINDS = ['task', 'ticket', 'decision', 'review'] as const;
export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];

export const TASK_STATUSES = [
  'open',
  'ready',
  'in_progress',
  'blocked',
  'done',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TICKET_STATUSES = [
  'open',
  'triaged',
  'in_progress',
  'resolved',
  'wontfix',
  'duplicate',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const DECISION_STATUSES = [
  'proposed',
  'accepted',
  'superseded',
  'rejected',
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const REVIEW_STATUSES = [
  'pending',
  'changes_requested',
  'approved',
  'merged',
  'closed',
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const PRIORITIES = ['low', 'medium', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];

export type WorkItemStatus = TaskStatus | TicketStatus | DecisionStatus | ReviewStatus;

// =====================================================================
// Enrichment state (Grill + Wayfind)
// =====================================================================

export const ENRICHMENT_STAGES = ['grill', 'wayfind'] as const;
export type EnrichmentStage = (typeof ENRICHMENT_STAGES)[number];

export type EnrichmentStatus = 'complete' | 'in_progress' | 'failed' | 'skipped';

export interface GrillState {
  at?: string; // ISO 8601
  by?: string; // source name
  status?: EnrichmentStatus;
  summary?: string;
  question_count?: number;
  gap_count?: number;
  body_hash_at_grill?: string; // sha256
}

export interface WayfindState {
  at?: string;
  by?: string;
  status?: EnrichmentStatus;
  summary?: string;
  files?: string[];
  dependency_count?: number;
  body_hash_at_wayfind?: string; // sha256
}

export interface EnrichmentState {
  grill?: GrillState;
  wayfind?: WayfindState;
}

// =====================================================================
// Per-kind rich `data` shape (slice 3)
// =====================================================================
//
// `WorkItem.data` is the typed, per-kind structured payload. The
// shape is validated strictly on write (see `apps/api/src/data-schemas.ts`)
// so the detail view can render it without "any" escape hatches.
// The shapes are intentionally narrow — the free-form `data_map`
// is the "everything else" bucket (sprint, team, capacity, etc.).

export interface TaskData {
  estimate_minutes?: number;
  acceptance_criteria?: string[];
  tags?: string[];
}

export interface TicketData {
  severity: Severity;
  customer?: string;
  reproduction?: string;
}

export interface DecisionOption {
  id: string;
  title: string;
  body?: string;
}

export interface DecisionData {
  options: DecisionOption[];
  chosen_option_id?: string;
  rationale?: string;
}

export type ReviewVerdict = 'approve' | 'request_changes' | 'comment';

export interface ReviewData {
  reviewer?: string;
  rubric?: string;
  verdict?: ReviewVerdict;
}

/**
 * The free-form data_map: scalar values only (string | number |
 * boolean | null). It's the escape hatch for fields the per-kind
 * schema doesn't know about. Indexed in Firestore for filter/sort.
 */
export type WorkItemDataMapValue = string | number | boolean | null;
export type WorkItemDataMap = Record<string, WorkItemDataMapValue>;

/**
 * A structured analysis result produced by the Enricher (Grill +
 * Wayfind). The `sections` array lets a long analysis stay scannable
 * — each section is a labeled block the detail view can render as
 * a card.
 */
export interface AnalysisSection {
  heading: string;
  body: string;
}

export interface WorkItemAnalysis {
  summary: string;
  sections: AnalysisSection[];
}

/**
 * A file attached to a work item. The actual bytes live in the
 * `files/{file_id}` collection (1 MB max per file, 10 MB max per
 * item) — the work item only stores the pointer + metadata so the
 * kanban list query stays cheap.
 */
export interface WorkItemFile {
  file_id: string;
  name: string;
  content_type: string;
  size_bytes: number;
  added_at: string;
  /** sha256 of the file content, for dedup. */
  content_sha256?: string;
}

/** Stored at `files/{file_id}`. The `content_b64` is the only field
 *  that makes the doc large; everything else is metadata for the
 *  listing endpoint. */
export interface FileRecord {
  file_id: string;
  name: string;
  content_type: string;
  size_bytes: number;
  content_b64: string;
  owner_item_id: string | null;
  uploaded_by: string;
  uploaded_at: string;
  content_sha256?: string;
}

// =====================================================================
// Work item document
// =====================================================================

export interface WorkItem {
  id: string; // ULID
  kind: WorkItemKind;
  title: string;
  body: string | null;
  status: WorkItemStatus;
  severity: Severity | null;
  priority: Priority | null;
  source: string;
  source_id: string | null;
  source_meta: Record<string, unknown>;
  owner: string | null;
  enricher: string | null;
  enrichment_state: EnrichmentState | null;
  due_at: string | null; // ISO 8601
  parent_id: string | null;
  group_id: string | null;
  archived_at: string | null;
  // Slice 3 — rich data + board association
  /**
   * The board this item belongs to, or `null` for the Backlog.
   * Slice 3: items are no longer filter-by-kind on the board; they
   * are owned by a specific board (or the un-boarded backlog).
   */
  board_id: string | null;
  /** Strict per-kind typed payload. Validated on every write. */
  data: Record<string, unknown>;
  /** Free-form scalar key/value map. Filter / sort key bag. */
  data_map: WorkItemDataMap;
  /** Pointer into `files/{file_id}` for the implementation plan. */
  plan_file_id: string | null;
  /** Structured analysis from Grill/Wayfind. */
  analysis: WorkItemAnalysis | null;
  /** Attachments (≤1 MB each, ≤10 MB per item). Pointers into
   *  `files/{file_id}`; the doc body is the metadata. */
  files: WorkItemFile[];
  created_at: string;
  updated_at: string;
  version: number; // optimistic concurrency
}

// =====================================================================
// Work item events
// =====================================================================

export const EVENT_KINDS = [
  'status_change',
  'comment',
  'assignment',
  'created',
  'updated',
  'linked',
  'unlinked',
  'archived',
  'clarification_added',
  'solution_recorded',
  'dependency_mapped',
  'enrichment_started',
  'enrichment_completed',
  'enrichment_failed',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface WorkItemEvent {
  id: string;
  item_id: string;
  kind: EventKind;
  actor: string; // 'source:hermes' | 'source:web' | 'user:name'
  body: string | null;
  from_status: WorkItemStatus | null;
  to_status: WorkItemStatus | null;
  field: string | null;
  from_value: unknown;
  to_value: unknown;
  command_id: string | null;
  source_event_id: string | null;
  enrichment_stage: EnrichmentStage | null;
  created_at: string;
}

// =====================================================================
// =====================================================================
// Clients — slice 2
// =====================================================================
//
// One `clients/{name}` document per authenticated identity that calls
// the API. The `kind` discriminator picks the auth shape:
//   - `kind: 'agent'`  — bearer is `<name>.<random_key>`, scrypt-hashed
//   - `kind: 'user'`   — bearer is `wt_<random_32byte_id>`, the id IS
//                        the credential (256 bits of entropy)
//
// The `api_tokens` collection is gone. Personal access tokens are
// `clients` rows with `kind: 'user'`. The web UI's `ApiTokensSection`
// becomes "Your personal clients" — a filtered view of this collection.

export const CLIENT_KINDS = ['agent', 'user'] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

export const CORE_CAPABILITIES = [
  'create',
  'update',
  'transition',
  'comment',
  'link',
] as const;
export type CoreCapability = (typeof CORE_CAPABILITIES)[number];

export const ENRICHMENT_CAPABILITIES = [
  'enrich:grill',
  'enrich:wayfind',
] as const;
export type EnrichmentCapability = (typeof ENRICHMENT_CAPABILITIES)[number];

export type Capability = CoreCapability | EnrichmentCapability | string;

export interface EnricherConfig {
  kind: 'skill';
  skill_path: string;
  command: string;
}

export interface ClientManifest {
  name: string;
  display_name: string;
  kind: ClientKind;
  capabilities: Capability[];
  webhook_url?: string | null;
  icon?: string | null;
  version: string;
  enricher?: {
    grill?: EnricherConfig;
    wayfind?: EnricherConfig;
  };
}

export interface Client {
  name: string;
  display_name: string;
  kind: ClientKind;
  /**
   * Effective permission scope. The auth middleware reads this
   * (`getEffectiveScope`) so `tools/list` is filtered per-token
   * and `tools/call` fails closed for out-of-scope requests.
   * Declared at registration; rotatable by an admin; never
   * downscoped silently.
   */
  scope: ApiTokenScope;
  /** Firebase uid of the owning user, or null for system agents. */
  owner_uid: string | null;
  /** Mirrored email for the owning user, used in admin UIs. */
  owner_email?: string | null;
  manifest: ClientManifest;
  capabilities: Capability[];
  webhook_secret: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  rotated_at: string | null;
  /**
   * Soft-delete; a revoked client still resolves to a doc but
   * `requireSource` rejects it. Only meaningful for `kind: 'user'`.
   */
  revoked_at: string | null;
  /**
   * Scrypt hash of the bearer, only for `kind: 'agent'`. The bearer
   * plaintext is `<name>.<random_key>`; the hash is
   * `scrypt$<salt-hex>$<derived-hex>`. Null for `kind: 'user'`.
   */
  api_key_hash?: string | null;
  /**
   * Random 32-byte id, only for `kind: 'user'`. The bearer is
   * `wt_<bearer_id>`; knowing the bearer_id IS the credential.
   */
  bearer_id?: string | null;
  /**
   * Plaintext bearer, returned exactly once at creation or
   * rotation time. Never persisted.
   */
  bearer?: string;
  // Legacy / connector-shaped fields (kept for sources that
  // predate the client/connector split; will move to `connectors/`
  // in a follow-up).
  last_sync_at?: string | null;
  last_error?: string | null;
}

// =====================================================================
// Connectors — slice 2
// =====================================================================
//
// An integration the API talks to. A `Client` is an authenticated
// identity that calls us; a `Connector` is a system we call (mirror,
// webhook-in, webhook-out, bridge). Hermes is both — `clients/hermes`
// is its bearer, `connectors/hermes` is its integration config.

export const CONNECTOR_KINDS = [
  'mirror',
  'webhook-in',
  'webhook-out',
  'bridge',
] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export type ConnectorStatus = 'ok' | 'error' | null;

export interface Connector {
  name: string;
  kind: ConnectorKind;
  /** Protocol sub-kind, e.g. 'hermes-cli-v1' | 'webhook-json-v1'. */
  protocol: string;
  /** Kind-specific configuration (e.g. hermesBin, webhookUrl). */
  config: Record<string, unknown>;
  enabled: boolean;
  last_run_at: string | null;
  last_status: ConnectorStatus;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListClientsResponse {
  clients: Client[];
}

export interface CreateClientRequest {
  manifest: ClientManifest;
  /** Optional initial bearer; absent means one is generated. */
  bearer?: string;
  /** Scope defaults to `read_write`. Admin tokens can request `admin`. */
  scope?: ApiTokenScope;
  /** Firebase uid of the owning user, for `kind: 'user'`. */
  owner_uid?: string;
  owner_email?: string;
}

export interface CreateClientResponse {
  client: Client;
  /** Plaintext bearer, shown exactly once. */
  bearer: string;
}

export interface RotateClientResponse {
  client: Client;
  /** New plaintext bearer; the old one is invalidated. */
  bearer: string;
}

export interface IntrospectClientResponse {
  name: string;
  kind: ClientKind;
  scope: ApiTokenScope;
  owner_uid: string | null;
  last_used_at: string | null;
  capabilities: Capability[];
  server_version: string;
  /** The list of tool names this client can call. */
  visible_tools: string[];
}

export interface ListConnectorsResponse {
  connectors: Connector[];
}

// =====================================================================
// Users (Firebase Auth-backed)
// =====================================================================

/**
 * Per-user record stored at `users/{firebase_uid}`. Created
 * lazily on first sign-in (see auth.ts). The first user to
 * sign in becomes admin; subsequent users default to non-admin
 * and require an existing admin to promote them.
 *
 * The Firebase Auth ID token's `sub` is the document ID; the
 * ID token's `email` claim is mirrored here for display.
 */
export interface WorktrackerUser {
  firebase_uid: string;
  email: string;
  display_name: string | null;
  is_admin: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
}

// =====================================================================
// Commands (the brain's input)
// =====================================================================

export const COMMAND_OPS = [
  'create',
  'update',
  'transition',
  'comment',
  'link',
  'unlink',
  'archive',
  'enrich',
] as const;
export type CommandOp = (typeof COMMAND_OPS)[number];

export const COMMAND_STATUSES = [
  'queued',
  'evaluating',
  'applied',
  'rejected',
  'failed',
] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

export interface CommandPayloadMap {
  create: CreateCommandPayload;
  update: UpdateCommandPayload;
  transition: TransitionCommandPayload;
  comment: CommentCommandPayload;
  link: LinkCommandPayload;
  unlink: UnlinkCommandPayload;
  archive: ArchiveCommandPayload;
  enrich: EnrichCommandPayload;
}

export interface CreateCommandPayload {
  kind: WorkItemKind;
  title: string;
  body?: string;
  status?: WorkItemStatus;
  severity?: Severity;
  priority?: Priority;
  source_id?: string;
  source_meta?: Record<string, unknown>;
  owner?: string;
  due_at?: string;
  parent_id?: string;
  group_id?: string;
  /** Slice 3 — which board this item belongs to. Omit for Backlog. */
  board_id?: string | null;
  /** Slice 3 — per-kind typed payload. Validated against the kind's
   *  Zod schema (`apps/api/src/data-schemas.ts`) on every write. */
  data?: Record<string, unknown>;
  /** Slice 3 — free-form scalar key/value map. */
  data_map?: WorkItemDataMap;
}

export interface UpdateCommandPayload {
  patch: Partial<
    Pick<
      WorkItem,
      | 'title'
      | 'body'
      | 'severity'
      | 'priority'
      | 'owner'
      | 'due_at'
      | 'parent_id'
      | 'group_id'
      | 'enricher'
      | 'source_meta'
      | 'board_id'
      | 'data'
      | 'data_map'
      | 'plan_file_id'
    >
  >;
  expected_version: number;
}

export interface TransitionCommandPayload {
  to_status: WorkItemStatus;
  comment?: string;
  force_dispatch?: boolean;
  expected_version: number;
}

export interface CommentCommandPayload {
  body: string;
  /** Optional for comments; a comment doesn't bump the version. */
  expected_version?: number;
}

export interface LinkCommandPayload {
  child_id: string;
  kind: 'depends_on' | 'blocks' | 'related' | 'mirrors' | 'parent_of';
}

export interface UnlinkCommandPayload {
  child_id: string;
  kind: 'depends_on' | 'blocks' | 'related' | 'mirrors' | 'parent_of';
}

export interface ArchiveCommandPayload {
  expected_version: number;
}

export interface EnrichCommandPayload {
  stage: EnrichmentStage | 'both';
  enricher?: string;
}

export type CommandOpByType = {
  [K in keyof CommandPayloadMap]: {
    id: string;
    source: string;
    source_event_id: string | null;
    op: K;
    item_id: string | null;
    payload: CommandPayloadMap[K];
    status: CommandStatus;
    /**
     * Failure payload on a `rejected` or `failed` command. For
     * `rejected` it's a structured `{ code, message }` from the
     * brain's invariants check. For `failed` it's whatever the
     * last unhandled exception produced. `unknown` covers both.
     */
    error: unknown;
    applied_event_id: string | null;
    created_at: string;
    applied_at: string | null;
    /** Number of times the brain has attempted and failed. */
    failure_count: number;
    /** When the brain gave up (status = failed). */
    failed_at: string | null;
    /** When the operator last reset the command via /replay. */
    requeued_at: string | null;
  };
};

/**
 * One recorded brain failure. Stored at
 * `commands/{commandId}/failures/{failureId}` so a long stream of
 * failures doesn't bloat the command document, and so an operator
 * can see the history of a single misbehaving command.
 */
export interface CommandFailure {
  id: string;
  command_id: string;
  attempt: number;
  /** Short error code, e.g. `validation_error`, `internal_error`. */
  code: string;
  message: string;
  /** Optional stack trace, capped to 4KB. */
  stack: string | null;
  occurred_at: string;
}

/**
 * Response shape for `GET /api/commands/:id/failures`. The
 * command-level fields are returned alongside the sub-docs so the
 * UI doesn't need a second round-trip.
 */
export interface CommandFailuresResponse {
  command_id: string;
  status: CommandStatus;
  failure_count: number;
  failed_at: string | null;
  failures: CommandFailure[];
}

export type Command = CommandOpByType[keyof CommandOpByType];

// =====================================================================
// Conflicts
// =====================================================================

export interface Conflict {
  id: string;
  item_id: string;
  command_id: string;
  field: string | null;
  our_value: unknown;
  their_value: unknown;
  reason: string;
  resolved: boolean;
  created_at: string;
}

// =====================================================================
// REST request/response shapes
// =====================================================================

export interface ListItemsQuery {
  kind?: WorkItemKind;
  status?: WorkItemStatus;
  source?: string;
  owner?: string;
  q?: string;
  cursor?: string;
  limit?: number;
  include_archived?: boolean;
  /**
   * Slice 3 — filter by board. Pass an empty string `''` to mean
   * "Backlog" (items with `board_id: null`). The server treats the
   * special string `'null'` (or the empty string) as the Backlog.
   */
  board_id?: string | null;
}

export interface ListItemsResponse {
  items: WorkItem[];
  next_cursor: string | null;
}

export interface TransitionRequest {
  to_status: WorkItemStatus;
  comment?: string;
  force_dispatch?: boolean;
  expected_version: number;
}

export interface LinkRequest {
  child_id: string;
  kind: 'depends_on' | 'blocks' | 'related' | 'mirrors' | 'parent_of';
}

export interface EnrichRequest {
  stage: EnrichmentStage | 'both';
  enricher?: string;
}

export interface CreateSourceRequest {
  manifest: ClientManifest;
  /** Optional initial API key; if absent, one is generated. */
  api_key?: string;
}

export interface CreateSourceResponse {
  source: Client;
  /** Plaintext API key, shown exactly once. */
  api_key: string;
}

// =====================================================================
// MCP tool result shapes
// =====================================================================

export interface McpListItemsArgs extends ListItemsQuery {}
export interface McpGetItemArgs {
  id: string;
}
export interface McpCreateItemArgs extends CreateCommandPayload {}
export interface McpUpdateItemArgs {
  id: string;
  patch: UpdateCommandPayload['patch'];
  expected_version: number;
}
export interface McpTransitionArgs {
  id: string;
  to_status: WorkItemStatus;
  comment?: string;
  force_dispatch?: boolean;
  expected_version: number;
}
export interface McpCommentArgs {
  id: string;
  body: string;
  expected_version?: number;
}
export interface McpLinkItemsArgs {
  parent_id: string;
  child_id: string;
  kind: 'depends_on' | 'blocks' | 'related' | 'mirrors' | 'parent_of';
}
export interface McpSetReminderArgs {
  item_id: string;
  remind_at: string;
  channel: 'apple_reminders' | 'telegram' | 'slack' | 'email';
  target: string;
}
export interface McpEnrichArgs {
  id: string;
  stage: EnrichmentStage | 'both';
  enricher?: string;
}
export interface McpDispatchArgs {
  id: string;
  options?: {
    force?: boolean;
    enricher?: string;
    stages?: ('grill' | 'wayfind')[];
  };
}
export interface McpSearchArgs {
  q: string;
  filters?: ListItemsQuery;
}

// =====================================================================
// Errors
// =====================================================================

export const ERROR_CODES = [
  'invalid_input',
  'unauthorized',
  'forbidden',
  'not_found',
  'version_conflict',
  'rate_limited',
  'internal_error',
  'source_unavailable',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

// =====================================================================
// Boards
// =====================================================================

/**
 * A single column on a Board. The kanban renders one column per
 * entry; `statuses` lists which `WorkItem.status` values land in
 * the column. `kinds` narrows the column to specific work item
 * kinds; if empty, the column shows all kinds.
 */
export interface BoardColumn {
  id: string;
  label: string;
  /** Statuses (across kinds) that bucket into this column. */
  statuses: string[];
  /**
   * If set, the column only shows items of these kinds. Useful
   * for boards that mix kinds (e.g. a "Today" board might bucket
   * tasks into "open" and tickets into "triaged" as the same
   * actionable column).
   */
  kinds?: WorkItemKind[];
}

/**
 * A board is a saved view of the kanban. It pins a list of
 * columns (each with a label and a set of statuses) and an
 * optional kind filter. A user can switch boards in the UI;
 * boards are admin-curated but read-by-everyone.
 */
export interface Board {
  id: string;
  name: string;
  description?: string;
  /**
   * If set, the board only shows items of these kinds. If empty,
   * the board shows all kinds.
   */
  kinds?: WorkItemKind[];
  columns: BoardColumn[];
  /** Whether this board is the default landing view. */
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateBoardRequest {
  name: string;
  description?: string;
  kinds?: WorkItemKind[];
  columns: BoardColumn[];
  is_default?: boolean;
}

export interface UpdateBoardRequest {
  name?: string;
  description?: string;
  kinds?: WorkItemKind[];
  columns?: BoardColumn[];
  is_default?: boolean;
}

export interface ListBoardsResponse {
  boards: Board[];
}

// =====================================================================
// API tokens (personal access tokens for external MCP clients)
// =====================================================================

/**
 * The permission scope of an API token. Enforced at the dispatch
 * layer (`dispatchTool`) so a `read` token literally cannot call
 * any write tool — the server returns an error before the brain
 * ever sees the call.
 *
 * - `read`        — list/get tools only (items, boards)
 * - `read_write`  — read + create/update/transition/comment/link
 * - `admin`       — read+write + board admin (mintable by admins)
 *
 * Existing per-source bearers (the `sources/{name}` collection)
 * keep the legacy `read_write` effective scope; their scope is
 * implicit and not stored in the doc.
 */
export const API_TOKEN_SCOPES = ['read', 'read_write', 'admin'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

/**
 * A personal API token. The bearer plaintext is
 * `wt_<tokenId>`; only the document id (`tokenId`) is stored on
 * the server, so knowing the bearer IS the credential (same model
 * as Stripe / GitHub PATs). Server-side access only; the web app
 * reads through the REST endpoint.
 */
export interface ApiToken {
  /** ULID; also the document id and the lookup key. */
  id: string;
  /** User-provided label, e.g. "Claude Code laptop". */
  name: string;
  /** Firebase UID of the minting user. */
  owner_uid: string;
  /** Mirrored at mint-time for display; refreshes on owner change would be a future migration. */
  owner_email: string;
  scope: ApiTokenScope;
  created_at: string;
  last_used_at: string | null;
  /** Soft delete; a revoked token still resolves to a doc but `requireSource` rejects it. */
  revoked_at: string | null;
}

export interface ListApiTokensResponse {
  tokens: ApiToken[];
}

export interface CreateApiTokenRequest {
  name: string;
  scope: ApiTokenScope;
}

export interface CreateApiTokenResponse {
  token: ApiToken;
  /** Plaintext bearer. Shown exactly once. */
  bearer: string;
}

// =====================================================================
// MCP tool names (slice 4)
// =====================================================================
//
// The 23 tools exposed on `/mcp` and `/mcp/stream`. Each tool's
// name is `worktracker.<namespace>.<verb>`; `tools/list` filters the
// catalog by the bearer's effective scope (read → 7, read_write →
// 16, admin → 23). The "no tool will fail" promise (architecture
// v1 §1) holds because the list filter guarantees the caller can
// see only the tools they can run; `tools/call` re-checks the scope
// as defense in depth.
//
// Adding a tool:
//   1. Add the dotted name to `MCP_TOOL_NAMES` below.
//   2. Add an entry in `apps/api/src/mcp-tools.ts` (registry).
//   3. The typescript `McpToolName` union + the runtime
//      `MCP_TOOL_NAMES` set are the single source of truth.

export const MCP_NAMESPACES = [
  'items',
  'boards',
  'files',
  'clients',
  'connectors',
  'dispatch',
  'enrich',
] as const;
export type McpNamespace = (typeof MCP_NAMESPACES)[number];

export const MCP_TOOL_NAMES = [
  // items (7)
  'worktracker.items.list',
  'worktracker.items.get',
  'worktracker.items.create',
  'worktracker.items.update',
  'worktracker.items.comment',
  'worktracker.items.link',
  'worktracker.items.unlink',
  // boards (5)
  'worktracker.boards.list',
  'worktracker.boards.get',
  'worktracker.boards.create',
  'worktracker.boards.update',
  'worktracker.boards.delete',
  // files (3)
  'worktracker.files.list',
  'worktracker.files.get',
  'worktracker.files.upload',
  // clients (4)
  'worktracker.clients.list',
  'worktracker.clients.mint',
  'worktracker.clients.rotate',
  'worktracker.clients.introspect',
  // connectors (2)
  'worktracker.connectors.list',
  'worktracker.connectors.get',
  // dispatch + enrich (2)
  'worktracker.dispatch.run',
  'worktracker.enrich.run',
] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];
