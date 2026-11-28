// Arc ships one look: the dark palette in `index.css` (`:root` variables,
// read by the Tailwind tokens) plus the matching terminal colours below.

import type { ITheme } from '@xterm/xterm';

/** Code font for the terminal and every CodeMirror surface. The interface
 *  itself is set in Inter (Tailwind's `font-display`). */
export const CODE_FONT_STACK =
  "'SF Mono', 'JetBrains Mono Variable', 'JetBrains Mono', Menlo, Consolas, monospace";

export const DEFAULT_FONT_SIZE = 13;
export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 24;

/** Terminal palette. The background is drawn transparent by the terminal
 *  hosts, so the pane colour shows through; it's set here for xterm's own
 *  contrast maths. */
export const XTERM_THEME: ITheme = {
  background: '#1c1f23',
  foreground: '#e8eaed',
  cursor: '#e8eaed',
  cursorAccent: '#1c1f23',
  selectionBackground: 'rgba(142, 197, 255, 0.28)',
  black: '#262a30', red: '#ff6b6b', green: '#3ad28a', yellow: '#f0a958',
  blue: '#8ec5ff', magenta: '#c3a6ff', cyan: '#7ec8d0', white: '#d4d6dc',
  brightBlack: '#6f7682', brightRed: '#ff8a8a', brightGreen: '#65e0a4',
  brightYellow: '#ffc370', brightBlue: '#badcff', brightMagenta: '#d8c2ff',
  brightCyan: '#a8d6dc', brightWhite: '#f3f5f8',
};
