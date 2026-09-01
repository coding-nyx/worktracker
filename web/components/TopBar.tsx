'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ThemeToggle } from './ThemeToggle';
import { useAuth } from '../lib/auth';
import { useChatUi } from '../app/providers';

const NAV = [
  { href: '/',          label: 'Kanban' },
  { href: '/sources',   label: 'Sources' },
  { href: '/admin',     label: 'Connectors' },
] as const;

const ADMIN_NAV: { href: string; label: string }[] = [
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/boards', label: 'Boards' },
];

export function TopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const auth = useAuth();
  const chat = useChatUi();
  const [signingOut, setSigningOut] = useState(false);

  async function onSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await auth.signOut();
      router.replace('/login');
    } finally {
      setSigningOut(false);
    }
  }

  const isAdmin = auth.isAdmin;

  return (
    <header className="sticky top-0 z-40 border-b border-border-subtle bg-bg-base/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-6 px-5 sm:px-8">
        <Link
          href="/"
          className="focus-ring -m-1 flex items-center gap-2 rounded-md p-1 transition-colors hover:opacity-90"
          aria-label="WorkTracker home"
        >
          <BrandMark />
          <span className="text-[15px] font-semibold tracking-tight text-ink-1">WorkTracker</span>
        </Link>
        <nav className="flex items-center gap-1">
          {NAV.map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname?.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-link focus-ring ${active ? 'nav-link-active bg-bg-raised' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                {item.label}
              </Link>
            );
          })}
          {isAdmin ? (
            <>
              <span aria-hidden className="mx-1 h-4 w-px bg-border-subtle" />
              {ADMIN_NAV.map((item) => {
                const active = pathname?.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`nav-link focus-ring ${active ? 'nav-link-active bg-bg-raised' : ''}`}
                    aria-current={active ? 'page' : undefined}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </>
          ) : null}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {auth.firebaseUser ? (
            <>
              <button
                type="button"
                onClick={chat.toggle}
                aria-label="Open AI assistant"
                aria-pressed={chat.open}
                className={`focus-ring inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1.5 text-[12.5px] font-medium transition-colors ${
                  chat.open ? 'bg-brand-500/15 text-brand-500' : 'bg-bg-raised text-ink-2 hover:bg-bg-sunken'
                }`}
                title="WorkTracker AI"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 2 14 8.5 21 9.5 16 14 17.5 21 12 17.5 6.5 21 8 14 3 9.5 10 8.5z" />
                </svg>
                AI
              </button>
              <Link
                href="/settings"
                className={`nav-link focus-ring ${pathname === '/settings' ? 'nav-link-active bg-bg-raised' : ''}`}
              >
                Settings
              </Link>
              <button
                type="button"
                onClick={onSignOut}
                disabled={signingOut}
                className="btn-ghost focus-ring text-[13px] text-ink-2 disabled:opacity-50"
                title={auth.firebaseUser.email ?? 'Sign out'}
              >
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </>
          ) : null}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

function BrandMark() {
  return (
    <span
      aria-hidden
      className="relative inline-flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-glow"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4Z" />
        <path d="M13 5v2" /><path d="M13 17v2" /><path d="M13 11v2" />
      </svg>
    </span>
  );
}
