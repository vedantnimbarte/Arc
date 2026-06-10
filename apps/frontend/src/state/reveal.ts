import { create } from 'zustand';

/**
 * Pending "jump to line" requests for editor tabs. Decoupled from the
 * workspace store (and its persistence) because a reveal is ephemeral UI
 * intent, not durable tab state.
 *
 * Flow: a caller that opens a file at a target line — e.g. a clicked terminal
 * path link carrying `:line` — sets a pending line for the tab. The mounted
 * `<Editor>` for that tab subscribes, applies the scroll/selection once it's
 * ready, and consumes the entry. Routing through a store (rather than a mount
 * prop) means it works whether `openFile` spawns a new tab or re-focuses an
 * already-open one.
 */
interface RevealState {
  /** tabId → 1-based line to reveal once that tab's editor is ready. */
  pending: Record<string, number>;
  /** Request that the editor for `tabId` reveal `line` (1-based). */
  request: (tabId: string, line: number) => void;
  /** Clear any pending reveal for `tabId` (called after it's applied). */
  consume: (tabId: string) => void;
}

export const useReveal = create<RevealState>((set) => ({
  pending: {},
  request: (tabId, line) => set((s) => ({ pending: { ...s.pending, [tabId]: line } })),
  consume: (tabId) =>
    set((s) => {
      if (!(tabId in s.pending)) return s;
      const { [tabId]: _omit, ...rest } = s.pending;
      return { pending: rest };
    }),
}));
