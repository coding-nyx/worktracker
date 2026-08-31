'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setCredentials as setApiCredentials } from '../lib/api';
import { ThemeProvider } from '../components/ThemeToggle';

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
 *
 * Runs SYNCHRONOUSLY at module load time (not in a useEffect).
 * This matters because pages like the kanban fire their first
 * `useQuery` for the REST snapshot in their own useEffect; if
 * we run the bootstrap in the Providers' useEffect too, React
 * runs child effects before parent effects, so the page's
 * query fires BEFORE the bootstrap writes to localStorage. The
 * query then issues a request with no Authorization header, gets
 * a 401, and TanStack Query caches the failure — never retrying
 * after the credentials land a microtask later. Running the
 * bootstrap synchronously at module load means the credentials
 * are in localStorage before any component renders, so the
 * first query already has them.
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
    // Notify any pages that already mounted with an empty
    // `hasCreds` state so they can re-check.
    window.dispatchEvent(new Event(CREDENTIALS_BOOTSTRAPPED_EVENT));
  }
  // Always strip the hash once processed so the token doesn't
  // linger in the URL bar or leak via copy/paste.
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

// Run synchronously at module load. Safe on the server —
// the function no-ops when `window` is undefined.
bootstrapCredentialsFromHash();

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
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}
