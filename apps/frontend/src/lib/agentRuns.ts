import type { GitWorktreeEntry } from './tauri';
import type { Tab } from '../state/workspace';

/**
 * The pure half of the Agent runs view: which worktrees belong to which race,
 * what each run changed, and how its branch would merge back.
 *
 * Grouping is derived from the branch names `createRaceWorktrees` makes
 * (`arc/<slug>-<stamp>/<n>`), so a race survives a restart, and one created
 * outside ARC's memory still shows up. Only what a branch name cannot carry —
 * the goal as typed, the agent, and the branch the race was cut from — is
 * remembered separately, in `RaceMeta`.
 */

/** What a race's branch names don't say. */
export interface RaceMeta {
  goal: string;
  agent: string;
  /** Branch checked out in the main tree when the race started — where a
   *  winner merges back to. Null when HEAD was detached. */
  baseBranch: string | null;
}

export interface RaceRun {
  index: number;
  branch: string;
  path: string;
  /** The checkout directory is gone; only git's record of it remains. */
  prunable: boolean;
}

export interface RaceGroup {
  id: string;
  label: string;
  agent: string | null;
  baseBranch: string | null;
  /** Main worktree of the repo — where merges run. */
  repo: string;
  createdAt: number | null;
  runs: RaceRun[];
}

const RACE_BRANCH = /^arc\/([a-z0-9-]+)\/(\d+)$/;

/** `arc/fix-login-lq2x3/2` → `{ runId: 'fix-login-lq2x3', index: 2 }`. */
export function parseRaceBranch(branch: string | null): { runId: string; index: number } | null {
  const m = branch ? RACE_BRANCH.exec(branch) : null;
  return m ? { runId: m[1]!, index: Number(m[2]) } : null;
}

/** Slug and creation time out of a run id; the stamp is base-36 millis. */
function splitRunId(runId: string): { slug: string; createdAt: number | null } {
  const cut = runId.lastIndexOf('-');
  if (cut < 0) return { slug: runId, createdAt: null };
  const stamp = parseInt(runId.slice(cut + 1), 36);
  return { slug: runId.slice(0, cut), createdAt: Number.isFinite(stamp) ? stamp : null };
}

/** Every race among `worktrees`, newest first, runs in launch order. */
export function groupRaceRuns(
  worktrees: readonly GitWorktreeEntry[],
  meta: Readonly<Record<string, RaceMeta>>,
): RaceGroup[] {
  const main = worktrees.find((w) => w.is_main);
  const groups = new Map<string, RaceGroup>();
  for (const w of worktrees) {
    const parsed = parseRaceBranch(w.branch);
    if (!parsed || !w.branch) continue;
    let group = groups.get(parsed.runId);
    if (!group) {
      const m = meta[parsed.runId];
      const { slug, createdAt } = splitRunId(parsed.runId);
      group = {
        id: parsed.runId,
        label: m?.goal || slug,
        agent: m?.agent ?? null,
        // Without a record, the main tree's branch is the best guess — it is
        // where the race was cut from unless the user has since switched.
        baseBranch: m ? m.baseBranch : main?.branch ?? null,
        repo: main?.path ?? w.path,
        createdAt,
        runs: [],
      };
      groups.set(parsed.runId, group);
    }
    group.runs.push({ index: parsed.index, branch: w.branch, path: w.path, prunable: w.prunable });
  }
  const out = [...groups.values()];
  for (const g of out) g.runs.sort((a, b) => a.index - b.index);
  return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export interface NumstatFile {
  path: string;
  insertions: number;
  deletions: number;
  binary: boolean;
}

export interface NumstatSummary {
  files: NumstatFile[];
  insertions: number;
  deletions: number;
}

/** Sum `git diff --numstat` output. Binary files (`-\t-\tpath`) count as a
 *  changed file with no lines. */
export function parseNumstat(text: string): NumstatSummary {
  const files: NumstatFile[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of text.split('\n')) {
    const parts = line.replace(/\r$/, '').split('\t');
    if (parts.length < 3) continue;
    const [ins, del, ...rest] = parts;
    const binary = ins === '-' && del === '-';
    const file = {
      path: rest.join('\t'),
      insertions: binary ? 0 : Number(ins) || 0,
      deletions: binary ? 0 : Number(del) || 0,
      binary,
    };
    insertions += file.insertions;
    deletions += file.deletions;
    files.push(file);
  }
  return { files, insertions, deletions };
}

export type MergeStrategy = 'up-to-date' | 'fast-forward' | 'merge-commit';

/**
 * How `git merge <run>` into the base will go, from `ahead` (commits the run
 * has that the base lacks) and `behind` (the reverse). Plain `git merge`
 * already picks this; knowing it up front lets the confirmation say so.
 */
export function mergeStrategy(ahead: number, behind: number): MergeStrategy {
  if (ahead === 0) return 'up-to-date';
  return behind === 0 ? 'fast-forward' : 'merge-commit';
}

export type RunStatus = 'running' | 'waiting' | 'exited';

/** Compare paths the way Windows does, whichever separator either side uses. */
export function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** The agent tab working in `path`, and what it is doing. A run with no open
 *  tab has exited as far as ARC can tell. */
export function runStatus(
  path: string,
  tabs: readonly Tab[],
  waiting: Readonly<Record<string, unknown>>,
): { status: RunStatus; tab: Tab | null } {
  const tab =
    tabs.find((t) => t.kind === 'terminal' && t.shellOverride && samePath(t.launchCwd, path)) ??
    null;
  if (!tab) return { status: 'exited', tab: null };
  return { status: waiting[tab.id] ? 'waiting' : 'running', tab };
}

const META_KEY = 'arc-agent-races';

export function loadRaceMeta(): Record<string, RaceMeta> {
  try {
    return JSON.parse(localStorage.getItem(META_KEY) ?? '{}') as Record<string, RaceMeta>;
  } catch {
    return {};
  }
}

/** Remember `meta` for race `runId`. Best-effort: without it the view still
 *  groups the race, it just labels it by slug. */
export function saveRaceMeta(runId: string, meta: RaceMeta): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify({ ...loadRaceMeta(), [runId]: meta }));
  } catch {
    /* storage unavailable */
  }
}
