import { create } from 'zustand';
import { notifyEvent } from '../lib/notifyEvent';
import { fsReadDir, isTauri, procRun } from '../lib/tauri';
import { isRemotePath } from '../lib/remote';
import {
  checkerCommand,
  detectCheckers,
  problemKey,
  type Checker,
  type Problem,
} from '../lib/problemMatchers';
import type { PackageManager } from '../lib/testDiscovery';

// Problems panel state: which checkers this workspace has, and what the last
// run of each one reported.
//
// Results are stored per checker rather than in one flat list, so re-running
// `tsc` replaces only tsc's rows and leaves cargo's alone. Running everything
// then means running each checker and merging — which is also what makes a
// partial run useful, instead of an all-or-nothing refresh.
//
// A checker that exits non-zero is normal (that is what "there are errors"
// looks like); the failure case worth reporting is a checker that could not
// run at all — not installed, or it produced no parseable output despite
// failing. Both land in `error` on that checker's entry.

/** How long a single checker may run. `cargo check` on a cold target dir is
 *  genuinely minutes, so this is generous; `proc_run` caps it at 10 anyway. */
const CHECK_TIMEOUT_MS = 5 * 60 * 1000;

export interface CheckerResult {
  problems: Problem[];
  /** Why the checker could not produce results, if it couldn't. */
  error: string | null;
  /** Wall time of the last run. */
  durationMs: number;
  /** The command that produced this, shown on hover. */
  command: string;
}

interface ProblemsState {
  /** Root the current detection belongs to; null before the first scan. */
  root: string | null;
  /** Checkers that apply to this workspace, in catalogue order. */
  checkers: Checker[];
  manager: PackageManager;
  /** Result by checker id. Absent = never run. */
  results: Record<string, CheckerResult>;
  /** Checker ids currently executing. */
  running: Record<string, true>;
  scanning: boolean;
  /** Detection error, e.g. an unreadable workspace root. */
  scanError: string | null;
  /** Files the user has collapsed in the tree. */
  collapsed: Record<string, true>;

  scan: (root: string | null) => Promise<void>;
  run: (checkerId: string) => Promise<void>;
  runAll: () => Promise<void>;
  toggleFile: (file: string) => void;
  clear: () => void;
}

/** Which checkers apply, from the file names directly under `root`. */
async function detectAt(root: string): Promise<{ checkers: Checker[]; manager: PackageManager }> {
  const entries = await fsReadDir(root);
  const names = entries.map((e) => e.name);
  return { checkers: detectCheckers(names), manager: detectManager(names) };
}

/** Sniff the package manager from lockfiles at the root — same rules as the
 *  test explorer's, and the same default when nothing matches. */
function detectManager(names: string[]): PackageManager {
  if (names.includes('pnpm-lock.yaml')) return 'pnpm';
  if (names.includes('yarn.lock')) return 'yarn';
  if (names.includes('bun.lockb') || names.includes('bun.lock')) return 'bun';
  return 'npm';
}

export const useProblems = create<ProblemsState>((set, get) => ({
  root: null,
  checkers: [],
  manager: 'npm',
  results: {},
  running: {},
  scanning: false,
  scanError: null,
  collapsed: {},

  scan: async (root) => {
    if (!root || !isTauri) {
      set({ root, checkers: [], results: {}, scanError: null });
      return;
    }
    // Checkers run as local processes against a local path — a remote
    // workspace has neither. The panel says so rather than running the local
    // toolchain against a path that doesn't exist here.
    if (isRemotePath(root)) {
      set({ root, checkers: [], results: {}, scanError: null });
      return;
    }
    set({ scanning: true, scanError: null });
    try {
      const { checkers, manager } = await detectAt(root);
      set({ root, checkers, manager, results: {}, scanning: false });
    } catch (e) {
      set({
        root,
        checkers: [],
        results: {},
        scanning: false,
        scanError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  run: async (checkerId) => {
    const { root, checkers, manager } = get();
    const checker = checkers.find((c) => c.id === checkerId);
    if (!root || !checker || !isTauri) return;
    if (get().running[checkerId]) return;

    const { program, args } = checkerCommand(checker, manager);
    const command = [program, ...args].join(' ');
    set((s) => ({ running: { ...s.running, [checkerId]: true } }));
    try {
      const out = await procRun(root, program, args, CHECK_TIMEOUT_MS);
      const problems = dedupe(checker.parse(out.stdout, out.stderr));
      // A checker that failed but said nothing parseable is broken, not clean
      // — reporting "no problems" there is the one genuinely misleading
      // outcome this panel can have.
      const silentFailure =
        problems.length === 0 && out.code !== 0
          ? out.timed_out
            ? `${checker.label} timed out`
            : firstLine(out.stderr) || firstLine(out.stdout) || `${checker.label} exited ${out.code}`
          : null;
      set((s) => ({
        results: {
          ...s.results,
          [checkerId]: {
            problems,
            error: silentFailure,
            durationMs: out.duration_ms,
            command,
          },
        },
        running: omit(s.running, checkerId),
      }));
    } catch (e) {
      set((s) => ({
        results: {
          ...s.results,
          [checkerId]: {
            problems: [],
            error: e instanceof Error ? e.message : String(e),
            durationMs: 0,
            command,
          },
        },
        running: omit(s.running, checkerId),
      }));
    }
  },

  runAll: async () => {
    // Sequential, not parallel: `cargo check` and `tsc` each saturate the
    // machine, and two at once mostly makes both slower while the UI can only
    // usefully show one spinner anyway.
    for (const checker of get().checkers) {
      await get().run(checker.id);
    }
    // A full run is long enough to walk away from, which is exactly when a
    // notification earns its place. Single-checker runs stay silent — you
    // pressed one chip and are watching it.
    const problems = allProblems(get().results);
    const errors = problems.filter((p) => p.severity === 'error').length;
    notifyEvent({
      source: 'checks',
      title:
        problems.length === 0
          ? 'Checkers found nothing'
          : `${errors} error${errors === 1 ? '' : 's'}, ${problems.length - errors} warning${problems.length - errors === 1 ? '' : 's'}`,
      body: get()
        .checkers.map((c) => c.label)
        .join(', '),
      tone: errors > 0 ? 'error' : undefined,
      target: { kind: 'sidebar', view: 'problems' },
    });
  },

  toggleFile: (file) =>
    set((s) => {
      if (s.collapsed[file]) return { collapsed: omit(s.collapsed, file) };
      return { collapsed: { ...s.collapsed, [file]: true } };
    }),

  clear: () => set({ results: {} }),
}));

/** Two checkers can report the same thing; show it once. */
function dedupe(problems: Problem[]): Problem[] {
  const seen = new Set<string>();
  const out: Problem[] = [];
  for (const p of problems) {
    const key = problemKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function firstLine(s: string): string {
  return s.trim().split(/\r?\n/)[0]?.trim() ?? '';
}

function omit<T extends Record<string, unknown>>(obj: T, key: string): T {
  if (!(key in obj)) return obj;
  const { [key]: _drop, ...rest } = obj;
  return rest as T;
}

/** Every problem from every checker, flattened. Selector rather than stored
 *  state so it can never drift from `results`. */
export function allProblems(results: Record<string, CheckerResult>): Problem[] {
  return Object.values(results).flatMap((r) => r.problems);
}
