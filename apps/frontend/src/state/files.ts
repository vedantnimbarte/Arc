import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 260;
/** Width of the icon-only activity rail. */
export const SIDEBAR_RAIL_WIDTH = 44;
/** Width of the same rail with view names shown beside the icons. Wide enough
 *  for the longest label ("Source Control") at `text-2xs`. */
export const SIDEBAR_RAIL_WIDTH_LABELED = 128;

/** Which panel is showing in the left sidebar. Driven by the sidebar's
 *  activity rail (Explorer / Source Control / SSH / Search / Outline). */
export type SidebarView =
  | 'files'
  | 'git'
  | 'search'
  | 'outline'
  | 'problems'
  | 'tests'
  | 'docker'
  | 'ssh'
  | 'agents';

/** Which agent the Agents panel is showing. The two that ARC can drive
 *  headlessly get a chat surface; everything else launches in a terminal from
 *  the same panel. Lives here rather than in the panel so the command palette
 *  can open the sidebar straight onto one of them. */
export type AgentPanelTab = 'claude' | 'wingman';

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
  /** Remembered sidebar width per view, so each view keeps its own size
   *  (SSH wider than Explorer, etc.). Keyed by view id. Persisted. */
  widthByView: Record<string, number>;
  /** Which panel is mounted in the left sidebar. Persisted. */
  sidebarView: SidebarView;
  /** Selected agent inside the Agents panel. */
  agentPanelTab: AgentPanelTab;
  /** Last sidebar view per workspace root, so each project reopens on the
   *  view you left it on. Keyed by absolute root path. Persisted. */
  viewByRoot: Record<string, SidebarView>;
  /** Absolute paths of recently-opened editor files, most-recent first.
   *  Surfaced on the new-tab splash. Capped + persisted. */
  recentFiles: string[];
  /** Show view names next to the activity-rail icons. On by default: eight
   *  unlabelled glyphs is the single biggest thing new users can't decode.
   *  Turned off from the rail's context menu once you know them. Persisted. */
  railLabels: boolean;
  setRoot: (root: string) => void;
  /** Record a file as recently opened (deduped, moved to front, capped). */
  pushRecentFile: (path: string) => void;
  toggleHidden: () => void;
  toggleCollapsed: () => void;
  setSidebarWidth: (w: number) => void;
  setSidebarView: (view: SidebarView) => void;
  setAgentPanelTab: (tab: AgentPanelTab) => void;
  /** Reveal a view: un-collapse the sidebar and switch to it. */
  showSidebarView: (view: SidebarView) => void;
  /** Toggle a view: if it's already the visible view, fall back to the
   *  Explorer; otherwise reveal it. Powers the SSH / git launcher buttons. */
  toggleSidebarView: (view: SidebarView) => void;
  toggleRailLabels: () => void;
}

const clamp = (n: number, min: number, max: number) =>
  Math.min(Math.max(n, min), max);

/** Per-view default width — SSH / Search want a touch more room than the file
 *  tree. Falls back to SIDEBAR_DEFAULT for anything unlisted. */
const DEFAULT_WIDTH_BY_VIEW: Record<string, number> = {
  files: SIDEBAR_DEFAULT,
  git: SIDEBAR_DEFAULT,
  ssh: 300,
  search: 300,
  outline: 240,
};

export function defaultWidthForView(view: SidebarView): number {
  return clamp(DEFAULT_WIDTH_BY_VIEW[view] ?? SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX);
}

/** Resolve the width to apply for `view`: a remembered width, else its default. */
function widthForView(widthByView: Record<string, number>, view: SidebarView): number {
  return widthByView[view] ?? defaultWidthForView(view);
}

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
      widthByView: {},
      sidebarView: 'files',
      agentPanelTab: 'claude',
      viewByRoot: {},
      recentFiles: [],
      railLabels: false,
      // Switching workspace root restores that root's last view (falling back
      // to the current view for roots we haven't seen before) and that view's
      // remembered width.
      setRoot: (root) =>
        set((s) => {
          const view = s.viewByRoot[root] ?? s.sidebarView;
          return { root, sidebarView: view, sidebarWidth: widthForView(s.widthByView, view) };
        }),
      pushRecentFile: (path) =>
        set((s) => ({
          recentFiles: [path, ...s.recentFiles.filter((p) => p !== path)].slice(
            0,
            RECENT_FILES_CAP,
          ),
        })),
      toggleHidden: () => set((s) => ({ showHidden: !s.showHidden })),
      toggleRailLabels: () => set((s) => ({ railLabels: !s.railLabels })),
      toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
      // Width is recorded against the *current* view so each view keeps its own.
      setSidebarWidth: (w) =>
        set((s) => {
          const width = clamp(w, SIDEBAR_MIN, SIDEBAR_MAX);
          return {
            sidebarWidth: width,
            widthByView: { ...s.widthByView, [s.sidebarView]: width },
          };
        }),
      setAgentPanelTab: (tab) => set({ agentPanelTab: tab }),
      setSidebarView: (view) =>
        set((s) => ({
          sidebarView: view,
          sidebarWidth: widthForView(s.widthByView, view),
          viewByRoot: rememberView(s.viewByRoot, s.root, view),
        })),
      showSidebarView: (view) =>
        set((s) => ({
          collapsed: false,
          sidebarView: view,
          sidebarWidth: widthForView(s.widthByView, view),
          viewByRoot: rememberView(s.viewByRoot, s.root, view),
        })),
      toggleSidebarView: (view) =>
        set((s) => {
          const next: SidebarView =
            s.sidebarView === view && !s.collapsed ? 'files' : view;
          return {
            collapsed: false,
            sidebarView: next,
            sidebarWidth: widthForView(s.widthByView, next),
            viewByRoot: rememberView(s.viewByRoot, s.root, next),
          };
        }),
    }),
    {
      name: STORAGE_KEY,
      version: 5,
      // v2 stored the source-control view under the old 'source-control'
      // key; the activity rail renamed it to 'git'.
      migrate: (persisted, version) => {
        const state = persisted as Partial<FilesState> | undefined;
        if (state && version < 3 && (state.sidebarView as string) === 'source-control') {
          state.sidebarView = 'git';
        }
        // v4 made the rail icon-only; drop the old stored preference so the
        // new default applies.
        if (state && version < 4) delete state.railLabels;
        // v5 merged the Wingman and Claude Code views into one Agents panel.
        // Carry the old selection across so someone parked on either lands on
        // the merged panel showing that same agent, not back on Explorer.
        if (state && version < 5) {
          const old = state.sidebarView as string | undefined;
          if (old === 'wingman' || old === 'claude') {
            state.agentPanelTab = old;
            state.sidebarView = 'agents';
          }
          if (state.viewByRoot) {
            for (const [root, v] of Object.entries(state.viewByRoot)) {
              // Compared as strings: these ids predate the merge and are no
              // longer in `SidebarView`.
              if ((v as string) === 'wingman' || (v as string) === 'claude') {
                state.viewByRoot[root] = 'agents';
              }
            }
          }
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
