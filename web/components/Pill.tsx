'use client';

import type { ReactNode } from 'react';

export type StatusKind = 'backlog' | 'ready' | 'progress' | 'blocked' | 'review' | 'done';

const KIND_CLASSES: Record<StatusKind, string> = {
  backlog:  'bg-status-backlog-50  text-status-backlog-600  ring-status-backlog-500/40',
  ready:    'bg-status-ready-50    text-status-ready-600    ring-status-ready-500/40',
  progress: 'bg-status-progress-50 text-status-progress-600 ring-status-progress-500/40',
  blocked:  'bg-status-blocked-50  text-status-blocked-600  ring-status-blocked-500/40',
  review:   'bg-status-review-50   text-status-review-600   ring-status-review-500/40',
  done:     'bg-status-done-50     text-status-done-600     ring-status-done-500/40',
};

const KIND_DOT: Record<StatusKind, string> = {
  backlog:  'bg-status-backlog-500',
  ready:    'bg-status-ready-500',
  progress: 'bg-status-progress-500',
  blocked:  'bg-status-blocked-500',
  review:   'bg-status-review-500',
  done:     'bg-status-done-500',
};

export function Pill({
  kind,
  children,
  dot = true,
  className = '',
}: {
  kind: StatusKind;
  children: ReactNode;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span className={`pill ${KIND_CLASSES[kind]} ${className}`}>
      {dot && <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${KIND_DOT[kind]}`} />}
      {children}
    </span>
  );
}

/** Map a `WorkItemStatus` string from the API to a Pill kind. */
export function statusToPillKind(status: string): StatusKind {
  if (status.startsWith('task.done') || status.startsWith('ticket.resolved') || status.startsWith('ticket.closed')) return 'done';
  if (status.startsWith('task.in_progress') || status.startsWith('ticket.in_progress')) return 'progress';
  if (status.startsWith('task.review') || status.startsWith('ticket.review')) return 'review';
  if (status.startsWith('task.ready')) return 'ready';
  if (status.startsWith('task.blocked') || status.startsWith('ticket.blocked')) return 'blocked';
  return 'backlog';
}
