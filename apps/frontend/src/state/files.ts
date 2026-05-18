import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 260;

export const CHAT_MIN = 260;
export const CHAT_MAX = 560;
export const CHAT_DEFAULT = 340;

interface FilesState {
  /**
   * Root the file tree is showing. New terminals inherit this as their CWD,
   * which is what "show the file tree from the selected folder in terminal"
   * means in practice — pick a folder, spawn a shell that lives in it.
   */
  root: string | null;
  showHidden: boolean;
  /** Whether the file-tree sidebar is hidden. Toggled via ⌘B / Ctrl+B. */
  collapsed: boolean;
  /** Persistent pane widths (px). Clamped on the way in. */
  sidebarWidth: number;
  chatWidth: number;
  setRoot: (root: string) => void;
  toggleHidden: () => void;
  toggleCollapsed: () => void;
  setSidebarWidth: (w: number) => void;
  setChatWidth: (w: number) => void;
}

const clamp = (n: number, min: number, max: number) =>
  Math.min(Math.max(n, min), max);

export const useFiles = create<FilesState>()(
  persist(
    (set) => ({
      root: null,
      showHidden: false,
      collapsed: false,
      sidebarWidth: SIDEBAR_DEFAULT,
      chatWidth: CHAT_DEFAULT,
      setRoot: (root) => set({ root }),
      toggleHidden: () => set((s) => ({ showHidden: !s.showHidden })),
      toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
      setSidebarWidth: (w) => set({ sidebarWidth: clamp(w, SIDEBAR_MIN, SIDEBAR_MAX) }),
      setChatWidth: (w) => set({ chatWidth: clamp(w, CHAT_MIN, CHAT_MAX) }),
    }),
    { name: 'arc-files', version: 2 },
  ),
);
