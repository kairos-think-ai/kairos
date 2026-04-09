/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Instrument Sans', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Fira Code', 'monospace'],
      },
      colors: {
        obs: {
          bg: '#0A0A0F',
          surface: '#16161D',
          hover: '#1C1C25',
          border: '#222230',
          'border-active': '#333345',
        },
        accent: {
          DEFAULT: '#6366F1',
          hover: '#818CF8',
          dim: 'rgba(99, 102, 241, 0.10)',
          gold: '#E5A54B',
          'gold-dim': 'rgba(229, 165, 75, 0.10)',
        },
        text: {
          primary: '#F0F0F5',
          secondary: '#8888A0',
          muted: '#555568',
        },
        ring: {
          fill: '#6366F1',
          track: '#222240',
        },
        drift: {
          low: '#10B981',
          med: '#E5A54B',
          high: '#F43F5E',
        },
      },
    },
  },
  plugins: [],
};
