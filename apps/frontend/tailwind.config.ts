import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        // SF Pro on Apple, falls through to Inter elsewhere — mirrors the
        // native macOS feel without shipping a binary blob.
        display: [
          '-apple-system',
          'BlinkMacSystemFont',
          'SF Pro Display',
          'SF Pro Text',
          'Inter',
          'system-ui',
          'sans-serif',
        ],
        // SF Mono → JetBrains Mono fallback for the terminal + code.
        mono: [
          'SF Mono',
          'ui-monospace',
          'JetBrains Mono',
          'Menlo',
          'Monaco',
          'Cascadia Code',
          'Consolas',
          'monospace',
        ],
      },
      colors: {
        // macOS "Sonoma / Tahoe" dark palette — graphite base, translucent
        // panels that ride on top of a system-wallpaper-style backdrop.
        bg: {
          base: '#1c1c1e',     // window background (dark mode)
          panel: '#2c2c2e',    // raised surface
          subtle: '#3a3a3c',   // controls / hover targets
          hover: '#48484a',    // active hover
          chrome: '#28282a',   // toolbar / title bar tint
        },
        border: {
          subtle: 'rgba(255, 255, 255, 0.08)',
          strong: 'rgba(255, 255, 255, 0.14)',
          hairline: 'rgba(0, 0, 0, 0.35)', // for separators on dark
        },
        fg: {
          base: '#f5f5f7',          // primary label
          muted: 'rgba(235, 235, 245, 0.60)', // secondary label
          subtle: 'rgba(235, 235, 245, 0.30)', // tertiary label
        },
        // macOS system colors
        accent: {
          DEFAULT: '#0a84ff', // system blue (dark)
          muted: '#0071e3',
          soft: 'rgba(10, 132, 255, 0.18)',
          glow: 'rgba(10, 132, 255, 0.45)',
        },
        status: {
          ok: '#30d158',   // system green
          warn: '#ff9f0a', // system orange
          err: '#ff453a',  // system red
          info: '#0a84ff',
        },
      },
      boxShadow: {
        // Soft system blue focus ring (Catalina onward)
        focus: '0 0 0 4px rgba(10, 132, 255, 0.25)',
        glow: '0 0 28px -6px rgba(10, 132, 255, 0.55)',
        'glow-sm': '0 0 12px -2px rgba(10, 132, 255, 0.45)',
        // Floating window: crisp top highlight + soft ambient drop.
        panel:
          'inset 0 1px 0 0 rgba(255, 255, 255, 0.06), 0 1px 0 0 rgba(0, 0, 0, 0.4), 0 18px 40px -16px rgba(0, 0, 0, 0.55)',
        // The defining macOS sheet shadow — heavier vertical, soft edges.
        sheet:
          'inset 0 1px 0 0 rgba(255, 255, 255, 0.08), 0 24px 72px -12px rgba(0, 0, 0, 0.65), 0 12px 24px -8px rgba(0, 0, 0, 0.4)',
        soft: 'inset 0 1px 0 0 rgba(255, 255, 255, 0.06)',
        // Pill / control highlight
        control:
          'inset 0 1px 0 0 rgba(255, 255, 255, 0.10), 0 1px 2px 0 rgba(0, 0, 0, 0.35)',
      },
      backdropBlur: {
        xs: '2px',
        // Apple's "thick material" sits around 30-40px
        thick: '40px',
      },
      backdropSaturate: {
        180: '1.8',
        200: '2',
      },
      letterSpacing: {
        // Apple's "Compressed" all-caps spacing
        widest2: '0.14em',
      },
      borderRadius: {
        // Apple corner radii — squircle-ish at the system corner sizes.
        squircle: '10px',
        window: '12px',
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
        // Apple-style sheet drop-down
        'sheet-in': {
          from: { opacity: '0', transform: 'translateY(-12px) scale(0.985)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'pulse-soft': 'pulse-soft 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fade-in 0.35s cubic-bezier(0.16, 1, 0.3, 1) both',
        'shimmer-cursor': 'shimmer-cursor 1.2s ease-in-out infinite',
        'sheet-in': 'sheet-in 0.32s cubic-bezier(0.22, 1, 0.36, 1) both',
      },
      transitionTimingFunction: {
        'out-soft': 'cubic-bezier(0.16, 1, 0.3, 1)',
        // Apple's standard system curve
        apple: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
    },
  },
  plugins: [],
} satisfies Config;
