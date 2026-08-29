import type { Metadata, Viewport } from 'next';
import './globals.css';
import Link from 'next/link';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'WorkTracker',
  description: 'Unified work tracker across every tool you work in.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <Providers>
          <header className="border-b border-slate-200 bg-white">
            <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
              <Link href="/" className="flex items-center gap-2 text-slate-900">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-brand-600">
                  <path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4Z" />
                  <path d="M13 5v2" />
                  <path d="M13 17v2" />
                  <path d="M13 11v2" />
                </svg>
                <span className="text-base font-semibold tracking-tight">WorkTracker</span>
              </Link>
              <nav className="flex items-center gap-1 text-sm">
                <NavLink href="/">Kanban</NavLink>
                <NavLink href="/sources">Sources</NavLink>
                <NavLink href="/admin">Connectors</NavLink>
              </nav>
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
        </Providers>
      </body>
    </html>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded px-3 py-1.5 text-slate-700 transition-colors hover:bg-slate-100"
    >
      {children}
    </Link>
  );
}
