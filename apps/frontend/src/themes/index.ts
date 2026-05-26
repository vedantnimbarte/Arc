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
  /** Stable id used as the persisted theme key. Built-ins are 'dark',
   *  'light', 'catppuccin-mocha', 'catppuccin-latte'. Custom themes loaded
   *  from `<data_dir>/arc/themes/*.json` use the slug from their filename. */
  id: string;
  name: string;
  /** Dictates `:root[data-theme=...]` plus the `.dark` class toggle that
   *  Tailwind's `dark:` variants key off. Custom themes must declare one. */
  mode: 'dark' | 'light';
  /** Optional author attribution shown in the settings theme list. */
  author?: string;
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

// Catppuccin Mocha — community-favorite dark theme. Palette values come
// straight from https://catppuccin.com/palette (Mocha column).
const catppuccinMocha: ThemeDef = {
  id: 'catppuccin-mocha',
  name: 'Catppuccin Mocha',
  mode: 'dark',
  author: 'Catppuccin',
  tokens: {
    bgBase: '30 30 46',       // base    #1e1e2e
    bgPanel: '49 50 68',      // surface0 #313244
    bgHover: '69 71 90',      // surface1 #45475a
    bgChrome: '24 24 37',     // mantle  #181825
    fgBase: '205 214 244',    // text    #cdd6f4
    accent: '180 190 254',    // lavender #b4befe
    accentBright: '203 166 247', // mauve  #cba6f7
    accentMuted: '147 153 178',  // overlay2 #9399b2
    bgSubtle: 'rgba(49, 50, 68, 0.55)',     // surface0 @ 55%
    borderSubtle: 'rgba(205, 214, 244, 0.07)',
    borderStrong: 'rgba(205, 214, 244, 0.16)',
    borderHairline: 'rgba(0, 0, 0, 0.48)',
    fgMuted: 'rgba(205, 214, 244, 0.62)',
    fgSubtle: 'rgba(205, 214, 244, 0.34)',
    accentSoft: 'rgba(180, 190, 254, 0.12)',
    accentGlow: 'rgba(180, 190, 254, 0.45)',
    wash1: '203 166 247',  // mauve
    wash2: '137 180 250',  // blue
    wash3: '116 199 236',  // sapphire
  },
  xterm: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',           // rosewater
    cursorAccent: '#1e1e2e',
    selectionBackground: 'rgba(180, 190, 254, 0.30)',
    black: '#45475a',            // surface1
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#cba6f7',          // mauve
    cyan: '#94e2d5',             // teal
    white: '#bac2de',            // subtext1
    brightBlack: '#585b70',      // surface2
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#cba6f7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',      // subtext0
  },
};

// Catppuccin Latte — Catppuccin's light variant. Pairs with Mocha so the
// theme picker has a matched pair for users on the OS auto-switch path.
const catppuccinLatte: ThemeDef = {
  id: 'catppuccin-latte',
  name: 'Catppuccin Latte',
  mode: 'light',
  author: 'Catppuccin',
  tokens: {
    bgBase: '239 241 245',    // base   #eff1f5
    bgPanel: '230 233 239',   // mantle #e6e9ef
    bgHover: '204 208 218',   // surface0 #ccd0da
    bgChrome: '220 224 232',  // crust  #dce0e8
    fgBase: '76 79 105',      // text   #4c4f69
    accent: '30 102 245',     // blue   #1e66f5
    accentBright: '32 159 181',  // sapphire #209fb5
    accentMuted: '108 111 133',  // subtext0 #6c6f85
    bgSubtle: 'rgba(220, 224, 232, 0.85)',
    borderSubtle: 'rgba(76, 79, 105, 0.10)',
    borderStrong: 'rgba(76, 79, 105, 0.22)',
    borderHairline: 'rgba(0, 0, 0, 0.16)',
    fgMuted: 'rgba(76, 79, 105, 0.62)',
    fgSubtle: 'rgba(76, 79, 105, 0.38)',
    accentSoft: 'rgba(30, 102, 245, 0.12)',
    accentGlow: 'rgba(30, 102, 245, 0.30)',
    wash1: '136 57 239',  // mauve  #8839ef
    wash2: '30 102 245',  // blue
    wash3: '4 165 229',   // sky
  },
  xterm: {
    background: '#eff1f5',
    foreground: '#4c4f69',
    cursor: '#1e66f5',
    cursorAccent: '#eff1f5',
    selectionBackground: 'rgba(30, 102, 245, 0.22)',
    black: '#5c5f77',            // subtext1
    red: '#d20f39',
    green: '#40a02b',
    yellow: '#df8e1d',
    blue: '#1e66f5',
    magenta: '#8839ef',          // mauve
    cyan: '#179299',             // teal
    white: '#acb0be',            // surface2
    brightBlack: '#6c6f85',      // subtext0
    brightRed: '#d20f39',
    brightGreen: '#40a02b',
    brightYellow: '#df8e1d',
    brightBlue: '#1e66f5',
    brightMagenta: '#8839ef',
    brightCyan: '#179299',
    brightWhite: '#bcc0cc',      // surface1
  },
};

/** Built-in themes, indexed by id. Custom user themes layer on top of this
 *  via `registerTheme`. Order matters: the settings picker renders themes
 *  in insertion order, so dark/light come first. */
export const THEMES: Record<string, ThemeDef> = {
  dark,
  light,
  'catppuccin-mocha': catppuccinMocha,
  'catppuccin-latte': catppuccinLatte,
};

export const DEFAULT_APPEARANCE: Appearance = 'system';

/** Read the OS-level preference. Returns `'dark'` outside the browser. */
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Resolve an appearance preference to the concrete theme to apply.
 *  Kept for the (few) call-sites that don't have access to themeId.
 *  Prefer `resolveActiveTheme` for new code. */
export function resolveTheme(appearance: Appearance): ThemeDef {
  if (appearance === 'dark') return dark;
  if (appearance === 'light') return light;
  return systemPrefersDark() ? dark : light;
}

/** Resolve the theme to render. `themeId` (when set + registered) wins over
 *  the dark/light/system preference — that's the user picking a specific
 *  named theme like Catppuccin Mocha. When `themeId` is null or stale, fall
 *  back to the appearance preference. */
export function resolveActiveTheme(
  appearance: Appearance,
  themeId: string | null,
): ThemeDef {
  if (themeId) {
    const t = THEMES[themeId];
    if (t) return t;
  }
  return resolveTheme(appearance);
}

/** Look up a theme by id (built-in or custom-registered). */
export function getThemeById(id: string): ThemeDef | undefined {
  return THEMES[id];
}

/** Snapshot of every theme currently in the registry — picker-friendly. */
export function listThemes(): ThemeDef[] {
  return Object.values(THEMES);
}

/** Register a user-supplied theme (or replace an existing entry by id).
 *  The Tier 1.7 marketplace calls this after fetching a theme JSON. */
export function registerTheme(theme: ThemeDef): void {
  THEMES[theme.id] = theme;
}

/** Parse + validate a raw JSON value into a ThemeDef. Returns the parsed
 *  theme on success or a string describing the first validation failure.
 *  Intentionally permissive — the JSON file format is the same shape as
 *  ThemeDef, so we just shape-check the required fields. */
export function validateThemeJson(value: unknown):
  | { ok: true; theme: ThemeDef }
  | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, error: 'theme must be an object' };
  }
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id) return { ok: false, error: 'id required' };
  if (typeof v.name !== 'string' || !v.name) return { ok: false, error: 'name required' };
  if (v.mode !== 'dark' && v.mode !== 'light') {
    return { ok: false, error: 'mode must be "dark" or "light"' };
  }
  const tokens = v.tokens;
  if (typeof tokens !== 'object' || tokens === null) {
    return { ok: false, error: 'tokens object required' };
  }
  const required: (keyof ThemeTokens)[] = [
    'bgBase', 'bgPanel', 'bgHover', 'bgChrome',
    'fgBase', 'accent', 'accentBright', 'accentMuted',
    'bgSubtle', 'borderSubtle', 'borderStrong', 'borderHairline',
    'fgMuted', 'fgSubtle', 'accentSoft', 'accentGlow',
    'wash1', 'wash2', 'wash3',
  ];
  const t = tokens as Record<string, unknown>;
  for (const key of required) {
    if (typeof t[key] !== 'string') return { ok: false, error: `tokens.${key} required` };
  }
  const xterm = v.xterm;
  if (typeof xterm !== 'object' || xterm === null) {
    return { ok: false, error: 'xterm theme required' };
  }
  // xterm fields are validated by xterm itself at apply time — we don't
  // re-implement that check here, just confirm a few core fields exist.
  const x = xterm as Record<string, unknown>;
  for (const key of ['background', 'foreground']) {
    if (typeof x[key] !== 'string') return { ok: false, error: `xterm.${key} required` };
  }
  return { ok: true, theme: value as ThemeDef };
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
