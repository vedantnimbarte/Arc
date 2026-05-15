import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        // UI / chrome — modern characterful sans
        display: [
          'Geist',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI Variable',
          'sans-serif',
        ],
        // Code / terminal — paired mono
        mono: [
          'Geist Mono',
          'JetBrains Mono',
          'Fira Code',
          'Cascadia Code',
          'SF Mono',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },
      colors: {
        // "Twilight" — cool indigo-tinted dark palette. RGBA borders give
        // surfaces a floating quality on top of the atmospheric background.
        bg: {
          base: '#0c0d12',
          panel: '#13141b',
          subtle: '#191b24',
          hover: '#22242f',
        },
        border: {
          subtle: 'rgba(255, 255, 255, 0.06)',
          strong: 'rgba(255, 255, 255, 0.10)',
        },
        fg: {
          base: '#eceff5',
          muted: '#9097a8',
          subtle: '#5d6477',
        },
        accent: {
          DEFAULT: '#a78bfa', // soft violet
          muted: '#7c6cd9',
          soft: 'rgba(167, 139, 250, 0.15)',
        },
        status: {
          ok: '#86d099',
          warn: '#f5a97f',
          err: '#f47b8e',
        },
      },
      boxShadow: {
        glow: '0 0 32px -8px rgba(167, 139, 250, 0.55)',
        'glow-sm': '0 0 14px -4px rgba(167, 139, 250, 0.40)',
        // Floating panel: inset top highlight + deep ambient shadow
        panel:
          'inset 0 1px 0 0 rgba(255, 255, 255, 0.04), 0 24px 48px -24px rgba(0, 0, 0, 0.55)',
        soft: 'inset 0 1px 0 0 rgba(255, 255, 255, 0.04)',
      },
      backdropBlur: {
        xs: '2px',
      },
      letterSpacing: {
        widest2: '0.18em',
      },
      keyframes: {
        'pulse-soft': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.55', transform: 'scale(0.85)' },
        },
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'shimmer-cursor': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
      },
      animation: {
        'pulse-soft': 'pulse-soft 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fade-in 0.35s cubic-bezier(0.16, 1, 0.3, 1) both',
        'shimmer-cursor': 'shimmer-cursor 1.2s ease-in-out infinite',
      },
      transitionTimingFunction: {
        'out-soft': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
} satisfies Config;
