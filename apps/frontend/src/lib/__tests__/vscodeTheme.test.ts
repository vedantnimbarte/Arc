import { describe, expect, it } from 'vitest';
import {
  alphaFor,
  contrast,
  convertVscodeTheme,
  looksLikeVscodeTheme,
  parseHex,
  parseJsonc,
  themeIdFor,
} from '../vscodeTheme';

/** Pull an `rgba(r, g, b, a)` string back apart for assertions. */
function readRgba(s: string): { rgb: [number, number, number]; a: number } {
  const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(s);
  if (!m) throw new Error(`not an rgba string: ${s}`);
  return {
    rgb: [Number(m[1]), Number(m[2]), Number(m[3])],
    a: Number(m[4]),
  };
}

/** Composite a translucent foreground over an opaque background. */
function over(fg: [number, number, number], a: number, bg: [number, number, number]) {
  return fg.map((c, i) => Math.round(c * a + bg[i]! * (1 - a))) as [number, number, number];
}

const DARK = {
  name: 'Test Dark',
  type: 'dark',
  colors: {
    'editor.background': '#1e1e2e',
    'editor.foreground': '#cdd6f4',
    'sideBar.background': '#181825',
    focusBorder: '#b4befe',
    'terminal.ansiRed': '#f38ba8',
    'terminal.ansiBlue': '#89b4fa',
  },
};

describe('parseHex', () => {
  it('accepts every hex length VS Code allows', () => {
    expect(parseHex('#fff')).toEqual({ rgb: [255, 255, 255], a: 1 });
    expect(parseHex('#ffffff')).toEqual({ rgb: [255, 255, 255], a: 1 });
    expect(parseHex('#00ff0080')?.rgb).toEqual([0, 255, 0]);
    expect(parseHex('#00ff0080')?.a).toBeCloseTo(0.502, 2);
    expect(parseHex('#f008')?.a).toBeCloseTo(0.533, 2);
  });

  it('rejects anything that is not hex', () => {
    expect(parseHex('red')).toBeNull();
    expect(parseHex('#12345')).toBeNull();
    expect(parseHex(42)).toBeNull();
    expect(parseHex(undefined)).toBeNull();
  });
});

describe('alphaFor', () => {
  it('finds the alpha that just reaches the target contrast', () => {
    const fg: [number, number, number] = [255, 255, 255];
    const bg: [number, number, number] = [0, 0, 0];
    const a = alphaFor(fg, bg, 4.5);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
    expect(contrast(over(fg, a, bg), bg)).toBeGreaterThanOrEqual(4.5);
    // Just below it should miss — i.e. the answer is the *minimum*.
    expect(contrast(over(fg, a - 0.02, bg), bg)).toBeLessThan(4.5);
  });

  it('saturates at 1 when even an opaque foreground cannot reach the target', () => {
    // Near-identical colours can never hit 7:1.
    expect(alphaFor([100, 100, 100], [104, 104, 104], 7)).toBe(1);
  });
});

describe('convertVscodeTheme', () => {
  it('maps the workbench colours onto ARC tokens', () => {
    const res = convertVscodeTheme(DARK);
    if (!res.ok) throw new Error(res.error);
    const { theme } = res;
    expect(theme.id).toBe('vscode-test-dark');
    expect(theme.name).toBe('Test Dark');
    expect(theme.mode).toBe('dark');
    expect(theme.tokens.bgBase).toBe('30 30 46');
    expect(theme.tokens.fgBase).toBe('205 214 244');
    expect(theme.tokens.bgPanel).toBe('24 24 37');
    expect(theme.tokens.accent).toBe('180 190 254');
    // ANSI slots the theme declared come through; the rest stay unset so
    // xterm uses its own defaults.
    expect(theme.xterm.red).toBe('#f38ba8');
    expect(theme.xterm.green).toBeUndefined();
  });

  it('gives fgMuted and fgSubtle enough contrast to carry text', () => {
    const res = convertVscodeTheme(DARK);
    if (!res.ok) throw new Error(res.error);
    const [r, g, b] = res.theme.tokens.bgBase.split(' ').map(Number) as [
      number,
      number,
      number,
    ];
    const bg: [number, number, number] = [r, g, b];

    const muted = readRgba(res.theme.tokens.fgMuted);
    const subtle = readRgba(res.theme.tokens.fgSubtle);
    // AAA for muted, AA for subtle — the floors themes/index.ts documents.
    // A hair of slack absorbs the rounding to 3 decimal places.
    expect(contrast(over(muted.rgb, muted.a, bg), bg)).toBeGreaterThanOrEqual(6.99);
    expect(contrast(over(subtle.rgb, subtle.a, bg), bg)).toBeGreaterThanOrEqual(4.49);
    // subtle is the lighter-weight rung, so it must not be more opaque.
    expect(subtle.a).toBeLessThanOrEqual(muted.a);
  });

  it('infers the mode from the background when "type" is missing', () => {
    const res = convertVscodeTheme({
      name: 'Paper',
      colors: { 'editor.background': '#fefefe' },
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.theme.mode).toBe('light');
  });

  it('derives the missing tokens rather than failing on a sparse theme', () => {
    const res = convertVscodeTheme({
      name: 'Bare',
      type: 'dark',
      colors: { 'editor.background': '#000000' },
    });
    if (!res.ok) throw new Error(res.error);
    // Every token the ARC validator requires must be a non-empty string.
    for (const [key, value] of Object.entries(res.theme.tokens)) {
      expect(typeof value, key).toBe('string');
      expect(value, key).not.toBe('');
    }
  });

  it('composites a translucent workbench colour over the background', () => {
    const res = convertVscodeTheme({
      name: 'Alpha',
      type: 'dark',
      colors: { 'editor.background': '#000000', 'sideBar.background': '#ffffff80' },
    });
    if (!res.ok) throw new Error(res.error);
    // 50% white over black, not raw white.
    expect(res.theme.tokens.bgPanel).toBe('128 128 128');
  });

  it('rejects input it cannot make a workbench palette from', () => {
    expect(convertVscodeTheme({ name: 'x', tokenColors: [] })).toMatchObject({ ok: false });
    expect(convertVscodeTheme({ colors: { 'editor.background': '#000' } })).toMatchObject({
      ok: false,
    });
    expect(convertVscodeTheme({ name: 'x', colors: {} })).toMatchObject({ ok: false });
    expect(convertVscodeTheme('nope')).toMatchObject({ ok: false });
  });
});

describe('parseJsonc', () => {
  it('strips comments and trailing commas', () => {
    const src = `{
      // a line comment
      "a": 1, /* and a block one */
      "b": [1, 2,],
    }`;
    expect(parseJsonc(src)).toEqual({ a: 1, b: [1, 2] });
  });

  it('leaves comment-like text inside strings alone', () => {
    expect(parseJsonc('{"url": "https://x.dev/y", "s": "a /* b */ c"}')).toEqual({
      url: 'https://x.dev/y',
      s: 'a /* b */ c',
    });
  });

  it('handles an escaped quote inside a string', () => {
    expect(parseJsonc('{"a": "he said \\"hi\\" // not a comment"}')).toEqual({
      a: 'he said "hi" // not a comment',
    });
  });
});

describe('format detection', () => {
  it('tells a VS Code theme apart from an ARC one', () => {
    expect(looksLikeVscodeTheme(DARK)).toBe(true);
    expect(looksLikeVscodeTheme({ name: 'x', tokenColors: [] })).toBe(true);
    expect(looksLikeVscodeTheme({ id: 'x', tokens: {}, xterm: {} })).toBe(false);
    expect(looksLikeVscodeTheme(null)).toBe(false);
  });

  it('slugifies names into stable ids', () => {
    expect(themeIdFor('One Dark Pro')).toBe('vscode-one-dark-pro');
    expect(themeIdFor('  Night Owl (Light)  ')).toBe('vscode-night-owl-light');
    expect(themeIdFor('!!!')).toBe('vscode-theme');
  });
});
