import { gitRoot, gitWorktreeAdd } from './tauri';

/** Where isolated runs live: a sibling of the repo, not a child of it.
 *
 *  Inside the repo they would show up in the tree, in `git status` of the
 *  parent, and in every checker and search the user runs — and nesting a
 *  worktree under its own repo is a known way to confuse tooling. A sibling
 *  directory keeps the repo exactly as it was. */
export const RACE_DIR = '.arc-agents';

/** One agent's isolated checkout. */
export interface RaceWorktree {
  /** Absolute path the agent's shell starts in. */
  path: string;
  /** Branch created for it, so the work is committable and reviewable. */
  branch: string;
}

/** Parent directory of `p`, with either separator. */
function parentOf(p: string): string {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return cut > 0 ? p.slice(0, cut) : p;
}

/** Last segment of `p`. */
function baseName(p: string): string {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return cut >= 0 ? p.slice(cut + 1) : p;
}

/** Join with the separator already in use, so Windows paths stay Windows. */
function joinPath(dir: string, ...parts: string[]): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return [dir.replace(/[/\\]$/, ''), ...parts].join(sep);
}

/**
 * A slug safe for both a branch name and a directory name.
 *
 * Git refuses plenty of things in a ref — spaces, `~^:?*[`, `..`, a trailing
 * `.lock`, a leading or trailing `/` — and a run label comes from whatever the
 * user typed. Rather than encode every rule, keep only characters that are
 * unambiguously fine everywhere.
 */
export function slugify(label: string, fallback: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return slug || fallback;
}

/**
 * Name the branch and directory for run `index` of a race.
 *
 * Exported for tests: the numbering is what keeps four agents from colliding,
 * and an off-by-one here would have two of them sharing a checkout.
 */
export function raceNames(
  repoName: string,
  slug: string,
  stamp: number,
  index: number,
): { branch: string; dirName: string } {
  const run = `${slug}-${stamp.toString(36)}`;
  return {
    branch: `arc/${run}/${index + 1}`,
    // Directory names are flat, so the repo name keeps two projects racing at
    // once from landing in the same folder.
    dirName: `${repoName}-${run}-${index + 1}`,
  };
}

/**
 * Create `count` isolated checkouts of `root`, one per agent.
 *
 * Each is a real git worktree on its own new branch, cut from the current
 * HEAD. Agents racing the same task therefore cannot overwrite each other's
 * edits, and each result is a branch you can diff, merge or delete.
 *
 * Uncommitted work in the main tree is deliberately *not* carried across: a
 * worktree starts from HEAD. That is the honest behaviour — copying dirty
 * state into four checkouts would make four divergent copies of work the user
 * has not committed.
 */
export async function createRaceWorktrees(
  root: string,
  label: string,
  count: number,
): Promise<RaceWorktree[]> {
  const repo = await gitRoot(root);
  if (!repo) throw new Error('Isolated runs need a git repository.');

  const repoName = baseName(repo);
  const slug = slugify(label, 'run');
  const stamp = Date.now();
  const base = joinPath(parentOf(repo), RACE_DIR);

  const made: RaceWorktree[] = [];
  for (let i = 0; i < count; i++) {
    const { branch, dirName } = raceNames(repoName, slug, stamp, i);
    const path = joinPath(base, dirName);
    // Sequential on purpose: concurrent `worktree add` calls contend on the
    // repo's index lock, and the failure surfaces as a confusing lock error
    // rather than as "one of your agents has nowhere to run".
    await gitWorktreeAdd(repo, path, branch, true, null);
    made.push({ path, branch });
  }
  return made;
}
