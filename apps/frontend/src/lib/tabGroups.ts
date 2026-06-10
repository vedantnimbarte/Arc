// Tab-group colour system — the Chrome-style group palette, adapted to ARC's
// graphite/silver dark surface. Group colours are inherently dynamic (a user
// choice), so unlike the app chrome they can't live in the Tailwind token
// table; this module is the single source of truth instead. Everything that
// paints a group — the strip, the chip, the colour picker — derives its
// styles from `groupColorTokens()` so they stay perfectly in sync.

export type TabGroupColorId =
  | 'slate'
  | 'blue'
  | 'cyan'
  | 'green'
  | 'amber'
  | 'orange'
  | 'rose'
  | 'violet';

export interface TabGroupColorDef {
  id: TabGroupColorId;
  label: string;
  /** The dominant hue — swatch fill, active accent rail, collapsed chip dot. */
  hex: string;
}

/** Ordered palette. Order doubles as the auto-assign rotation for new groups. */
export const TAB_GROUP_COLORS: TabGroupColorDef[] = [
  { id: 'slate', label: 'Slate', hex: '#9aa3b5' },
  { id: 'blue', label: 'Blue', hex: '#5b9dff' },
  { id: 'cyan', label: 'Cyan', hex: '#36c8d8' },
  { id: 'green', label: 'Green', hex: '#3ad28a' },
  { id: 'amber', label: 'Amber', hex: '#f0b056' },
  { id: 'orange', label: 'Orange', hex: '#ff8a5b' },
  { id: 'rose', label: 'Rose', hex: '#ff6f8d' },
  { id: 'violet', label: 'Violet', hex: '#b48cff' },
];

const BY_ID = new Map(TAB_GROUP_COLORS.map((c) => [c.id, c]));

export const DEFAULT_GROUP_COLOR: TabGroupColorId = 'blue';

export function groupColorDef(id: TabGroupColorId): TabGroupColorDef {
  return BY_ID.get(id) ?? TAB_GROUP_COLORS[1]!;
}

/** Pick the next palette colour not already in use, else rotate by count so a
 *  9th group still gets a deterministic colour. */
export function nextGroupColor(used: TabGroupColorId[]): TabGroupColorId {
  const taken = new Set(used);
  const free = TAB_GROUP_COLORS.find((c) => !taken.has(c.id));
  if (free) return free.id;
  return TAB_GROUP_COLORS[used.length % TAB_GROUP_COLORS.length]!.id;
}

// ─── Colour math ───────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h,
    16,
  );
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `rgba(hex, a)` → a css colour string. */
export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Mix a colour toward white by `amt` (0–1) — used to lift the label text off
 *  the saturated hue so it reads on the dark surface. */
function lighten(hex: string, amt: number): string {
  const [r, g, b] = hexToRgb(hex);
  const mix = (c: number) => Math.round(c + (255 - c) * amt);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

export interface GroupColorTokens {
  /** Raw hue. */
  solid: string;
  /** Label / icon text — lifted toward white for legibility. */
  text: string;
  /** Header-chip background. */
  chipBg: string;
  /** Header-chip background on hover. */
  chipBgHover: string;
  /** Header-chip hairline. */
  chipBorder: string;
  /** Expanded-group wrapper background — barely-there tint. */
  wrapBg: string;
  /** Expanded-group wrapper hairline + the left accent rail. */
  wrapBorder: string;
  /** Soft glow for an active/selected member inside the group. */
  activeBg: string;
  /** The colour-coded rail painted across the top of the group's roof. */
  rail: string;
  /** Ambient bloom beneath the rail when the group is active. */
  railGlow: string;
}

/** Resolve every style token a group needs from its colour id. Memo-free; the
 *  arithmetic is cheap and the call sites are few. */
export function groupColorTokens(id: TabGroupColorId): GroupColorTokens {
  const hex = groupColorDef(id).hex;
  return {
    solid: hex,
    text: lighten(hex, 0.42),
    chipBg: rgba(hex, 0.18),
    chipBgHover: rgba(hex, 0.26),
    chipBorder: rgba(hex, 0.34),
    wrapBg: rgba(hex, 0.07),
    wrapBorder: rgba(hex, 0.26),
    activeBg: rgba(hex, 0.2),
    rail: rgba(hex, 0.95),
    railGlow: rgba(hex, 0.4),
  };
}
