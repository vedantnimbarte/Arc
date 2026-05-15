import { create } from 'zustand';

export interface Tab {
  id: string;
  title: string;
  kind: 'terminal' | 'editor';
}

interface WorkspaceState {
  tabs: Tab[];
  activeTabId: string | null;
  addTab: (tab: Tab) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  renameTab: (id: string, title: string) => void;
}

export const useWorkspace = create<WorkspaceState>((set) => ({
  tabs: [{ id: 'term-1', title: 'shell', kind: 'terminal' }],
  activeTabId: 'term-1',
  addTab: (tab) =>
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id })),
  closeTab: (id) =>
    set((s) => {
      const remaining = s.tabs.filter((t) => t.id !== id);
      const wasActive = s.activeTabId === id;
      return {
        tabs: remaining,
        activeTabId: wasActive ? (remaining[0]?.id ?? null) : s.activeTabId,
      };
    }),
  setActive: (id) => set({ activeTabId: id }),
  renameTab: (id, title) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
    })),
}));
