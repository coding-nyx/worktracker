'use client';

import Link from 'next/link';

/**
 * 404 — cyberpunk brand stage, mirror of /login's left panel.
 */
export default function NotFound() {
  return (
    <div className="-mx-5 -mt-6 flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-5 sm:-mx-8">
      <div className="grid w-full max-w-3xl gap-8 md:grid-cols-2">
        <div className="space-y-4">
          <span className="eyebrow">// 404 · route not found</span>
          <h1
            className="font-semibold tracking-tight text-ink-1"
            style={{ fontSize: 'clamp(48px, 7vw, 96px)', lineHeight: 1.02, letterSpacing: '-0.02em' }}
          >
            4<span className="text-brand-500">0</span>4
          </h1>
          <p className="font-mono text-[12px] uppercase tracking-mono-wide text-ink-3">
            // the route you requested does not exist
          </p>
        </div>
        <div className="flex flex-col justify-center space-y-3">
          <p className="text-[14px] leading-6 text-ink-2">
            Either the URL is wrong, the item was deleted, or the
            link in the message that brought you here has gone
            stale. The brain and the live subscription are both
            still running — your work is safe.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href="/" className="btn-primary focus-ring">
              ← Back to kanban
            </Link>
            <Link href="/sources" className="btn-secondary focus-ring">
              Sources
            </Link>
            <Link href="/admin" className="btn-secondary focus-ring">
              Admin
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
