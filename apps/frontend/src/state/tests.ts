import { create } from 'zustand';
import { fsListFiles, fsReadDir, fsReadFile, isTauri, procRun } from '../lib/tauri';
import { isRemotePath } from '../lib/remote';
import {
  detectFrameworks,
  isTestFile,
  parseTests,
  runSpec,
  type Framework,
  type PackageManager,
  type TestFile,
} from '../lib/testDiscovery';

// Test explorer state: what tests exist in the workspace, and what happened
// the last time each one ran.
//
// Status comes from the runner's *exit code*, not from parsing its output.
// Every framework prints results differently and changes that format between
// majors, so a regex over stdout is a maintenance tax that buys a nicer tree
// and a new class of wrong answers. An exit code is unambiguous: run one test,
// and the code is that test's verdict. The captured output is kept so a
// failure can show what the runner actually said.
//
// ponytail: exit-code granularity means "run this file" marks every test in
// it pass or fail together. Parse a machine-readable reporter per framework if
// per-test results from a file run turn out to matter.

/** Files walked when looking for tests. The backend caps its own walk at
 *  8000 entries; this caps how many we then open and scan. */
const MAX_TEST_FILES = 400;

export type TestStatus = 'idle' | 'running' | 'pass' | 'fail';

export interface RunOutcome {
  status: Exclude<TestStatus, 'idle' | 'running'>;
  /** Combined stdout+stderr from the run, for the failure drawer. */
  output: string;
  durationMs: number;
  /** The command that produced this, shown above the output. */
  command: string;
}

/** A run target: the whole framework, one file, or one test in a file. */
export interface Target {
  framework: Framework;
  rel?: string;
  testName?: string;
}

/** Stable key for a target, used for both status and the tree's React keys.
 *  Joined on a character a path or a test name can't contain, so a file named
 *  `a` and a test called `a` in file `` can't collide. */
export function targetKey(t: Target): string {
  return `${t.framework}\u0001${t.rel ?? ''}\u0001${t.testName ?? ''}`;
}

interface TestsState {
  /** Root the current discovery belongs to; null before the first scan. */
  root: string | null;
  frameworks: Framework[];
  files: TestFile[];
  manager: PackageManager;
  scanning: boolean;
  /** Discovery error, e.g. an unreadable workspace. */
  error: string | null;
  /** Outcome by `targetKey`. Absent = never run. */
  outcomes: Record<string, RunOutcome>;
  /** Targets currently executing, by `targetKey`. */
  running: Record<string, true>;
  /** Which target's output the panel is showing, if any. */
  openOutput: string | null;

  scan: (root: string | null) => Promise<void>;
  run: (target: Target) => Promise<void>;
  setOpenOutput: (key: string | null) => void;
  reset: () => void;
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await fsReadFile(path);
  } catch {
    return null;
  }
}

/** Sniff the package manager from lockfiles at the root — same rules, and the
 *  same defaulting to npm, as `state/tasks.ts`. */
async function detectManager(root: string): Promise<PackageManager> {
  try {
    const names = new Set((await fsReadDir(root)).map((e) => e.name));
    if (names.has('pnpm-lock.yaml')) return 'pnpm';
    if (names.has('yarn.lock')) return 'yarn';
    if (names.has('bun.lockb')) return 'bun';
  } catch {
    /* unreadable dir → assume npm */
  }
  return 'npm';
}

export const useTests = create<TestsState>((set, get) => ({
  root: null,
  frameworks: [],
  files: [],
  manager: 'npm',
  scanning: false,
  error: null,
  outcomes: {},
  running: {},
  openOutput: null,

  reset: () =>
    set({
      root: null,
      frameworks: [],
      files: [],
      scanning: false,
      error: null,
      outcomes: {},
      running: {},
      openOutput: null,
    }),

  scan: async (root) => {
    if (!isTauri || !root) {
      get().reset();
      return;
    }
    // A remote workspace has no local checkout to run tests against, and
    // running the local `pytest` over an SFTP path would be nonsense.
    if (isRemotePath(root)) {
      set({ root, frameworks: [], files: [], error: null, scanning: false });
      return;
    }
    set({ scanning: true, error: null });
    const base = root.replace(/[\\/]+$/, '');

    try {
      const [packageJson, cargoToml, goMod, pyProject, setupPy, setupCfg, toxIni, pytestIni] =
        await Promise.all([
          readOrNull(`${base}/package.json`),
          readOrNull(`${base}/Cargo.toml`),
          readOrNull(`${base}/go.mod`),
          readOrNull(`${base}/pyproject.toml`),
          readOrNull(`${base}/setup.py`),
          readOrNull(`${base}/setup.cfg`),
          readOrNull(`${base}/tox.ini`),
          readOrNull(`${base}/pytest.ini`),
        ]);

      const frameworks = detectFrameworks({
        packageJson,
        cargoToml,
        goMod,
        pyProject,
        setupPy,
        setupCfg,
        toxIni,
        pytestIni,
      });
      if (frameworks.length === 0) {
        set({ root, frameworks: [], files: [], scanning: false });
        return;
      }

      // Two cheap substring passes beat one unfiltered walk: the backend's
      // matcher already looks at the whole relative path, so "test" catches
      // `tests/`, `test_x.py` and `x.test.ts` alike.
      const listed = await Promise.all([
        fsListFiles(base, 'test', MAX_TEST_FILES, []),
        fsListFiles(base, 'spec', MAX_TEST_FILES, []),
      ]);
      const byPath = new Map<string, { path: string; rel: string }>();
      for (const item of listed.flat()) {
        const rel = item.path
          .replace(/\\/g, '/')
          .replace(`${base.replace(/\\/g, '/')}/`, '');
        if (!byPath.has(item.path)) byPath.set(item.path, { path: item.path, rel });
      }

      const candidates: Array<{ path: string; rel: string; framework: Framework }> = [];
      for (const { path, rel } of byPath.values()) {
        for (const framework of frameworks) {
          if (isTestFile(rel, framework)) candidates.push({ path, rel, framework });
        }
      }
      candidates.sort((a, b) => a.rel.localeCompare(b.rel));

      const files: TestFile[] = [];
      for (const c of candidates.slice(0, MAX_TEST_FILES)) {
        const source = await readOrNull(c.path);
        if (source == null) continue;
        files.push({
          path: c.path,
          rel: c.rel,
          framework: c.framework,
          tests: parseTests(source, c.framework),
        });
      }

      set({
        root,
        frameworks,
        files,
        manager: await detectManager(base),
        scanning: false,
      });
    } catch (e) {
      set({ scanning: false, error: String(e) });
    }
  },

  run: async (target) => {
    const { root, manager } = get();
    if (!root || !isTauri) return;
    const key = targetKey(target);
    if (get().running[key]) return;

    const spec = runSpec(target.framework, {
      rel: target.rel,
      testName: target.testName,
      manager,
    });
    const command = [spec.program, ...spec.args].join(' ');

    set((s) => ({ running: { ...s.running, [key]: true } }));
    try {
      const out = await procRun(root, spec.program, spec.args);
      const output = [out.stdout, out.stderr].filter(Boolean).join('\n');
      set((s) => ({
        outcomes: {
          ...s.outcomes,
          [key]: {
            // A signal or timeout leaves no exit code; that is a failure, not
            // an unknown — the test did not demonstrably pass.
            status: out.code === 0 ? 'pass' : 'fail',
            output,
            durationMs: out.duration_ms,
            command,
          },
        },
      }));
    } catch (e) {
      // The runner itself wasn't found / wasn't runnable.
      set((s) => ({
        outcomes: {
          ...s.outcomes,
          [key]: { status: 'fail', output: String(e), durationMs: 0, command },
        },
      }));
    } finally {
      set((s) => {
        const running = { ...s.running };
        delete running[key];
        return { running };
      });
    }
  },

  setOpenOutput: (key) => set({ openOutput: key }),
}));

/** Status of one target, folding the live-running set over the outcomes. */
export function statusOf(state: TestsState, target: Target): TestStatus {
  const key = targetKey(target);
  if (state.running[key]) return 'running';
  return state.outcomes[key]?.status ?? 'idle';
}
