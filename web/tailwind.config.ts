import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      letterSpacing: {
        'mono-wide':   '0.04em',
        'mono-widest': '0.12em',
      },
      fontFamily: {
        // Avenir Next per user preference. Falls back to system
        // sans on platforms without the font.
        sans: [
          'Avenir Next',
          'Avenir',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'sans-serif',
        ],
      },
      colors: {
        // Semantic tokens — drive the app via these names so a
        // future re-skin is one mapping change in this file.
        bg: {
          base:     'rgb(var(--bg-base) / <alpha-value>)',
          surface:  'rgb(var(--bg-surface) / <alpha-value>)',
          raised:   'rgb(var(--bg-raised) / <alpha-value>)',
          sunken:   'rgb(var(--bg-sunken) / <alpha-value>)',
        },
        border: {
          subtle:  'rgb(var(--border-subtle) / <alpha-value>)',
          default: 'rgb(var(--border-default) / <alpha-value>)',
          strong:  'rgb(var(--border-strong) / <alpha-value>)',
        },
        ink: {
          1:  'rgb(var(--ink-1) / <alpha-value>)',
          2:  'rgb(var(--ink-2) / <alpha-value>)',
          3:  'rgb(var(--ink-3) / <alpha-value>)',
          4:  'rgb(var(--ink-4) / <alpha-value>)',
        },
        brand: {
          50:  '#eef2ff',
          100: '#dbe4ff',
          200: '#b9c8ff',
          300: '#8ea6ff',
          400: '#5d83ff',
          500: '#3b6cff',
          600: '#2f5be0',
          700: '#2549b3',
          800: '#1d3990',
          900: '#152b6e',
        },
        // Per-status hues, used by both the kanban column headers
        // and the card pills. Light tints (50) for backgrounds,
        // mid (500) for borders / dots, full (600) for text on
        // dark surfaces. The `DEFAULT` slot is the 500 value so
        // `bg-status-progress` resolves inside @apply directives.
        status: {
          backlog:  { DEFAULT: 'rgb(var(--status-backlog-500) / <alpha-value>)',  50: 'rgb(var(--status-backlog-50) / <alpha-value>)',  500: 'rgb(var(--status-backlog-500) / <alpha-value>)',  600: 'rgb(var(--status-backlog-600) / <alpha-value>)' },
          ready:    { DEFAULT: 'rgb(var(--status-ready-500) / <alpha-value>)',    50: 'rgb(var(--status-ready-50) / <alpha-value>)',    500: 'rgb(var(--status-ready-500) / <alpha-value>)',    600: 'rgb(var(--status-ready-600) / <alpha-value>)' },
          progress: { DEFAULT: 'rgb(var(--status-progress-500) / <alpha-value>)', 50: 'rgb(var(--status-progress-50) / <alpha-value>)', 500: 'rgb(var(--status-progress-500) / <alpha-value>)', 600: 'rgb(var(--status-progress-600) / <alpha-value>)' },
          blocked:  { DEFAULT: 'rgb(var(--status-blocked-500) / <alpha-value>)',  50: 'rgb(var(--status-blocked-50) / <alpha-value>)',  500: 'rgb(var(--status-blocked-500) / <alpha-value>)',  600: 'rgb(var(--status-blocked-600) / <alpha-value>)' },
          review:   { DEFAULT: 'rgb(var(--status-review-500) / <alpha-value>)',   50: 'rgb(var(--status-review-50) / <alpha-value>)',   500: 'rgb(var(--status-review-500) / <alpha-value>)',   600: 'rgb(var(--status-review-600) / <alpha-value>)' },
          done:     { DEFAULT: 'rgb(var(--status-done-500) / <alpha-value>)',     50: 'rgb(var(--status-done-50) / <alpha-value>)',     500: 'rgb(var(--status-done-500) / <alpha-value>)',     600: 'rgb(var(--status-done-600) / <alpha-value>)' },
        },
        success:  { DEFAULT: '#22c55e', 500: '#22c55e' },
        warning:  { DEFAULT: '#f59e0b', 500: '#f59e0b' },
        danger:   { DEFAULT: '#ef4444', 500: '#ef4444' },
      },
      borderRadius: {
        '4xl': '1.5rem',
        '5xl': '2rem',
      },
      boxShadow: {
        // Subtle elevation tokens. Dark theme uses pure black
        // shadows; light theme uses the dark-on-light shadows.
        'card':     '0 1px 0 rgb(0 0 0 / 0.04), 0 2px 4px rgb(0 0 0 / 0.04), 0 8px 24px rgb(0 0 0 / 0.04)',
        'card-lg':  '0 2px 4px rgb(0 0 0 / 0.06), 0 12px 32px rgb(0 0 0 / 0.08)',
        'glow':     '0 0 0 1px rgb(59 108 255 / 0.4), 0 8px 32px -8px rgb(59 108 255 / 0.6)',
        'inset-1':  'inset 0 1px 0 rgb(255 255 255 / 0.04)',
      },
      backgroundImage: {
        'page-dark':  'radial-gradient(1200px 800px at 50% -10%, rgb(59 108 255 / 0.10), transparent 60%), radial-gradient(900px 600px at 100% 0%, rgb(124 93 255 / 0.06), transparent 60%), radial-gradient(800px 500px at 0% 100%, rgb(59 108 255 / 0.04), transparent 60%)',
        'card-dark':  'linear-gradient(180deg, rgb(255 255 255 / 0.04), transparent 60%)',
        'shimmer':    'linear-gradient(90deg, transparent, rgb(255 255 255 / 0.06), transparent)',
      },
      keyframes: {
        shimmer: {
          '0%':   { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
        'pulse-ring': {
          '0%':   { transform: 'scale(0.95)', opacity: '0.6' },
          '70%':  { transform: 'scale(1.4)', opacity: '0' },
          '100%': { transform: 'scale(1.4)', opacity: '0' },
        },
        'fade-in': {
          '0%':   { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-down': {
          '0%':   { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          '0%':   { opacity: '0', transform: 'translateX(24px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
      },
      animation: {
        shimmer:    'shimmer 1.6s linear infinite',
        'pulse-ring': 'pulse-ring 1.8s ease-out infinite',
        'fade-in':  'fade-in 240ms cubic-bezier(0.34, 1.2, 0.64, 1) both',
        'slide-down': 'slide-down 200ms cubic-bezier(0.34, 1.2, 0.64, 1) both',
        'slide-in-right': 'slide-in-right 280ms cubic-bezier(0.22, 1, 0.36, 1) both',
      },
      transitionTimingFunction: {
        'spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        'out-quint': 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      backgroundSize: {
        '200': '200% 100%',
      },
    },
  },
  plugins: [],
};
export default config;
