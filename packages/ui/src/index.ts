// Shared UI primitives for ARC. Currently the only reusable export is
// the Catppuccin Mocha palette — the colour reference both the editor
// syntax theme and the file-tree icon palette pull from. Components
// themselves still live in apps/frontend until there's a second
// consumer.

/** Catppuccin Mocha palette — official hex values. Re-exported by
 *  `@arc/frontend` for `fileIcons.ts` and the CodeMirror highlight; new
 *  components should import this directly. */
export const MOCHA = {
  rosewater: '#f5e0dc',
  flamingo: '#f2cdcd',
  pink: '#f5c2e7',
  mauve: '#cba6f7',
  red: '#f38ba8',
  maroon: '#eba0ac',
  peach: '#fab387',
  yellow: '#f9e2af',
  green: '#a6e3a1',
  teal: '#94e2d5',
  sky: '#89dceb',
  sapphire: '#74c7ec',
  blue: '#89b4fa',
  lavender: '#b4befe',
  text: '#cdd6f4',
  subtext1: '#bac2de',
  subtext0: '#a6adc8',
  overlay2: '#9399b2',
  overlay1: '#7f849c',
  overlay0: '#6c7086',
  surface2: '#585b70',
} as const;

export type MochaKey = keyof typeof MOCHA;
