import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { AI_CLIS, type AiCliId } from '../lib/tauri';

/** Every user-rebindable command in the app. New commands must appear in
 *  DEFAULT_BINDINGS and ACTION_META below — this keeps the dialog, the
 *  dispatcher, and the persisted overrides in lockstep. */
export type ActionId =
  | 'new-terminal'
  | 'open-settings'
  | 'toggle-sidebar'
  | 'open-command-palette'
  | 'open-command-history'
  | 'open-command-blocks'
  | 'ai-command'
  | 'open-search'
  | 'open-shortcuts'
  | 'show-explorer'
  | 'show-source-control'
  | 'toggle-ssh-panel'
  /** One launcher per detected CLI, derived from AI_CLIS — see LAUNCH_IDS. */
  | LaunchActionId
  | 'launch-wingman-pilot'
  | 'launch-wingman-headless';

/** `launch-claude-cli`, `launch-codex-cli`, … — one per AI_CLIS entry. */
export type LaunchActionId = `launch-${AiCliId}`;

const LAUNCH_IDS = Object.keys(AI_CLIS) as AiCliId[];

export type ActionCategory = 'Workspace' | 'Terminal' | 'SSH' | 'AI CLIs' | 'Help';

export interface ActionMeta {
  id: ActionId;
  label: string;
  description: string;
  category: ActionCategory;
}

/** A normalized key combo. `code` is `KeyboardEvent.code` to stay layout-
 *  independent (so a French keyboard's `é` still binds to `KeyE`). */
export interface KeyBinding {
  code: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

export const ACTION_META: Record<ActionId, ActionMeta> = {
  'new-terminal': {
    id: 'new-terminal',
    label: 'New Terminal',
    description: 'Open a new terminal tab.',
    category: 'Workspace',
  },
  'open-settings': {
    id: 'open-settings',
    label: 'Open Settings',
    description: 'Open the Settings dialog.',
    category: 'Workspace',
  },
  'toggle-sidebar': {
    id: 'toggle-sidebar',
    label: 'Toggle Sidebar',
    description: 'Show or hide the file-tree sidebar.',
    category: 'Workspace',
  },
  'open-command-palette': {
    id: 'open-command-palette',
    label: 'Command Palette',
    description: 'Open the unified action palette.',
    category: 'Workspace',
  },
  'open-command-history': {
    id: 'open-command-history',
    label: 'Command History',
    description: 'Open the command-history palette.',
    category: 'Workspace',
  },
  'open-command-blocks': {
    id: 'open-command-blocks',
    label: 'Command Blocks',
    description: 'Browse recent commands as blocks with their output.',
    category: 'Terminal',
  },
  'ai-command': {
    id: 'ai-command',
    label: 'Ask for a Command',
    description: 'Describe a command in plain English and put the result on the shell prompt.',
    category: 'Terminal',
  },
  'open-search': {
    id: 'open-search',
    label: 'Search Files',
    description: 'Open the workspace file-search palette.',
    category: 'Workspace',
  },
  'open-shortcuts': {
    id: 'open-shortcuts',
    label: 'Keyboard Shortcuts',
    description: 'Open the shortcuts cheat-sheet / editor.',
    category: 'Help',
  },
  'show-explorer': {
    id: 'show-explorer',
    label: 'Show Explorer',
    description: 'Reveal the file tree in the sidebar.',
    category: 'Workspace',
  },
  'show-source-control': {
    id: 'show-source-control',
    label: 'Show Source Control',
    description: 'Reveal source control in the sidebar.',
    category: 'Workspace',
  },
  'toggle-ssh-panel': {
    id: 'toggle-ssh-panel',
    label: 'Toggle SSH Panel',
    description: 'Open or close the SSH host & key manager.',
    category: 'SSH',
  },
  ...(Object.fromEntries(
    LAUNCH_IDS.map((cli) => [
      `launch-${cli}`,
      {
        id: `launch-${cli}`,
        label: `Launch ${AI_CLIS[cli]}`,
        description: `Open a new terminal tab running ${AI_CLIS[cli]}.`,
        category: 'AI CLIs',
      },
    ]),
  ) as Record<LaunchActionId, ActionMeta>),
  'launch-wingman-pilot': {
    id: 'launch-wingman-pilot',
    label: 'Launch Wingman Pilot',
    description: 'Prompt for a goal, then run Wingman pilot mode in a terminal tab.',
    category: 'AI CLIs',
  },
  'launch-wingman-headless': {
    id: 'launch-wingman-headless',
    label: 'Launch Wingman (headless)',
    description: 'Prompt for a message, then run a one-shot headless Wingman response.',
    category: 'AI CLIs',
  },
};

export const ACTION_ORDER: ActionId[] = [
  'new-terminal',
  'open-settings',
  'toggle-sidebar',
  'open-command-palette',
  'open-command-history',
  'open-command-blocks',
  'ai-command',
  'open-search',
  'open-shortcuts',
  'show-explorer',
  'show-source-control',
  'toggle-ssh-panel',
  ...LAUNCH_IDS.map((cli) => `launch-${cli}` as LaunchActionId),
  'launch-wingman-pilot',
  'launch-wingman-headless',
];

const mod = (extra: Partial<KeyBinding> = {}): Pick<KeyBinding, 'ctrl' | 'meta'> => ({
  ctrl: true,
  meta: true,
  ...extra,
});

export const DEFAULT_BINDINGS: Record<ActionId, KeyBinding | null> = {
  'new-terminal': { code: 'KeyT', shift: false, alt: false, ...mod() },
  'open-settings': { code: 'Comma', shift: false, alt: false, ...mod() },
  'toggle-sidebar': { code: 'KeyB', shift: false, alt: false, ...mod() },
  'open-command-palette': { code: 'KeyP', shift: true, alt: false, ...mod() },
  'open-command-history': { code: 'KeyR', shift: false, alt: false, ...mod() },
  'open-command-blocks': { code: 'KeyR', shift: true, alt: false, ...mod() },
  'ai-command': { code: 'KeyK', shift: false, alt: false, ...mod() },
  'open-search': { code: 'KeyP', shift: false, alt: false, ...mod() },
  'open-shortcuts': { code: 'Slash', shift: true, alt: false, ...mod() },
  'show-explorer': { code: 'KeyE', shift: true, alt: false, ...mod() },
  'show-source-control': { code: 'KeyG', shift: true, alt: false, ...mod() },
  'toggle-ssh-panel': { code: 'KeyS', shift: true, alt: false, ...mod() },
  // AI CLI launchers ship unbound by default — users can assign keys via the
  // shortcuts dialog, and they're discoverable through the TabBar dropdown
  // and the new-tab popover regardless.
  ...(Object.fromEntries(LAUNCH_IDS.map((cli) => [`launch-${cli}`, null])) as Record<
    LaunchActionId,
    null
  >),
  'launch-wingman-pilot': null,
  'launch-wingman-headless': null,
};

interface ShortcutsState {
  /** Sparse — only entries the user has changed. Falls back to DEFAULT_BINDINGS. */
  overrides: Partial<Record<ActionId, KeyBinding | null>>;
  setBinding: (id: ActionId, binding: KeyBinding) => void;
  /** Disable an action (block the default) without picking a new combo. */
  clearBinding: (id: ActionId) => void;
  resetBinding: (id: ActionId) => void;
  resetAll: () => void;
}

export const useShortcuts = create<ShortcutsState>()(
  persist(
    (set) => ({
      overrides: {},
      setBinding: (id, binding) =>
        set((s) => ({ overrides: { ...s.overrides, [id]: binding } })),
      clearBinding: (id) =>
        set((s) => ({ overrides: { ...s.overrides, [id]: null } })),
      resetBinding: (id) =>
        set((s) => {
          const { [id]: _omit, ...rest } = s.overrides;
          return { overrides: rest };
        }),
      resetAll: () => set({ overrides: {} }),
    }),
    { name: 'arc-shortcuts', version: 1 },
  ),
);

/** Resolve the active binding for `id`, honoring user overrides.
 *  `null` means the user explicitly disabled the action. */
export function getBinding(id: ActionId): KeyBinding | null {
  const ov = useShortcuts.getState().overrides[id];
  if (ov === undefined) return DEFAULT_BINDINGS[id];
  return ov;
}

export function bindingsEqual(a: KeyBinding, b: KeyBinding): boolean {
  return (
    a.code === b.code &&
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    a.alt === b.alt &&
    a.meta === b.meta
  );
}

/** True if the keydown event matches `binding`. We accept Ctrl OR Meta
 *  when both are required so the same combo works on Windows (Ctrl) and
 *  macOS (⌘) without separate bindings. */
export function matchBinding(binding: KeyBinding, e: KeyboardEvent): boolean {
  if (e.code !== binding.code) return false;
  if (e.shiftKey !== binding.shift) return false;
  if (e.altKey !== binding.alt) return false;
  // Cross-platform mod: if either ctrl or meta is required, accept either.
  if (binding.ctrl || binding.meta) {
    if (!(e.ctrlKey || e.metaKey)) return false;
  } else {
    if (e.ctrlKey || e.metaKey) return false;
  }
  return true;
}

/** Find which action (if any) was triggered by this event. Honors overrides. */
export function actionFor(e: KeyboardEvent): ActionId | null {
  const overrides = useShortcuts.getState().overrides;
  for (const id of ACTION_ORDER) {
    const ov = overrides[id];
    const binding = ov === undefined ? DEFAULT_BINDINGS[id] : ov;
    if (!binding) continue; // user disabled
    if (matchBinding(binding, e)) return id;
  }
  return null;
}

const IS_MAC =
  typeof navigator !== 'undefined' &&
  /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');

/** Pretty-print a binding for display. `null` renders as "Disabled". */
export function formatBinding(binding: KeyBinding | null): string {
  if (!binding) return 'Disabled';
  const parts: string[] = [];
  if (binding.ctrl || binding.meta) parts.push(IS_MAC ? '⌘' : 'Ctrl');
  if (binding.alt) parts.push(IS_MAC ? '⌥' : 'Alt');
  if (binding.shift) parts.push(IS_MAC ? '⇧' : 'Shift');
  parts.push(formatCode(binding.code));
  return parts.join(IS_MAC ? '' : '+');
}

function formatCode(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'Comma') return ',';
  if (code === 'Period') return '.';
  if (code === 'Slash') return '/';
  if (code === 'Backslash') return '\\';
  if (code === 'Semicolon') return ';';
  if (code === 'Quote') return "'";
  if (code === 'Backquote') return '`';
  if (code === 'Minus') return '-';
  if (code === 'Equal') return '=';
  if (code === 'BracketLeft') return '[';
  if (code === 'BracketRight') return ']';
  if (code === 'Space') return 'Space';
  if (code === 'Enter') return 'Enter';
  if (code === 'Tab') return 'Tab';
  if (code === 'Escape') return 'Esc';
  if (code === 'Backspace') return 'Backspace';
  if (code === 'ArrowUp') return '↑';
  if (code === 'ArrowDown') return '↓';
  if (code === 'ArrowLeft') return '←';
  if (code === 'ArrowRight') return '→';
  return code;
}

/** Build a binding from a captured KeyboardEvent — used by the
 *  rebind UI. Returns null if the event is a modifier-only press. */
export function bindingFromEvent(e: KeyboardEvent): KeyBinding | null {
  // Bare modifier press is not a usable binding.
  if (
    e.code === 'ControlLeft' ||
    e.code === 'ControlRight' ||
    e.code === 'ShiftLeft' ||
    e.code === 'ShiftRight' ||
    e.code === 'AltLeft' ||
    e.code === 'AltRight' ||
    e.code === 'MetaLeft' ||
    e.code === 'MetaRight'
  ) {
    return null;
  }
  return {
    code: e.code,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    meta: e.metaKey,
  };
}

// ─── Built-in (non-rebindable) shortcuts ────────────────────────────────────
// A reference list of the keystrokes hardcoded across the editor, terminal,
// chat composer, pickers and dialogs. These aren't user-rebindable, but the
// Shortcuts dialog surfaces them so the list reflects *every* shortcut the
// app supports — not just the customizable ones above.

export type ReferenceCategory =
  | 'Editor'
  | 'Terminal'
  | 'File Tree'
  | 'Source Control'
  | 'Navigation';

export interface ReferenceShortcut {
  /** Platform-resolved display string (e.g. "⌘S" on macOS, "Ctrl+S" on Win). */
  keys: string;
  label: string;
  description: string;
  category: ReferenceCategory;
}

const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl';
const ALT_KEY = IS_MAC ? '⌥' : 'Alt';
const SHIFT_KEY = IS_MAC ? '⇧' : 'Shift';
const KEY_SEP = IS_MAC ? '' : '+';
const combo = (...parts: string[]) => parts.join(KEY_SEP);

export const REFERENCE_CATEGORIES: ReferenceCategory[] = [
  'Editor',
  'Terminal',
  'File Tree',
  'Source Control',
  'Navigation',
];

export const REFERENCE_SHORTCUTS: ReferenceShortcut[] = [
  // Editor (CodeMirror)
  {
    keys: combo(MOD_KEY, 'S'),
    label: 'Save File',
    description: 'Write the active editor tab to disk.',
    category: 'Editor',
  },
  {
    keys: combo(MOD_KEY, 'F'),
    label: 'Find in File',
    description: 'Open the editor search panel.',
    category: 'Editor',
  },
  {
    keys: combo(MOD_KEY, 'D'),
    label: 'Select Next Occurrence',
    description: 'Add the next match of the selection as a new cursor.',
    category: 'Editor',
  },
  {
    keys: combo(MOD_KEY, 'Z'),
    label: 'Undo',
    description: 'Undo the last editor change.',
    category: 'Editor',
  },
  {
    keys: IS_MAC ? combo('⌘', '⇧', 'Z') : combo('Ctrl', 'Y'),
    label: 'Redo',
    description: 'Redo the last undone editor change.',
    category: 'Editor',
  },
  {
    keys: 'Alt-Click',
    label: 'Add Cursor',
    description: 'Drop an additional cursor in the editor.',
    category: 'Editor',
  },
  {
    keys: 'Alt-Drag',
    label: 'Rectangular Selection',
    description: 'Select a column / box of text.',
    category: 'Editor',
  },
  // Terminal
  {
    keys: combo(SHIFT_KEY, 'Paste'),
    label: 'Force Paste',
    description: 'Paste into the terminal, bypassing the risky-paste warning.',
    category: 'Terminal',
  },
  // File Tree
  {
    keys: 'Alt-Click',
    label: 'Paste Path',
    description: 'Insert a file path into the active terminal.',
    category: 'File Tree',
  },
  {
    keys: 'Double-Click',
    label: 'Change Directory',
    description: 'Paste `cd <folder>` into the active terminal.',
    category: 'File Tree',
  },
  // Source Control
  {
    keys: combo(MOD_KEY, 'Enter'),
    label: 'Commit',
    description: 'Submit the commit message in Source Control.',
    category: 'Source Control',
  },
  // Navigation (palettes, pickers & dialogs)
  {
    keys: '↑ / ↓',
    label: 'Move Selection',
    description: 'Navigate items in palettes, pickers and popovers.',
    category: 'Navigation',
  },
  {
    keys: 'Enter',
    label: 'Confirm',
    description: 'Choose the highlighted item or confirm a dialog.',
    category: 'Navigation',
  },
  {
    keys: 'Esc',
    label: 'Dismiss',
    description: 'Close the open palette, popover or dialog.',
    category: 'Navigation',
  },
  {
    keys: '← / → / Home / End',
    label: 'Switch Sidebar View',
    description: 'Move between activity-bar views when the rail is focused.',
    category: 'Navigation',
  },
];

/** Returns the action that would conflict with `binding`, or null. */
export function findConflict(binding: KeyBinding, ignore?: ActionId): ActionId | null {
  const overrides = useShortcuts.getState().overrides;
  for (const id of ACTION_ORDER) {
    if (id === ignore) continue;
    const ov = overrides[id];
    const existing = ov === undefined ? DEFAULT_BINDINGS[id] : ov;
    if (!existing) continue;
    if (bindingsEqual(existing, binding)) return id;
  }
  return null;
}
