import { isRemotePath } from '../lib/remote';
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
  /** Directories containing a change, keyed by normalized absolute path. The
   *  value is the most severe decoration found beneath, so the tree can tint a
   *  folder the way VS Code does (and dot it while collapsed). */
  dirtyDirs: Map<string, GitDecoration>;
  /** Normalized absolute paths git reported as ignored. Directories arrive
   *  collapsed, so membership is a prefix test — see `isIgnoredPath`. */
  ignoredPaths: Set<string>;
  loading: boolean;
  error: string | null;
  /** `background: true` for watcher/poll-driven refreshes — they must not
   *  flip `loading`, or the header spinner and the disabled state of every
   *  button strobe on each poll. */
  refresh: (root: string, opts?: { background?: boolean }) => Promise<void>;
  reset: () => void;
}

/** How loudly a change should shout when it's rolled up onto an ancestor
 *  folder: a conflict outranks a tracked edit, which outranks an untracked
 *  file. Mirrors VS Code, where a folder holding only new files reads green. */
function severity(d: GitDecoration): number {
  if (d.kind === 'conflict') return 3;
  return d.kind === 'untracked' ? 1 : 2;
}

/** Build the absolute-path decoration map, dirty-folder rollup, and ignored-path
 *  set from repo-relative change entries. `repoRoot` is the
 *  `git rev-parse --show-toplevel` path. */
function buildDecorations(
  repoRoot: string | null,
  entries: GitChangeEntry[],
): {
  statusByPath: Map<string, GitDecoration>;
  dirtyDirs: Map<string, GitDecoration>;
  ignoredPaths: Set<string>;
} {
  const statusByPath = new Map<string, GitDecoration>();
  const dirtyDirs = new Map<string, GitDecoration>();
  const ignoredPaths = new Set<string>();
  if (!repoRoot) return { statusByPath, dirtyDirs, ignoredPaths };
  const rootKey = normPathKey(repoRoot);
  for (const e of entries) {
    const absKey = normPathKey(`${repoRoot}/${e.path}`);
    if (e.kind === 'ignored') {
      ignoredPaths.add(absKey);
      continue;
    }
    const deco: GitDecoration = { status: e.status, kind: e.kind };
    statusByPath.set(absKey, deco);
    // Roll the change up every ancestor directory to (and including) the repo
    // root, keeping the loudest one seen so far.
    let dir = absKey.slice(0, absKey.lastIndexOf('/'));
    while (dir.length >= rootKey.length && dir.includes('/')) {
      const cur = dirtyDirs.get(dir);
      if (!cur || severity(deco) > severity(cur)) dirtyDirs.set(dir, deco);
      if (dir === rootKey) break;
      dir = dir.slice(0, dir.lastIndexOf('/'));
    }
  }
  return { statusByPath, dirtyDirs, ignoredPaths };
}

/**
 * Is `key` (a normalized absolute path) ignored? Git collapses an ignored
 * directory into one record, so a hit on any ancestor counts — that's what
 * dims every file under `node_modules/` from a single entry.
 */
export function isIgnoredPath(key: string, ignoredPaths: Set<string>): boolean {
  if (ignoredPaths.size === 0) return false;
  let cur = key;
  for (;;) {
    if (ignoredPaths.has(cur)) return true;
    const cut = cur.lastIndexOf('/');
    if (cut <= 0) return false;
    cur = cur.slice(0, cut);
  }
}

// Monotonic token so a slow refresh (e.g. for a root the user just navigated
// away from) can't overwrite the results of a newer one. Only the latest
// in-flight refresh is allowed to commit its results.
let refreshSeq = 0;

// Serialized form of the last committed result. A refresh that produces the
// same thing skips `set()` entirely: publishing fresh `entries`/`statusByPath`
// identities on every poll re-renders SourceControl and every FileTree node
// for no reason, which is what the panel's flicker was.
let lastSnapshot: string | null = null;

export const useGit = create<GitStoreState>((set) => ({
  info: null,
  entries: [],
  diffStat: null,
  statusByPath: new Map(),
  dirtyDirs: new Map(),
  ignoredPaths: new Set(),
  loading: false,
  error: null,
  refresh: async (root: string, opts?: { background?: boolean }) => {
    // Git runs against a local checkout. A remote workspace has none, and
    // handing an `ssh://` path to the git commands would surface a parse
    // error on every refresh — present it as "no repo" instead.
    if (isRemotePath(root)) {
      lastSnapshot = null;
      set({
        info: null,
        entries: [],
        diffStat: null,
        statusByPath: new Map(),
        dirtyDirs: new Map(),
        ignoredPaths: new Set(),
        loading: false,
        error: null,
      });
      return;
    }
    const seq = ++refreshSeq;
    if (!opts?.background) set({ loading: true, error: null });
    try {
      const [info, entries, diffStat, repoRoot] = await Promise.all([
        gitStatus(root),
        gitChanges(root),
        gitDiffStat(root).catch(() => null),
        gitRoot(root).catch(() => null),
      ]);
      if (seq !== refreshSeq) return; // superseded by a newer refresh
      const snapshot = JSON.stringify([info, entries, diffStat, repoRoot]);
      if (snapshot === lastSnapshot) {
        set({ loading: false, error: null });
        return;
      }
      lastSnapshot = snapshot;
      const { statusByPath, dirtyDirs, ignoredPaths } = buildDecorations(repoRoot, entries);
      set({
        info,
        // Ignored paths ride along on the same `git status` call but aren't
        // changes — keep them out of the list SourceControl renders and counts.
        entries: ignoredPaths.size > 0 ? entries.filter((e) => e.kind !== 'ignored') : entries,
        diffStat,
        statusByPath,
        dirtyDirs,
        ignoredPaths,
        loading: false,
        error: null,
      });
    } catch (e) {
      if (seq !== refreshSeq) return;
      lastSnapshot = null;
      set({
        entries: [],
        diffStat: null,
        statusByPath: new Map(),
        dirtyDirs: new Map(),
        ignoredPaths: new Set(),
        loading: false,
        error: String(e),
      });
    }
  },
  reset: () => {
    lastSnapshot = null;
    set({
      info: null,
      entries: [],
      diffStat: null,
      statusByPath: new Map(),
      dirtyDirs: new Map(),
      ignoredPaths: new Set(),
      loading: false,
      error: null,
    });
  },
}));

/** Test hook: drop the memoized snapshot so each case starts clean. */
export function __resetGitSnapshotForTests(): void {
  lastSnapshot = null;
}
