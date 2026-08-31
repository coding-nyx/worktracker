import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';
import { TopBar } from '../components/TopBar';

export const metadata: Metadata = {
  title: 'WorkTracker',
  description: 'Unified work tracker across every tool you work in.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: dark)',  color: '#0A0C12' },
    { media: '(prefers-color-scheme: light)', color: '#F8F9FB' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `class="dark"` is the SSR default — dark paints first, no
    // flash of light. The ThemeProvider on the client may flip
    // this to `data-theme="light"` if the user has a saved choice.
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <Providers>
          <TopBar />
          <main className="mx-auto max-w-[1600px] px-5 pb-24 pt-6 sm:px-8">
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
