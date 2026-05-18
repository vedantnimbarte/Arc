import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Tab {
  id: string;
  title: string;
  kind: 'terminal' | 'editor';
  /** PTY id for terminal tabs, registered by the Terminal component on spawn.
   *  Transient — stripped from persisted state since PTYs don't survive reload. */
  ptyId?: string;
  /** Absolute path for editor tabs (read on mount). */
  filePath?: string;
}

interface WorkspaceState {
  tabs: Tab[];
  activeTabId: string | null;
  /** Per-tab dirty flag — set by the Editor when its buffer diverges
   *  from the last-saved content on disk. Kept off the Tab itself so
   *  zustand persist doesn't accidentally restore a stale dirty bit. */
  tabDirty: Record<string, boolean>;
  addTab: (tab: Tab) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  setTabPtyId: (id: string, ptyId: string | undefined) => void;
  setTabDirty: (id: string, dirty: boolean) => void;
  /** Find an existing editor tab for `path`, or create one and focus it. */
  openFile: (path: string, title?: string) => string;
}

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      tabs: [{ id: 'term-1', title: 'shell', kind: 'terminal' }],
      activeTabId: 'term-1',
      tabDirty: {},
      addTab: (tab) =>
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id })),
      closeTab: (id) =>
        set((s) => {
          const remaining = s.tabs.filter((t) => t.id !== id);
          const wasActive = s.activeTabId === id;
          const { [id]: _omit, ...nextDirty } = s.tabDirty;
          return {
            tabs: remaining,
            activeTabId: wasActive ? (remaining[0]?.id ?? null) : s.activeTabId,
            tabDirty: nextDirty,
          };
        }),
      setActive: (id) => set({ activeTabId: id }),
      renameTab: (id, title) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
        })),
      setTabPtyId: (id, ptyId) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, ptyId } : t)),
        })),
      setTabDirty: (id, dirty) =>
        set((s) => {
          if (!!s.tabDirty[id] === dirty) return s; // no-op
          const next = { ...s.tabDirty };
          if (dirty) next[id] = true;
          else delete next[id];
          return { tabDirty: next };
        }),
      openFile: (path, title) => {
        const existing = get().tabs.find((t) => t.kind === 'editor' && t.filePath === path);
        if (existing) {
          set({ activeTabId: existing.id });
          return existing.id;
        }
        const id = `edit-${Date.now()}`;
        const tab: Tab = {
          id,
          title: title ?? basename(path),
          kind: 'editor',
          filePath: path,
        };
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
        return id;
      },
    }),
    {
      name: 'arc-workspace',
      version: 1,
      // Strip transient PTY ids so they don't linger across reloads.
      partialize: (state) => ({
        tabs: state.tabs.map(({ ptyId: _ptyId, ...rest }) => rest),
        activeTabId: state.activeTabId,
      }) as Partial<WorkspaceState>,
    },
  ),
);

function basename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}
