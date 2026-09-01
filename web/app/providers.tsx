'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../components/ThemeToggle';
import { AuthProvider, useAuth } from '../lib/auth';
import { ChatPanel } from '../components/ChatPanel';

/**
 * Event name the credentials bootstrap fires after writing the
 * parsed hash to localStorage. Pages that already mounted (and
 * cached an empty `hasCreds` state in their own useEffect) can
 * listen for this and re-check.
 *
 * @deprecated The deep-link hash bootstrap predates Firebase
 * Auth. It still works for source-bearer flows (operator
 * scripts, MCP) but is no longer the primary sign-in path.
 * Retained for backward compatibility.
 */
export const CREDENTIALS_BOOTSTRAPPED_EVENT = 'worktracker:credentials-bootstrapped';

// Public paths that don't require Firebase Auth.
const PUBLIC_PATHS = new Set<string>(['/login']);

// ----- AI chat open/close -----
// The chat panel is global UI; the open state is lifted here so
// the top-bar launcher and the panel can both read/write it
// without prop-drilling.
interface ChatUi {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
}
const ChatContext = createContext<ChatUi | null>(null);
export function useChatUi(): ChatUi {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChatUi must be used inside <Providers>');
  return ctx;
}
function ChatHost({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((v) => !v);
  return (
    <ChatContext.Provider value={{ open, setOpen, toggle }}>
      {children}
      <ChatPanel open={open} onClose={() => setOpen(false)} />
    </ChatContext.Provider>
  );
}

function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const pathname = usePathname() ?? '/';
  const router = useRouter();

  // Redirect to /login when not signed in (and not already on a
  // public path). Done as a side effect so the gate stays a
  // pure render — the page itself decides what to show.
  useEffect(() => {
    if (auth.isLoading) return;
    if (auth.firebaseUser) return;
    if (PUBLIC_PATHS.has(pathname)) return;
    const next = encodeURIComponent(pathname + (typeof window !== 'undefined' ? window.location.search : ''));
    router.replace(`/login?next=${next}`);
  }, [auth.isLoading, auth.firebaseUser, pathname, router]);

  if (auth.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-base text-ink-3">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand-500" />
          Loading session…
        </div>
      </div>
    );
  }

  return <>{children}</>;
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
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <AuthGate>
            <ChatHost>{children}</ChatHost>
          </AuthGate>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
