/**
 * Per-kind transition graph — the single source of truth for which
 * `WorkItem.status` moves are legal. The brain (server-side gate) and
 * the kanban page (column-greyout hint) both import this file; one
 * graph, one set of edges, no drift.
 *
 * Slice 3. Before this, the kanban accepted every drop and the brain
 * re-validated the status field separately; the failure mode was
 * "drop did nothing, silently". Now: the page greys out columns the
 * item can't move to, and the brain returns a structured reason
 * (`error.code: 'invalid_transition'`) if a tool call tries anyway.
 *
 * Adding a new kind or status:
 *   1. Add the status to `packages/types/src/index.ts` (the
 *      TASK_STATUSES / TICKET_STATUSES / … list).
 *   2. Add a row to EDGES below.
 *   3. The compiler will then enforce that every status has a row.
 */

import type { WorkItemKind, WorkItemStatus } from './index.js';

/**
 * The transition graph, one row per (kind, from-status) listing the
 * legal `to_status` values. The keys must be exhaustive — a status
 * that's missing from EDGES is treated as terminal (no outgoing
 * moves). Use `null` to mark a row as a sink; nothing moves out.
 */
type Edges = Record<WorkItemKind, Partial<Record<WorkItemStatus, WorkItemStatus[]>>>;

const EDGES: Edges = {
  task: {
    open:        ['ready', 'in_progress', 'blocked', 'done', 'cancelled'],
    ready:       ['open', 'in_progress', 'blocked', 'done', 'cancelled'],
    in_progress: ['ready', 'blocked', 'done', 'cancelled'],
    blocked:     ['ready', 'in_progress', 'done', 'cancelled'],
    done:        ['ready', 'in_progress'],
    cancelled:   ['open'],
  },
  ticket: {
    open:        ['triaged', 'in_progress', 'wontfix', 'duplicate'],
    triaged:     ['open', 'in_progress', 'wontfix', 'duplicate'],
    in_progress: ['triaged', 'resolved', 'wontfix'],
    resolved:    ['in_progress'],
    wontfix:     ['open'],
    duplicate:   ['open'],
  },
  decision: {
    proposed:    ['accepted', 'rejected', 'superseded'],
    accepted:    ['superseded'],
    superseded:  [],
    rejected:    ['proposed'],
  },
  review: {
    pending:             ['changes_requested', 'approved', 'closed'],
    changes_requested:   ['pending', 'closed'],
    approved:            ['merged', 'closed'],
    merged:              ['closed'],
    closed:              [],
  },
};

/**
 * The structured reason returned when `canTransition` rejects a move.
 * The web renders it inside the mono `[err]` block; the brain
 * records it on the `commands/{id}/failures/{id}` sub-doc.
 */
export interface TransitionRejection {
  code: 'invalid_transition';
  message: string;
  from: WorkItemStatus;
  to: WorkItemStatus;
  kind: WorkItemKind;
  /** The legal `to_status` values for the (kind, from) pair. */
  allowed: WorkItemStatus[];
}

export type TransitionResult =
  | { ok: true }
  | { ok: false; reason: TransitionRejection };

/**
 * The transition gate. The single check every transition path
 * (MCP `transition` tool, REST `POST /api/items/:id/transition`,
 * the brain's eval, the kanban page's greyout) calls.
 *
 * `from` and `to` are checked against `kind` — moving a task
 * from `open` to `merged` is wrong on two counts (the status
 * doesn't exist for tasks, AND it isn't a legal outgoing edge).
 */
export function canTransition(
  from: WorkItemStatus,
  to: WorkItemStatus,
  kind: WorkItemKind,
): TransitionResult {
  // Same-status is a no-op, not a transition. We let it through
  // so the kanban drop on the current column is a quiet success.
  if (from === to) return { ok: true };
  const allowed = getValidTransitions(from, kind);
  if (allowed.includes(to)) return { ok: true };
  return {
    ok: false,
    reason: {
      code: 'invalid_transition',
      message:
        allowed.length === 0
          ? `${kind} item in status '${from}' is terminal; no outgoing moves.`
          : `${kind} item cannot move from '${from}' to '${to}'. Allowed: ${allowed.join(', ') || '(none)'}.`,
      from,
      to,
      kind,
      allowed,
    },
  };
}

/**
 * The set of legal next-status values for the (kind, from) pair.
 * Returns an empty array for terminal statuses (nothing moves out).
 * The kanban page uses this to grey out columns the current item
 * can't drop into.
 */
export function getValidTransitions(
  from: WorkItemStatus,
  kind: WorkItemKind,
): WorkItemStatus[] {
  return EDGES[kind]?.[from] ?? [];
}

/**
 * Convenience: is the given status terminal for the given kind?
 * A terminal status has no outgoing edges. Used by the dispatch
 * tool to decide whether a "completion" event should be fired.
 */
export function isTerminal(status: WorkItemStatus, kind: WorkItemKind): boolean {
  return getValidTransitions(status, kind).length === 0;
}
