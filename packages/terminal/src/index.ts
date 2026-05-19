// Terminal package — xterm.js theming + (eventually) the React shell
// that wraps it.
//
// Today this package only exports the graphite XTERM_THEME the
// Terminal component uses. When we have a second consumer (e.g. a
// popout window) the React component itself moves here.

import type { ITheme } from '@xterm/xterm';

/**
 * Graphite base + platinum cursor/selection. The ANSI palette stays
 * close to the macOS Terminal defaults so syntax highlighting in `ls`,
 * `git`, etc. still reads correctly; only the accent + cursor shift to
 * silver.
 */
export const XTERM_THEME: ITheme = {
  background: '#161618',
  foreground: '#eef0f3',
  cursor: '#d4d6dc',
  cursorAccent: '#161618',
  selectionBackground: 'rgba(200, 210, 225, 0.32)',

  black: '#28282a',
  red: '#ff5252',
  green: '#3ad28a',
  yellow: '#f0a958',
  // cool steel-blue so `ls` directories still feel "blue"
  blue: '#9cb5d4',
  magenta: '#bf9ff2',
  cyan: '#7ec8d0',
  white: '#d4d6dc',

  brightBlack: '#6c6c70',
  brightRed: '#ff7a78',
  brightGreen: '#65e0a4',
  brightYellow: '#ffc370',
  brightBlue: '#c1d2e6',
  brightMagenta: '#d8b7ff',
  brightCyan: '#a8d6dc',
  brightWhite: '#f3f5f8',
};
