// Convert a VS Code colour theme into an ARC `ThemeDef`.
//
// ARC's theme format is ~20 semantic tokens; VS Code's is ~1000 workbench
// colour keys, of which a given theme defines whatever it felt like and
// inherits the rest. So this is a *mapping with fallbacks*, not a translation:
// each ARC token names the VS Code keys it prefers, in order, and derives a
// value from the base colours when none of them are present.
//
// The one thing that isn't guesswork is the text ramp. `themes/index.ts` is
// explicit that `fgMuted` and `fgSubtle` carry real text and therefore have to
// clear WCAG AAA (7:1) and AA (4.5:1) against `bgBase`. Rather than copy an
// alpha that happened to look right on the built-in palettes, we solve for the
// alpha that hits the target on *this* theme's colours — see `alphaFor`.

import type { ITheme } from '@xterm/xterm';
import type { ThemeDef, ThemeTokens } from '../themes';

/** The subset of the VS Code theme format we read. */
interface VscodeTheme {
  name?: string;
  type?: string;
  colors?: Record<string, unknown>;
}

type Rgb = [number, number, number];

// ─── JSONC ───────────────────────────────────────────────────────────────
//
// VS Code reads theme files as JSONC, and published themes lean on that —
// comments and trailing commas are common enough that a plain `JSON.parse`
// rejects a good share of real-world files.

/** Strip line and block comments plus trailing commas, respecting strings. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  // Trailing commas before a closing brace/bracket.
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

// ─── Colour maths ────────────────────────────────────────────────────────

/** Parse `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`. Returns rgb plus alpha. */
export function parseHex(value: unknown): { rgb: Rgb; a: number } | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  const expand = (s: string) => parseInt(s.length === 1 ? s + s : s, 16);
  if (hex.length === 3 || hex.length === 4) {
    return {
      rgb: [expand(hex[0]!), expand(hex[1]!), expand(hex[2]!)],
      a: hex.length === 4 ? expand(hex[3]!) / 255 : 1,
    };
  }
  if (hex.length === 6 || hex.length === 8) {
    return {
      rgb: [expand(hex.slice(0, 2)), expand(hex.slice(2, 4)), expand(hex.slice(4, 6))],
      a: hex.length === 8 ? expand(hex.slice(6, 8)) / 255 : 1,
    };
  }
  return null;
}

/** Alpha-composite `fg` over `bg`. */
function over(fg: Rgb, a: number, bg: Rgb): Rgb {
  return [
    Math.round(fg[0] * a + bg[0] * (1 - a)),
    Math.round(fg[1] * a + bg[1] * (1 - a)),
    Math.round(fg[2] * a + bg[2] * (1 - a)),
  ];
}

/** WCAG relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** WCAG contrast ratio between two opaque colours (1…21). */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The smallest alpha at which `fg` over `bg` reaches `target` contrast
 * against `bg`. Returns 1 when even fully opaque can't get there — the
 * theme's own foreground is then the ceiling, which is the same compromise
 * `themes/index.ts` documents for Catppuccin Latte.
 *
 * Contrast rises monotonically with alpha (the composite moves along a
 * straight line from `bg` to `fg`), so a bisection is exact enough at 20
 * iterations — ~1e-6 in alpha.
 */
export function alphaFor(fg: Rgb, bg: Rgb, target: number): number {
  if (contrast(fg, bg) < target) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(over(fg, mid, bg), bg) >= target) hi = mid;
    else lo = mid;
  }
  return Math.round(hi * 1000) / 1000;
}

/** Nudge `c` toward `toward` by `amount` (0…1). */
function mix(c: Rgb, toward: Rgb, amount: number): Rgb {
  return over(toward, amount, c);
}

const triple = (c: Rgb) => `${c[0]} ${c[1]} ${c[2]}`;
const rgba = (c: Rgb, a: number) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

/** Slugify a theme name into a stable id, so re-importing replaces rather
 *  than duplicating. Prefixed to keep the built-in ids un-shadowable. */
export function themeIdFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `vscode-${slug || 'theme'}`;
}

// ─── Conversion ──────────────────────────────────────────────────────────

/** ANSI keys in the order xterm's ITheme wants them. */
const ANSI: Array<[keyof ITheme, string]> = [
  ['black', 'terminal.ansiBlack'],
  ['red', 'terminal.ansiRed'],
  ['green', 'terminal.ansiGreen'],
  ['yellow', 'terminal.ansiYellow'],
  ['blue', 'terminal.ansiBlue'],
  ['magenta', 'terminal.ansiMagenta'],
  ['cyan', 'terminal.ansiCyan'],
  ['white', 'terminal.ansiWhite'],
  ['brightBlack', 'terminal.ansiBrightBlack'],
  ['brightRed', 'terminal.ansiBrightRed'],
  ['brightGreen', 'terminal.ansiBrightGreen'],
  ['brightYellow', 'terminal.ansiBrightYellow'],
  ['brightBlue', 'terminal.ansiBrightBlue'],
  ['brightMagenta', 'terminal.ansiBrightMagenta'],
  ['brightCyan', 'terminal.ansiBrightCyan'],
  ['brightWhite', 'terminal.ansiBrightWhite'],
];

/**
 * Convert a parsed VS Code theme to a `ThemeDef`.
 *
 * `editor.background` is the only hard requirement — every other token is
 * derived from it when the theme doesn't say. A file with no `colors` map at
 * all is almost certainly a `tokenColors`-only syntax theme, which has nothing
 * to give a workbench palette, so that's rejected rather than turned into a
 * greyscale approximation of itself.
 */
export function convertVscodeTheme(
  value: unknown,
  fallbackName?: string,
): { ok: true; theme: ThemeDef } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, error: 'theme must be a JSON object' };
  }
  const vs = value as VscodeTheme;
  const colors = vs.colors;
  if (typeof colors !== 'object' || colors === null) {
    return {
      ok: false,
      error: 'no "colors" map — this looks like a syntax-only theme, which has no workbench palette to import',
    };
  }

  const name = (vs.name ?? fallbackName ?? '').trim();
  if (!name) return { ok: false, error: 'theme has no "name"' };

  // A key's value, composited onto `onto` if it carries alpha.
  const pick = (keys: string[], onto: Rgb | null): Rgb | null => {
    for (const key of keys) {
      const parsed = parseHex(colors[key]);
      if (!parsed) continue;
      if (parsed.a >= 1 || !onto) return parsed.rgb;
      return over(parsed.rgb, parsed.a, onto);
    }
    return null;
  };

  const bgBase = pick(['editor.background'], null);
  if (!bgBase) {
    return { ok: false, error: 'theme does not define "editor.background"' };
  }

  // `type` is advisory and sometimes absent or "hc-*"; the background's own
  // luminance is the ground truth for which way "lift" points.
  const declared = (vs.type ?? '').toLowerCase();
  const mode: 'dark' | 'light' =
    declared === 'light' || declared === 'hc-light'
      ? 'light'
      : declared === 'dark' || declared === 'hc' || declared === 'hc-black'
        ? 'dark'
        : luminance(bgBase) > 0.4
          ? 'light'
          : 'dark';

  const liftToward: Rgb = mode === 'dark' ? [255, 255, 255] : [0, 0, 0];
  const lift = (c: Rgb, amount: number) => mix(c, liftToward, amount);

  const fgBase =
    pick(['editor.foreground', 'foreground'], bgBase) ??
    (mode === 'dark' ? [238, 240, 243] : [28, 28, 30]);

  const bgPanel =
    pick(['sideBar.background', 'panel.background', 'editorWidget.background'], bgBase) ??
    lift(bgBase, 0.06);
  const bgHover =
    pick(['list.hoverBackground', 'list.activeSelectionBackground'], bgPanel) ??
    lift(bgPanel, 0.1);
  const bgChrome =
    pick(
      ['titleBar.activeBackground', 'editorGroupHeader.tabsBackground', 'tab.inactiveBackground'],
      bgBase,
    ) ?? lift(bgBase, 0.03);

  const accent =
    pick(
      [
        'focusBorder',
        'button.background',
        'textLink.foreground',
        'activityBarBadge.background',
        'terminal.ansiBlue',
      ],
      bgBase,
    ) ?? (mode === 'dark' ? [200, 202, 208] : [56, 115, 214]);

  // Accent variants: `bright` steps toward the foreground so it stays legible
  // as emphasis, `muted` toward the background so it recedes.
  const accentBright = mix(accent, fgBase, 0.3);
  const accentMuted = mix(accent, bgBase, 0.4);

  // Text ramp — solved, not eyeballed. See the module header.
  const mutedAlpha = alphaFor(fgBase, bgBase, 7);
  const subtleAlpha = alphaFor(fgBase, bgBase, 4.5);

  const washes = [
    accent,
    pick(['terminal.ansiMagenta', 'terminal.ansiBrightMagenta'], bgBase) ?? mix(accent, fgBase, 0.2),
    pick(['terminal.ansiCyan', 'terminal.ansiBrightCyan'], bgBase) ?? mix(accent, bgBase, 0.25),
  ] as const;

  const tokens: ThemeTokens = {
    bgBase: triple(bgBase),
    bgPanel: triple(bgPanel),
    bgHover: triple(bgHover),
    bgChrome: triple(bgChrome),
    fgBase: triple(fgBase),
    accent: triple(accent),
    accentBright: triple(accentBright),
    accentMuted: triple(accentMuted),
    bgSubtle: rgba(bgPanel, 0.55),
    borderSubtle: rgba(fgBase, 0.07),
    borderStrong: rgba(fgBase, 0.16),
    borderHairline: mode === 'dark' ? 'rgba(0, 0, 0, 0.45)' : 'rgba(0, 0, 0, 0.16)',
    fgMuted: rgba(fgBase, mutedAlpha),
    fgSubtle: rgba(fgBase, subtleAlpha),
    accentSoft: rgba(accent, 0.12),
    accentGlow: rgba(accent, 0.42),
    wash1: triple(washes[0]),
    wash2: triple(washes[1]),
    wash3: triple(washes[2]),
  };

  const hex = (c: Rgb) =>
    `#${c.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  const terminalBg = pick(['terminal.background', 'panel.background'], bgBase) ?? bgBase;
  const terminalFg = pick(['terminal.foreground'], terminalBg) ?? fgBase;

  const xterm: ITheme = {
    background: hex(terminalBg),
    foreground: hex(terminalFg),
    cursor: hex(pick(['terminalCursor.foreground', 'editorCursor.foreground'], terminalBg) ?? accent),
    cursorAccent: hex(terminalBg),
    selectionBackground: rgba(
      pick(['terminal.selectionBackground', 'editor.selectionBackground'], terminalBg) ?? accent,
      0.3,
    ),
  };
  // ANSI colours the theme doesn't define are left unset — xterm falls back to
  // its own defaults, which read better than sixteen shades derived from one
  // accent would.
  for (const [slot, key] of ANSI) {
    const c = pick([key], terminalBg);
    if (c) (xterm as Record<string, unknown>)[slot] = hex(c);
  }

  return {
    ok: true,
    theme: {
      id: themeIdFor(name),
      name,
      mode,
      author: 'imported from VS Code',
      tokens,
      xterm,
    },
  };
}

/** True if the JSON looks like a VS Code theme rather than an ARC one. Used
 *  to let one "install" entry point accept either format. */
export function looksLikeVscodeTheme(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  // An ARC theme has `tokens`; a VS Code theme has `colors` and/or
  // `tokenColors` and never `tokens`.
  if ('tokens' in v) return false;
  return 'colors' in v || 'tokenColors' in v || 'semanticTokenColors' in v;
}
