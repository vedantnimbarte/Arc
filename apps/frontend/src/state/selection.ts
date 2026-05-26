import { create } from 'zustand';

/** Which pane the current selection came from. */
export type SelectionSource = 'terminal' | 'editor';

export interface SelectionInfo {
  source: SelectionSource;
  /** Tab id that owns the selection. Used so a panel can clear *its own*
   *  selection on unmount without stomping on another pane's. */
  sourceId: string;
  /** Display label for the chip header, e.g. "Editor · index.ts". */
  label: string;
  /** Full selected text, untrimmed. */
  text: string;
  /** Viewport-coordinate rect of the selection anchor — used to position
   *  the floating "Ask ARC AI" button. `null` if measurement failed. */
  rect: { left: number; top: number; width: number; height: number } | null;
}

interface SelectionState {
  current: SelectionInfo | null;
  set: (info: SelectionInfo) => void;
  /** Clear the current selection. If `source`/`sourceId` are provided,
   *  only clears when the current selection matches — so an unmounting
   *  pane doesn't wipe another pane's active selection. */
  clear: (source?: SelectionSource, sourceId?: string) => void;
}

export const useSelection = create<SelectionState>((set, get) => ({
  current: null,
  set: (info) => {
    if (!info.text || !info.text.trim()) {
      set({ current: null });
      return;
    }
    set({ current: info });
  },
  clear: (source, sourceId) => {
    const cur = get().current;
    if (!cur) return;
    if (source && cur.source !== source) return;
    if (sourceId && cur.sourceId !== sourceId) return;
    set({ current: null });
  },
}));
