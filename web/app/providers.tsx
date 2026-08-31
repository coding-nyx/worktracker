'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setCredentials as setApiCredentials } from '../lib/api';

/**
 * Event name the credentials bootstrap fires after writing the
 * parsed hash to localStorage. Pages that already mounted (and
 * cached an empty `hasCreds` state in their own useEffect) can
 * listen for this and re-check.
 */
export const CREDENTIALS_BOOTSTRAPPED_EVENT = 'worktracker:credentials-bootstrapped';

/**
 * URL-hash based credential bootstrap. Lets the operator deep-link
 * `https://worktracker-prod-2026.web.app/#apiBase=…&token=…` and
 * land on the kanban pre-signed in. After reading, the hash is
 * stripped from the URL so the token isn't visible in browser
 * history or shared screenshots.
 *
 * Also doubles as a way to drive the UI from automation: scripts
 * can navigate to the app with the hash set and skip the
 * `window.prompt()`-based sign-in flow entirely.
 */
function bootstrapCredentialsFromHash() {
  if (typeof window === 'undefined') return;
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return;
  const params = new URLSearchParams(hash);
  const apiBase = params.get('apiBase');
  const token = params.get('token');
  if (apiBase && token) {
    setApiCredentials(apiBase, token);
    // Pages may have already rendered with `hasCreds=false`
    // before the bootstrap wrote to localStorage. Notify them
    // so they can re-check instead of waiting for a manual
    // reload.
    window.dispatchEvent(new Event(CREDENTIALS_BOOTSTRAPPED_EVENT));
  }
  // Always strip the hash once processed so the token doesn't
  // linger in the URL bar or leak via copy/paste.
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

export function Providers({ children }: { children: ReactNode }) {
  // Per-mount so SSR and client get separate clients. The
  // QueryClient is created once on mount, then reused.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: false },
        },
      }),
  );
  useEffect(() => {
    bootstrapCredentialsFromHash();
  }, []);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
