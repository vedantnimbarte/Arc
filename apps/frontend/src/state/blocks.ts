import { create } from 'zustand';

// Per-terminal-session command blocks captured from OSC 133. A block spans
// one prompt → command → output → done cycle. Future features (OSC 8 link
// click handlers, inline error explainer, multi-pane history) read from
// here; the Terminal component is the only writer.

export interface CommandBlock {
  /** Stable id — assigned at block start so the renderer can key by it. */
  id: string;
  /** Terminal session (tab id) this block belongs to. */
  sessionKey: string;
  /** Command text. Captured from the user's keystrokes between `B`
   *  (command start) and the first newline. Empty until the user types
   *  the first character; cleared if the user hits Ctrl-C with no input. */
  command: string;
  /** ms since epoch when `C` (output start) fired. */
  startedAt: number;
  /** ms since epoch when `D` (done) fired. `null` while running. */
  finishedAt: number | null;
  /** Process exit code parsed from `D[;<exit>]`. `null` when running or
   *  when the shell didn't include the code. */
  exitCode: number | null;
  /** First 4 KiB of the command's output. Captured between `C` and `D`.
   *  Matches the cap in `Terminal.tsx`. */
  outputExcerpt: string;
  /** True when the user manually collapsed this block in the drawer. UI
   *  state — doesn't survive a tab reload. */
  collapsed: boolean;
}

interface BlocksState {
  /** Block lists keyed by sessionKey. Ordered: oldest first. */
  bySession: Record<string, CommandBlock[]>;
  /** Per-session UI toggle for the bottom drawer. */
  drawerOpen: Record<string, boolean>;
  /** Start a new block. Called on OSC 133 `C` (output start). Returns the
   *  block id so the caller can patch the command text + finish it later. */
  start: (sessionKey: string) => string;
  /** Set the command text for an in-flight block. Called when we see the
   *  user's Enter keypress, which is the moment we know what they ran. */
  setCommand: (sessionKey: string, blockId: string, command: string) => void;
  /** Finalize a block on OSC 133 `D`. Updates exit + output excerpt. */
  finish: (
    sessionKey: string,
    blockId: string,
    exitCode: number | null,
    outputExcerpt: string,
  ) => void;
  /** Wipe blocks for a session — called when the tab closes. Keeps the
   *  store from growing unbounded across long-lived app sessions. */
  clearSession: (sessionKey: string) => void;
  /** Per-block manual collapse — UI affordance for hiding noisy output. */
  toggleCollapsed: (sessionKey: string, blockId: string) => void;
  /** Show/hide the per-session blocks drawer. */
  toggleDrawer: (sessionKey: string) => void;
  setDrawerOpen: (sessionKey: string, open: boolean) => void;
}

let blockCounter = 0;

export const useBlocks = create<BlocksState>((set) => ({
  bySession: {},
  drawerOpen: {},

  start: (sessionKey) => {
    blockCounter += 1;
    const id = `b${blockCounter}-${Date.now().toString(36)}`;
    const block: CommandBlock = {
      id,
      sessionKey,
      command: '',
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      outputExcerpt: '',
      collapsed: false,
    };
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionKey]: [...(s.bySession[sessionKey] ?? []), block],
      },
    }));
    return id;
  },

  setCommand: (sessionKey, blockId, command) =>
    set((s) => {
      const list = s.bySession[sessionKey];
      if (!list) return s;
      const idx = list.findIndex((b) => b.id === blockId);
      if (idx < 0) return s;
      const next = [...list];
      next[idx] = { ...next[idx]!, command };
      return { bySession: { ...s.bySession, [sessionKey]: next } };
    }),

  finish: (sessionKey, blockId, exitCode, outputExcerpt) =>
    set((s) => {
      const list = s.bySession[sessionKey];
      if (!list) return s;
      const idx = list.findIndex((b) => b.id === blockId);
      if (idx < 0) return s;
      const next = [...list];
      next[idx] = {
        ...next[idx]!,
        exitCode,
        outputExcerpt,
        finishedAt: Date.now(),
      };
      return { bySession: { ...s.bySession, [sessionKey]: next } };
    }),

  clearSession: (sessionKey) =>
    set((s) => {
      if (!(sessionKey in s.bySession) && !(sessionKey in s.drawerOpen)) return s;
      const nextBySession = { ...s.bySession };
      delete nextBySession[sessionKey];
      const nextDrawerOpen = { ...s.drawerOpen };
      delete nextDrawerOpen[sessionKey];
      return { bySession: nextBySession, drawerOpen: nextDrawerOpen };
    }),

  toggleCollapsed: (sessionKey, blockId) =>
    set((s) => {
      const list = s.bySession[sessionKey];
      if (!list) return s;
      const idx = list.findIndex((b) => b.id === blockId);
      if (idx < 0) return s;
      const next = [...list];
      next[idx] = { ...next[idx]!, collapsed: !next[idx]!.collapsed };
      return { bySession: { ...s.bySession, [sessionKey]: next } };
    }),

  toggleDrawer: (sessionKey) =>
    set((s) => ({
      drawerOpen: { ...s.drawerOpen, [sessionKey]: !s.drawerOpen[sessionKey] },
    })),

  setDrawerOpen: (sessionKey, open) =>
    set((s) => ({
      drawerOpen: { ...s.drawerOpen, [sessionKey]: open },
    })),
}));

/** Selector: blocks for a session, oldest-first. Empty array when unknown. */
export function blocksForSession(sessionKey: string): CommandBlock[] {
  return useBlocks.getState().bySession[sessionKey] ?? [];
}
