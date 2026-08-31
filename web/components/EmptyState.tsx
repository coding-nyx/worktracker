'use client';

import type { ReactNode } from 'react';

export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="card-inset flex flex-col items-center gap-3 px-6 py-10 text-center">
      {icon && (
        <span aria-hidden className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-border-subtle bg-bg-raised text-ink-2">
          {icon}
        </span>
      )}
      <h3 className="text-sm font-semibold text-ink-1">{title}</h3>
      {body && <p className="max-w-md text-[13px] leading-5 text-ink-2">{body}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
