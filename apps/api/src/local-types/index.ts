/**
 * Shared types for WorkTracker. This package is the contract
 * between the backend, the Next.js UI, the Mac daemon, and any
 * connector implementation. Bump the version when these change.
 */

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
// Source manifest and registration
// =====================================================================

export const SOURCE_KINDS = ['agent', 'human', 'system', 'webhook'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

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

export interface SourceManifest {
  name: string;
  display_name: string;
  kind: SourceKind;
  capabilities: Capability[];
  webhook_url?: string | null;
  icon?: string | null;
  version: string;
  enricher?: {
    grill?: EnricherConfig;
    wayfind?: EnricherConfig;
  };
}

export interface SourceRegistration {
  name: string;
  display_name: string;
  kind: SourceKind;
  manifest: SourceManifest;
  capabilities: Capability[];
  webhook_secret: string | null;
  enabled: boolean;
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  /** Stored alongside the document but not exposed in API responses. */
  api_key_hash?: string;
  /** API key, returned exactly once at creation time. */
  api_key?: string;
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
    error: string | null;
    applied_event_id: string | null;
    created_at: string;
    applied_at: string | null;
    /** Number of times the brain has attempted and failed. */
    failure_count: number;
    /** When the brain gave up (status = failed). */
    failed_at: string | null;
  };
};

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
  manifest: SourceManifest;
  /** Optional initial API key; if absent, one is generated. */
  api_key?: string;
}

export interface CreateSourceResponse {
  source: SourceRegistration;
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
