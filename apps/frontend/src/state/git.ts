import { create } from 'zustand';
import {
  gitChanges,
  gitDiffStat,
  gitRoot,
  gitStatus,
  type GitChangeEntry,
  type GitChangeKind,
  type GitDiffStat,
  type GitInfo,
} from '../lib/tauri';

/** Per-file decoration the file tree paints next to a node. */
export interface GitDecoration {
  /** Single-letter porcelain status (M / A / D / R / U / ?). */
  status: string;
  kind: GitChangeKind;
}

/**
 * Normalize an absolute path into a stable map key. Separators collapse to
 * `/`; Windows paths (drive-lettered) are lower-cased since the filesystem is
 * case-insensitive and `git rev-parse` and the OS dialog may disagree on case.
 */
export function normPathKey(p: string): string {
  const unified = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:/.test(unified) ? unified.toLowerCase() : unified;
}

/**
 * Shared cache for the current workspace's git status + per-file changes.
 *
 * The Sidebar drives refreshes for the active root — fs-watcher-triggered
 * with a slow backstop poll; both `SourceControl` and the sidebar tab badge
 * subscribe to the same store, so there's never more than one refresh in
 * flight.
 */
interface GitStoreState {
  info: GitInfo | null;
  entries: GitChangeEntry[];
  diffStat: GitDiffStat | null;
  /** Per-file decorations keyed by normalized absolute path (file tree). */
  statusByPath: Map<string, GitDecoration>;
  /** Normalized absolute paths of directories containing a change, so the
   *  tree can flag collapsed folders that hide dirty files. */
  dirtyDirs: Set<string>;
  loading: boolean;
  error: string | null;
  refresh: (root: string) => Promise<void>;
  reset: () => void;
}

/** Build the absolute-path decoration map + dirty-folder set from repo-relative
 *  change entries. `repoRoot` is the `git rev-parse --show-toplevel` path. */
function buildDecorations(
  repoRoot: string | null,
  entries: GitChangeEntry[],
): { statusByPath: Map<string, GitDecoration>; dirtyDirs: Set<string> } {
  const statusByPath = new Map<string, GitDecoration>();
  const dirtyDirs = new Set<string>();
  if (!repoRoot) return { statusByPath, dirtyDirs };
  const rootKey = normPathKey(repoRoot);
  for (const e of entries) {
    const absKey = normPathKey(`${repoRoot}/${e.path}`);
    statusByPath.set(absKey, { status: e.status, kind: e.kind });
    // Mark every ancestor directory up to (and including) the repo root.
    let dir = absKey.slice(0, absKey.lastIndexOf('/'));
    while (dir.length >= rootKey.length && dir.includes('/')) {
      dirtyDirs.add(dir);
      if (dir === rootKey) break;
      dir = dir.slice(0, dir.lastIndexOf('/'));
    }
  }
  return { statusByPath, dirtyDirs };
}

// Monotonic token so a slow refresh (e.g. for a root the user just navigated
// away from) can't overwrite the results of a newer one. Only the latest
// in-flight refresh is allowed to commit its results.
let refreshSeq = 0;

export const useGit = create<GitStoreState>((set) => ({
  info: null,
  entries: [],
  diffStat: null,
  statusByPath: new Map(),
  dirtyDirs: new Set(),
  loading: false,
  error: null,
  refresh: async (root: string) => {
    const seq = ++refreshSeq;
    set({ loading: true, error: null });
    try {
      const [info, entries, diffStat, repoRoot] = await Promise.all([
        gitStatus(root),
        gitChanges(root),
        gitDiffStat(root).catch(() => null),
        gitRoot(root).catch(() => null),
      ]);
      if (seq !== refreshSeq) return; // superseded by a newer refresh
      const { statusByPath, dirtyDirs } = buildDecorations(repoRoot, entries);
      set({ info, entries, diffStat, statusByPath, dirtyDirs, loading: false });
    } catch (e) {
      if (seq !== refreshSeq) return;
      set({
        entries: [],
        diffStat: null,
        statusByPath: new Map(),
        dirtyDirs: new Set(),
        loading: false,
        error: String(e),
      });
    }
  },
  reset: () =>
    set({
      info: null,
      entries: [],
      diffStat: null,
      statusByPath: new Map(),
      dirtyDirs: new Set(),
      loading: false,
      error: null,
    }),
}));
