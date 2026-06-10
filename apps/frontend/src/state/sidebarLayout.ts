import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SidebarView } from './files';
import { moveView, PINNED_VIEW } from '../lib/sidebarViews';

/**
 * User customization of the activity rail: the order of views and which are
 * hidden. The catalogue itself lives in lib/sidebarViews.ts; this store only
 * holds the user's overrides (empty arrays = defaults). Pure reconciliation
 * (normalizeOrder/resolveRailViews) keeps new catalogue views appearing even
 * when an old order is persisted.
 */
interface SidebarLayoutState {
  /** Persisted view order. Empty = catalogue default. */
  order: SidebarView[];
  /** Hidden view ids. Explorer can never be hidden. */
  hidden: SidebarView[];
  setOrder: (order: SidebarView[]) => void;
  move: (id: SidebarView, dir: -1 | 1) => void;
  toggleHidden: (id: SidebarView) => void;
  setHidden: (id: SidebarView, hidden: boolean) => void;
  reset: () => void;
}

const STORAGE_KEY = 'arc-sidebar-layout';

export const useSidebarLayout = create<SidebarLayoutState>()(
  persist(
    (set) => ({
      order: [],
      hidden: [],
      setOrder: (order) => set({ order }),
      move: (id, dir) => set((s) => ({ order: moveView(s.order, id, dir) })),
      toggleHidden: (id) =>
        set((s) => {
          if (id === PINNED_VIEW) return s;
          return {
            hidden: s.hidden.includes(id)
              ? s.hidden.filter((x) => x !== id)
              : [...s.hidden, id],
          };
        }),
      setHidden: (id, hidden) =>
        set((s) => {
          if (id === PINNED_VIEW) return s;
          const has = s.hidden.includes(id);
          if (hidden && !has) return { hidden: [...s.hidden, id] };
          if (!hidden && has) return { hidden: s.hidden.filter((x) => x !== id) };
          return s;
        }),
      reset: () => set({ order: [], hidden: [] }),
    }),
    { name: STORAGE_KEY, version: 1 },
  ),
);

// Cross-window sync (Settings runs in a separate JS context; localStorage is
// shared but Zustand state isn't) — mirrors the files store.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      void useSidebarLayout.persist.rehydrate();
    }
  });
}
