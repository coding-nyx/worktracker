'use client';

import { useEffect } from 'react';

/**
 * Route-level error boundary. Cyberpunk error treatment —
 * mono caps, magenta-bordered card, primary action in cyan.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface to whatever error reporter the project uses.
    // For now: log to the browser console; the user sees the
    // visible card with the digest and a "Try again" action.
    // eslint-disable-next-line no-console
    console.error('[worktracker/error.tsx]', error);
  }, [error]);

  return (
    <div className="-mx-5 -mt-6 flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-5 sm:-mx-8">
      <div className="card-raised w-full max-w-2xl space-y-5 p-7">
        <div className="flex items-center gap-2">
          <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-danger" />
          <span className="eyebrow text-danger">// err · unhandled</span>
        </div>
        <h1
          className="font-semibold tracking-tight text-ink-1"
          style={{ fontSize: 'clamp(28px, 4vw, 40px)', lineHeight: 1.05, letterSpacing: '-0.015em' }}
        >
          Something went <span className="text-magenta-500">sideways</span>.
        </h1>
        <p className="font-mono text-[12px] leading-5 text-ink-2">
          <span className="mr-2 inline-block text-ink-3">[err]</span>
          {error.message || 'unknown error'}
          {error.digest ? (
            <span className="ml-2 text-ink-4">digest: {error.digest}</span>
          ) : null}
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            onClick={reset}
            className="btn-primary focus-ring"
          >
            Try again
          </button>
          <a href="/" className="btn-secondary focus-ring">
            Back to kanban
          </a>
        </div>
      </div>
    </div>
  );
}
