'use client';

/**
 * Theme provider + toggle. Dark is the default — the `<html>` element
 * ships with `class="dark"` from the server layout, and we hydrate
 * the user's saved choice from `localStorage` (if any) on mount.
 * Anything that wants to know the current theme can `useTheme()`.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

type Theme = 'dark' | 'light';

interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
  set: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = 'worktracker.theme';

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Start with the server-rendered default (dark) so first paint is
  // correct; we then sync from localStorage on mount.
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (stored === 'light' || stored === 'dark') {
      setTheme(stored);
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.classList.toggle('dark', theme === 'dark');
    root.style.colorScheme = theme;
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // localStorage may be blocked in private mode — the theme
      // will just reset on the next visit.
    }
  }, [theme]);

  const set = useCallback((t: Theme) => setTheme(t), []);
  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);

  const value = useMemo(() => ({ theme, toggle, set }), [theme, toggle, set]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}

export function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      className={`focus-ring relative inline-flex h-8 w-14 shrink-0 items-center rounded-full border border-border-default bg-bg-surface transition-colors hover:border-border-strong ${className}`}
    >
      <span
        aria-hidden
        className={`absolute left-0.5 top-0.5 inline-flex h-7 w-7 items-center justify-center rounded-full bg-bg-raised text-ink-1 shadow-card transition-transform duration-200 ease-spring ${
          isDark ? 'translate-x-6' : 'translate-x-0'
        }`}
      >
        {isDark ? (
          // Moon
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
          </svg>
        ) : (
          // Sun
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2" /><path d="M12 20v2" /><path d="M4.93 4.93l1.41 1.41" /><path d="M17.66 17.66l1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="M4.93 19.07l1.41-1.41" /><path d="M17.66 6.34l1.41-1.41" />
          </svg>
        )}
      </span>
      <span className="sr-only">Theme: {isDark ? 'dark' : 'light'}</span>
    </button>
  );
}
