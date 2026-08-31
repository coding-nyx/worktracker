'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ThemeToggle } from './ThemeToggle';

const NAV = [
  { href: '/',          label: 'Kanban' },
  { href: '/sources',   label: 'Sources' },
  { href: '/admin',     label: 'Connectors' },
] as const;

export function TopBar() {
  const pathname = usePathname();
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
        </nav>
        <div className="ml-auto flex items-center gap-2">
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
