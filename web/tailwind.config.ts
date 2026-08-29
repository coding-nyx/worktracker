import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
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
        brand: {
          50: '#f0f4ff',
          100: '#dbe4ff',
          500: '#3b6cff',
          600: '#2f5be0',
          700: '#2549b3',
        },
      },
    },
  },
  plugins: [],
};

export default config;
