import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Every user-rebindable command in the app. New commands must appear in
 *  DEFAULT_BINDINGS and ACTION_META below — this keeps the dialog, the
 *  dispatcher, and the persisted overrides in lockstep. */
export type ActionId =
  | 'new-terminal'
  | 'open-settings'
  | 'toggle-sidebar'
  | 'open-command-palette'
  | 'open-command-history'
  | 'open-search'
  | 'toggle-chat'
  | 'new-chat'
  | 'toggle-agent-picker'
  | 'open-chat-sessions'
  | 'open-shortcuts'
  | 'toggle-ssh-panel'
  | 'ask-arc-ai'
  | 'launch-claude-cli'
  | 'launch-codex-cli'
  | 'launch-opencode-cli';

export type ActionCategory = 'Workspace' | 'Terminal' | 'Assistant' | 'SSH' | 'AI CLIs' | 'Help';

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
  'toggle-chat': {
    id: 'toggle-chat',
    label: 'Toggle Assistant',
    description: 'Show or hide the assistant popover.',
    category: 'Assistant',
  },
  'new-chat': {
    id: 'new-chat',
    label: 'New Chat Session',
    description: 'Start a fresh chat conversation.',
    category: 'Assistant',
  },
  'toggle-agent-picker': {
    id: 'toggle-agent-picker',
    label: 'Toggle Agent Picker',
    description: 'Show or hide the agent picker inside the assistant.',
    category: 'Assistant',
  },
  'open-chat-sessions': {
    id: 'open-chat-sessions',
    label: 'Chat History',
    description: 'Browse past chat sessions.',
    category: 'Assistant',
  },
  'toggle-ssh-panel': {
    id: 'toggle-ssh-panel',
    label: 'Toggle SSH Panel',
    description: 'Open or close the SSH host & key manager.',
    category: 'SSH',
  },
  'ask-arc-ai': {
    id: 'ask-arc-ai',
    label: 'Ask ARC AI',
    description: 'Send the current selection to ARC AI as context.',
    category: 'Assistant',
  },
  'launch-claude-cli': {
    id: 'launch-claude-cli',
    label: 'Launch Claude Code',
    description: 'Open a new terminal tab running the Claude Code CLI.',
    category: 'AI CLIs',
  },
  'launch-codex-cli': {
    id: 'launch-codex-cli',
    label: 'Launch OpenAI Codex',
    description: 'Open a new terminal tab running the OpenAI Codex CLI.',
    category: 'AI CLIs',
  },
  'launch-opencode-cli': {
    id: 'launch-opencode-cli',
    label: 'Launch OpenCode',
    description: 'Open a new terminal tab running the OpenCode CLI.',
    category: 'AI CLIs',
  },
};

export const ACTION_ORDER: ActionId[] = [
  'new-terminal',
  'open-settings',
  'toggle-sidebar',
  'open-command-palette',
  'open-command-history',
  'open-search',
  'toggle-chat',
  'new-chat',
  'toggle-agent-picker',
  'open-chat-sessions',
  'open-shortcuts',
  'toggle-ssh-panel',
  'ask-arc-ai',
  'launch-claude-cli',
  'launch-codex-cli',
  'launch-opencode-cli',
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
  'open-command-palette': { code: 'KeyK', shift: false, alt: false, ...mod() },
  'open-command-history': { code: 'KeyR', shift: false, alt: false, ...mod() },
  'open-search': { code: 'KeyP', shift: false, alt: false, ...mod() },
  'open-shortcuts': { code: 'Slash', shift: true, alt: false, ...mod() },
  'toggle-chat': { code: 'KeyJ', shift: false, alt: false, ...mod() },
  'new-chat': { code: 'KeyN', shift: true, alt: false, ...mod() },
  'toggle-agent-picker': { code: 'Slash', shift: false, alt: false, ...mod() },
  'open-chat-sessions': { code: 'KeyL', shift: true, alt: false, ...mod() },
  'toggle-ssh-panel': { code: 'KeyS', shift: true, alt: false, ...mod() },
  'ask-arc-ai': { code: 'KeyA', shift: true, alt: false, ...mod() },
  // AI CLI launchers ship unbound by default — users can assign keys via the
  // shortcuts dialog, and they're discoverable through the TabBar dropdown
  // and the new-tab popover regardless.
  'launch-claude-cli': null,
  'launch-codex-cli': null,
  'launch-opencode-cli': null,
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
