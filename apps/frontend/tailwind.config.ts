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
        // "Brushed platinum on graphite" — refined studio-gear dark theme.
        // Base surfaces stay graphite (so terminal text reads cleanly);
        // accents shift to a cool platinum that picks up steel undertones.
        bg: {
          base: '#161618',     // window background — a touch deeper to give silver more contrast
          panel: '#28282a',    // raised surface
          subtle: '#34343660', // controls / hover targets (slight transparency)
          hover: '#454547',    // active hover
          chrome: '#222224',   // toolbar / title bar tint
        },
        border: {
          subtle: 'rgba(220, 224, 232, 0.07)',
          strong: 'rgba(220, 224, 232, 0.14)',
          hairline: 'rgba(0, 0, 0, 0.42)', // crisper hairlines against the deeper base
        },
        fg: {
          base: '#eef0f3',                       // primary label — slight cool cast pairs with silver
          muted: 'rgba(230, 234, 242, 0.58)',    // secondary label
          subtle: 'rgba(220, 226, 238, 0.30)',   // tertiary label
        },
        // Platinum accent system. `DEFAULT` is the workhorse fill; `bright`
        // hovers; `muted` is the pressed state; `soft` and `glow` are tints
        // for halos and backgrounds.
        accent: {
          DEFAULT: '#c8cad0',
          bright: '#e6e8ec',
          muted: '#a3a5ab',
          soft: 'rgba(200, 204, 214, 0.10)',
          glow: 'rgba(220, 224, 232, 0.42)',
        },
        // Status colors kept — semantic clarity beats palette purity. Tuned
        // slightly cooler so they sit naturally next to the silver accent.
        status: {
          ok: '#3ad28a',   // cool emerald
          warn: '#f0a958', // tempered amber
          err: '#ff5252',  // signal red
          info: '#c8cad0', // matches accent — neutral info pings
        },
      },
      boxShadow: {
        // Silver focus ring + bloom — softer than the old blue, since
        // bright silver tends to over-glow on dark.
        focus: '0 0 0 4px rgba(200, 204, 214, 0.22)',
        glow: '0 0 28px -6px rgba(220, 224, 232, 0.38)',
        'glow-sm': '0 0 12px -2px rgba(220, 224, 232, 0.34)',
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
