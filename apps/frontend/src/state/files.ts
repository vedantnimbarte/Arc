import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 260;

export const CHAT_MIN = 260;
export const CHAT_MAX = 560;
export const CHAT_DEFAULT = 340;

/** Which panel is showing in the left sidebar. Driven by the sidebar's
 *  activity rail (Explorer / Source Control / SSH). */
export type SidebarView = 'files' | 'git' | 'ssh';

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
  /** Which panel is mounted in the left sidebar. Persisted. */
  sidebarView: SidebarView;
  /** Last sidebar view per workspace root, so each project reopens on the
   *  view you left it on. Keyed by absolute root path. Persisted. */
  viewByRoot: Record<string, SidebarView>;
  /** Absolute paths of recently-opened editor files, most-recent first.
   *  Surfaced on the new-tab splash. Capped + persisted. */
  recentFiles: string[];
  setRoot: (root: string) => void;
  /** Record a file as recently opened (deduped, moved to front, capped). */
  pushRecentFile: (path: string) => void;
  toggleHidden: () => void;
  toggleCollapsed: () => void;
  setSidebarWidth: (w: number) => void;
  setChatWidth: (w: number) => void;
  setSidebarView: (view: SidebarView) => void;
  /** Reveal a view: un-collapse the sidebar and switch to it. */
  showSidebarView: (view: SidebarView) => void;
  /** Toggle a view: if it's already the visible view, fall back to the
   *  Explorer; otherwise reveal it. Powers the SSH / git launcher buttons. */
  toggleSidebarView: (view: SidebarView) => void;
}

const clamp = (n: number, min: number, max: number) =>
  Math.min(Math.max(n, min), max);

/** Record `view` as the last-used view for `root` (no-op without a root). */
function rememberView(
  viewByRoot: Record<string, SidebarView>,
  root: string | null,
  view: SidebarView,
): Record<string, SidebarView> {
  if (!root) return viewByRoot;
  return { ...viewByRoot, [root]: view };
}

const STORAGE_KEY = 'arc-files';
const RECENT_FILES_CAP = 12;

export const useFiles = create<FilesState>()(
  persist(
    (set) => ({
      root: null,
      showHidden: false,
      collapsed: false,
      sidebarWidth: SIDEBAR_DEFAULT,
      chatWidth: CHAT_DEFAULT,
      sidebarView: 'files',
      viewByRoot: {},
      recentFiles: [],
      // Switching workspace root restores that root's last view (falling back
      // to the current view for roots we haven't seen before).
      setRoot: (root) =>
        set((s) => ({ root, sidebarView: s.viewByRoot[root] ?? s.sidebarView })),
      pushRecentFile: (path) =>
        set((s) => ({
          recentFiles: [path, ...s.recentFiles.filter((p) => p !== path)].slice(
            0,
            RECENT_FILES_CAP,
          ),
        })),
      toggleHidden: () => set((s) => ({ showHidden: !s.showHidden })),
      toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
      setSidebarWidth: (w) => set({ sidebarWidth: clamp(w, SIDEBAR_MIN, SIDEBAR_MAX) }),
      setChatWidth: (w) => set({ chatWidth: clamp(w, CHAT_MIN, CHAT_MAX) }),
      setSidebarView: (view) =>
        set((s) => ({
          sidebarView: view,
          viewByRoot: rememberView(s.viewByRoot, s.root, view),
        })),
      showSidebarView: (view) =>
        set((s) => ({
          collapsed: false,
          sidebarView: view,
          viewByRoot: rememberView(s.viewByRoot, s.root, view),
        })),
      toggleSidebarView: (view) =>
        set((s) => {
          const next: SidebarView =
            s.sidebarView === view && !s.collapsed ? 'files' : view;
          return {
            collapsed: false,
            sidebarView: next,
            viewByRoot: rememberView(s.viewByRoot, s.root, next),
          };
        }),
    }),
    {
      name: STORAGE_KEY,
      version: 3,
      // v2 stored the source-control view under the old 'source-control'
      // key; the activity rail renamed it to 'git'.
      migrate: (persisted, version) => {
        const state = persisted as Partial<FilesState> | undefined;
        if (state && version < 3 && (state.sidebarView as string) === 'source-control') {
          state.sidebarView = 'git';
        }
        return state as FilesState;
      },
    },
  ),
);

// The Settings window is a separate Tauri window with its own JS context.
// localStorage is shared (same origin), but Zustand state isn't — so a
// toggle in Settings won't reach the main window's FileTree without this
// cross-window rehydrate.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      void useFiles.persist.rehydrate();
    }
  });
}
