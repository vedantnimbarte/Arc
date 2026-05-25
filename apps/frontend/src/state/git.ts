import { create } from 'zustand';
import {
  gitChanges,
  gitDiffStat,
  gitStatus,
  type GitChangeEntry,
  type GitDiffStat,
  type GitInfo,
} from '../lib/tauri';

/**
 * Shared cache for the current workspace's git status + per-file changes.
 *
 * The Sidebar polls a single time at 4s for the active root; both
 * `SourceControl` and the sidebar tab badge subscribe to the same store, so
 * there's never more than one poll in flight.
 */
interface GitStoreState {
  info: GitInfo | null;
  entries: GitChangeEntry[];
  diffStat: GitDiffStat | null;
  loading: boolean;
  error: string | null;
  refresh: (root: string) => Promise<void>;
  reset: () => void;
}

export const useGit = create<GitStoreState>((set) => ({
  info: null,
  entries: [],
  diffStat: null,
  loading: false,
  error: null,
  refresh: async (root: string) => {
    set({ loading: true, error: null });
    try {
      const [info, entries, diffStat] = await Promise.all([
        gitStatus(root),
        gitChanges(root),
        gitDiffStat(root).catch(() => null),
      ]);
      set({ info, entries, diffStat, loading: false });
    } catch (e) {
      set({ entries: [], diffStat: null, loading: false, error: String(e) });
    }
  },
  reset: () => set({ info: null, entries: [], diffStat: null, loading: false, error: null }),
}));
