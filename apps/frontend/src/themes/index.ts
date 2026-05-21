// Appearance system. Two baked-in themes (dark + light); the user picks
// one of three preferences (dark / light / system) and `resolveTheme`
// derives the active theme. The Tailwind config reads the same CSS
// variables — so flipping `--bg-base` instantly retints every
// `bg-base` utility across the app.

import type { ITheme } from '@xterm/xterm';

export type Appearance = 'dark' | 'light' | 'system';

export interface ThemeTokens {
  // RGB channel triples ("r g b") for tokens consumed via Tailwind's
  // `<alpha-value>` slot, so `bg-bg-base/60` etc. compile to a valid
  // `rgb(r g b / 0.6)`.
  bgBase: string;
  bgPanel: string;
  bgHover: string;
  bgChrome: string;
  fgBase: string;
  accent: string;
  accentBright: string;
  accentMuted: string;
  // Pre-baked color strings (already include alpha) — used as-is.
  bgSubtle: string;
  borderSubtle: string;
  borderStrong: string;
  borderHairline: string;
  fgMuted: string;
  fgSubtle: string;
  accentSoft: string;
  accentGlow: string;
  // Wallpaper washes — three RGB triples (no `rgb()` wrapper).
  wash1: string;
  wash2: string;
  wash3: string;
}

export interface ThemeDef {
  id: 'dark' | 'light';
  name: string;
  mode: 'dark' | 'light';
  tokens: ThemeTokens;
  xterm: ITheme;
}

const dark: ThemeDef = {
  id: 'dark',
  name: 'Dark',
  mode: 'dark',
  tokens: {
    bgBase: '22 22 24',
    bgPanel: '40 40 42',
    bgHover: '69 69 71',
    bgChrome: '34 34 36',
    fgBase: '238 240 243',
    accent: '200 202 208',
    accentBright: '230 232 236',
    accentMuted: '163 165 171',
    bgSubtle: 'rgba(52, 52, 54, 0.38)',
    borderSubtle: 'rgba(220, 224, 232, 0.07)',
    borderStrong: 'rgba(220, 224, 232, 0.14)',
    borderHairline: 'rgba(0, 0, 0, 0.42)',
    fgMuted: 'rgba(230, 234, 242, 0.58)',
    fgSubtle: 'rgba(220, 226, 238, 0.30)',
    accentSoft: 'rgba(200, 204, 214, 0.10)',
    accentGlow: 'rgba(220, 224, 232, 0.42)',
    wash1: '198 208 222',
    wash2: '168 178 196',
    wash3: '130 148 172',
  },
  xterm: {
    background: '#161618',
    foreground: '#eef0f3',
    cursor: '#d4d6dc',
    cursorAccent: '#161618',
    selectionBackground: 'rgba(200, 210, 225, 0.32)',
    black: '#28282a', red: '#ff5252', green: '#3ad28a', yellow: '#f0a958',
    blue: '#9cb5d4', magenta: '#bf9ff2', cyan: '#7ec8d0', white: '#d4d6dc',
    brightBlack: '#6c6c70', brightRed: '#ff7a78', brightGreen: '#65e0a4',
    brightYellow: '#ffc370', brightBlue: '#c1d2e6', brightMagenta: '#d8b7ff',
    brightCyan: '#a8d6dc', brightWhite: '#f3f5f8',
  },
};

const light: ThemeDef = {
  id: 'light',
  name: 'Light',
  mode: 'light',
  tokens: {
    bgBase: '247 247 248',
    bgPanel: '255 255 255',
    bgHover: '225 226 230',
    bgChrome: '240 240 242',
    fgBase: '28 28 30',
    accent: '56 115 214',
    accentBright: '36 89 184',
    accentMuted: '122 163 224',
    bgSubtle: 'rgba(236, 236, 239, 0.85)',
    borderSubtle: 'rgba(60, 60, 70, 0.10)',
    borderStrong: 'rgba(60, 60, 70, 0.20)',
    borderHairline: 'rgba(0, 0, 0, 0.16)',
    fgMuted: 'rgba(28, 28, 30, 0.62)',
    fgSubtle: 'rgba(28, 28, 30, 0.38)',
    accentSoft: 'rgba(56, 115, 214, 0.10)',
    accentGlow: 'rgba(56, 115, 214, 0.28)',
    wash1: '210 220 240',
    wash2: '230 232 240',
    wash3: '200 210 224',
  },
  xterm: {
    background: '#f7f7f8',
    foreground: '#1c1c1e',
    cursor: '#3873d6',
    cursorAccent: '#f7f7f8',
    selectionBackground: 'rgba(56, 115, 214, 0.22)',
    black: '#1c1c1e', red: '#c0392b', green: '#1e7d3f', yellow: '#8a6d00',
    blue: '#1d4faf', magenta: '#8a3a9c', cyan: '#1f7a8c', white: '#3a3a3d',
    brightBlack: '#5a5a5d', brightRed: '#d44b3a', brightGreen: '#2aa055',
    brightYellow: '#a88200', brightBlue: '#2766c8', brightMagenta: '#a55ab4',
    brightCyan: '#2f93a8', brightWhite: '#1c1c1e',
  },
};

export const THEMES: Record<'dark' | 'light', ThemeDef> = { dark, light };

export const DEFAULT_APPEARANCE: Appearance = 'system';

/** Read the OS-level preference. Returns `'dark'` outside the browser. */
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Resolve an appearance preference to the concrete theme to apply. */
export function resolveTheme(appearance: Appearance): ThemeDef {
  if (appearance === 'dark') return dark;
  if (appearance === 'light') return light;
  return systemPrefersDark() ? dark : light;
}

/** Apply a theme's CSS variables to `<html>`. Called once on boot + every
 *  time the user picks a new appearance. Cheap — sets ~20 CSS variables. */
export function applyTheme(theme: ThemeDef): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const t = theme.tokens;
  const set = (key: string, val: string) => root.style.setProperty(key, val);

  set('--bg-base', t.bgBase);
  set('--bg-panel', t.bgPanel);
  set('--bg-subtle', t.bgSubtle);
  set('--bg-hover', t.bgHover);
  set('--bg-chrome', t.bgChrome);
  set('--border-subtle', t.borderSubtle);
  set('--border-strong', t.borderStrong);
  set('--border-hairline', t.borderHairline);
  set('--fg-base', t.fgBase);
  set('--fg-muted', t.fgMuted);
  set('--fg-subtle', t.fgSubtle);
  set('--accent', t.accent);
  set('--accent-bright', t.accentBright);
  set('--accent-muted', t.accentMuted);
  set('--accent-soft', t.accentSoft);
  set('--accent-glow', t.accentGlow);
  set('--wash-1', t.wash1);
  set('--wash-2', t.wash2);
  set('--wash-3', t.wash3);

  root.style.colorScheme = theme.mode;
  root.setAttribute('data-theme', theme.id);
  if (theme.mode === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
}

/** Subscribe to OS-level color-scheme changes. Caller fires `applyTheme`
 *  if their preference is `'system'`. Returns a teardown function. */
export function onSystemAppearanceChange(handler: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const cb = () => handler();
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

// ─── Fonts ─────────────────────────────────────────────────────────────────

export interface FontOption {
  id: string;
  label: string;
  stack: string;
}

export const FONT_OPTIONS: FontOption[] = [
  {
    id: 'sf-mono',
    label: 'SF Mono',
    stack: "'SF Mono', ui-monospace, Menlo, Monaco, monospace",
  },
  {
    id: 'jetbrains-mono',
    label: 'JetBrains Mono',
    stack: "'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace",
  },
  {
    id: 'fira-code',
    label: 'Fira Code',
    stack: "'Fira Code', 'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
  },
  {
    id: 'cascadia-code',
    label: 'Cascadia Code',
    stack: "'Cascadia Code', 'Cascadia Mono', Consolas, ui-monospace, monospace",
  },
  {
    id: 'menlo',
    label: 'Menlo',
    stack: "Menlo, Monaco, 'SF Mono', ui-monospace, monospace",
  },
  {
    id: 'consolas',
    label: 'Consolas',
    stack: "Consolas, 'Cascadia Mono', 'SF Mono', ui-monospace, monospace",
  },
  {
    id: 'monaco',
    label: 'Monaco',
    stack: "Monaco, Menlo, 'SF Mono', ui-monospace, monospace",
  },
  {
    id: 'source-code-pro',
    label: 'Source Code Pro',
    stack: "'Source Code Pro', 'SF Mono', ui-monospace, monospace",
  },
  {
    id: 'system-mono',
    label: 'System Monospace',
    stack: 'ui-monospace, monospace',
  },
];

export const DEFAULT_FONT_ID = 'sf-mono';
export const DEFAULT_FONT_SIZE = 13;
export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 24;

export function getFont(id: string | null | undefined): FontOption {
  return FONT_OPTIONS.find((f) => f.id === id) ?? FONT_OPTIONS[0]!;
}
