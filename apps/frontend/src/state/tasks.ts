import { useEffect } from 'react';
import { Play } from 'lucide-react';
import { fsReadDir, fsReadFile, isTauri } from '../lib/tauri';
import { isRemotePath } from '../lib/remote';
import { useFiles } from './files';
import { useCommands, type CommandAction } from './commands';
import { useWorkspace } from './workspace';

// Task runner: surface a project's runnable entry points as ⌘K commands that
// each run in a fresh terminal tab. Three sources, because between them they
// cover most repos: `package.json` scripts, Makefile targets, and justfile
// recipes.
//
// The parsers are line scanners, not real parsers for their formats. Anything
// needing genuine evaluation (make includes and conditionals, just's variable
// interpolation) is skipped rather than guessed at — a task list that quietly
// omits a computed target is fine; one that offers a name make would reject is
// not.
//
// ponytail: workspace root only; walk up/into monorepo packages if anyone
// actually needs per-package scripts.

/** Where a task came from. Shown in the palette for everything but `node`,
 *  so a Makefile `build` and a package.json `build` stay distinguishable. */
export type TaskSource = 'node' | 'make' | 'just';

export interface ProjectTask {
  /** Script/target/recipe name. */
  name: string;
  /** Full shell command, e.g. `pnpm run dev`, `make build`, `just test`. */
  command: string;
  source: TaskSource;
}

/** Parse the `scripts` keys out of a raw package.json. Pure — returns [] on
 *  malformed JSON or a missing/empty `scripts` map. */
export function parsePackageScripts(raw: string): string[] {
  try {
    const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    if (!pkg.scripts || typeof pkg.scripts !== 'object') return [];
    return Object.keys(pkg.scripts).filter((k) => typeof pkg.scripts![k] === 'string');
  } catch {
    return [];
  }
}

/**
 * Pull runnable target names out of a Makefile.
 *
 * Deliberately a line scanner rather than a Makefile parser — everything that
 * would need real parsing (includes, conditionals, computed target names) is
 * excluded rather than guessed at:
 *
 *   * recipe lines start with a tab, and their contents can look like targets;
 *   * `VAR := x` and `VAR ::= x` are assignments, not targets;
 *   * `%.o: %.c` is a pattern rule — not runnable by name;
 *   * `.PHONY` and friends are directives;
 *   * `$(GEN): ...` has a name only make itself can expand.
 */
export function parseMakeTargets(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    // Recipe body — belongs to the target above it.
    if (line.startsWith('\t')) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Assignments first, and as their own test rather than a lookahead in the
    // target pattern: make has six assignment operators (`=`, `:=`, `::=`,
    // `:::=`, `?=`, `+=`, `!=`), and a `:(?!=)` guard just backtracks to an
    // earlier colon and matches `CFLAGS ::= -O2` as a target named CFLAGS.
    if (/^[A-Za-z_][A-Za-z0-9_.]*\s*(?::{1,3}=|[?+!]?=)/.test(trimmed)) continue;
    // `target:` / `a b:` / `target: deps` / `target:: deps`.
    const m = /^([^:=#]+?)\s*:/.exec(trimmed);
    if (!m) continue;
    for (const name of m[1]!.trim().split(/\s+/)) {
      if (!name) continue;
      if (name.startsWith('.')) continue; // .PHONY, .DEFAULT_GOAL, …
      if (name.includes('%')) continue; // pattern rule
      if (name.includes('$')) continue; // variable-expanded name
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Pull recipe names out of a justfile.
 *
 * Same line-scanner reasoning as `parseMakeTargets`, with just's own syntax:
 * recipes may declare parameters (`build target:`) and may be marked private
 * either by a leading underscore or a `[private]` attribute on the line above.
 * Assignments (`x := y`), settings (`set shell := …`), exports and comments
 * are all skipped.
 */
export function parseJustRecipes(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let privateNext = false;
  for (const line of raw.split(/\r?\n/)) {
    // Indented lines are recipe bodies.
    if (/^\s/.test(line)) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[')) {
      // An attribute line applies to the recipe that follows it.
      privateNext = /\[private\]/.test(trimmed);
      continue;
    }
    if (/^(set|export|alias|import|mod)\b/.test(trimmed)) continue;
    const m = /^([a-zA-Z_][a-zA-Z0-9_-]*)([^:=]*)::?(?!=)/.exec(trimmed);
    if (!m) {
      privateNext = false;
      continue;
    }
    const name = m[1]!;
    const wasPrivate = privateNext;
    privateNext = false;
    // just hides `_`-prefixed and [private] recipes from `just --list`; so do we.
    if (wasPrivate || name.startsWith('_')) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Map a script name to its invocation for the detected package manager. */
export function runnerCommand(manager: 'pnpm' | 'yarn' | 'bun' | 'npm', script: string): string {
  if (manager === 'yarn') return `yarn ${script}`;
  if (manager === 'pnpm') return `pnpm run ${script}`;
  if (manager === 'bun') return `bun run ${script}`;
  return `npm run ${script}`;
}

/** Sniff the package manager from lockfiles in `root`. Defaults to npm. */
async function detectManager(root: string): Promise<'pnpm' | 'yarn' | 'bun' | 'npm'> {
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

/** Read a file, or null when it isn't there. */
async function readOrNull(path: string): Promise<string | null> {
  try {
    return await fsReadFile(path);
  } catch {
    return null;
  }
}

/** Load every runnable task at the workspace root: package.json scripts,
 *  Makefile targets, and justfile recipes. Empty outside Tauri, or when the
 *  root has none of those files. */
export async function loadProjectTasks(root: string): Promise<ProjectTask[]> {
  if (!isTauri) return [];
  // Remote workspaces have no local manifest to read, and running a local
  // `pnpm dev` against a remote checkout would be wrong anyway.
  if (isRemotePath(root)) return [];
  const base = root.replace(/[\\/]+$/, '');

  // just and make each accept two spellings of their filename.
  const [pkg, makefile, justfile] = await Promise.all([
    readOrNull(`${base}/package.json`),
    readOrNull(`${base}/Makefile`).then((v) => v ?? readOrNull(`${base}/makefile`)),
    readOrNull(`${base}/justfile`).then((v) => v ?? readOrNull(`${base}/Justfile`)),
  ]);

  const tasks: ProjectTask[] = [];

  if (pkg) {
    const scripts = parsePackageScripts(pkg);
    if (scripts.length > 0) {
      const manager = await detectManager(base);
      for (const name of scripts) {
        tasks.push({ name, command: runnerCommand(manager, name), source: 'node' });
      }
    }
  }
  if (makefile) {
    for (const name of parseMakeTargets(makefile)) {
      tasks.push({ name, command: `make ${name}`, source: 'make' });
    }
  }
  if (justfile) {
    for (const name of parseJustRecipes(justfile)) {
      tasks.push({ name, command: `just ${name}`, source: 'just' });
    }
  }
  return tasks;
}

/** Palette label for a task. The source is spelled out for everything but
 *  node scripts, so a Makefile `build` and a package.json `build` don't show
 *  up as two identical rows. */
export function taskTitle(task: ProjectTask): string {
  return task.source === 'node' ? `Run: ${task.name}` : `Run: ${task.name} (${task.source})`;
}

/**
 * Register the current project's scripts as ⌘K "Run: <script>" commands,
 * re-loading whenever the workspace root changes. Call once (App.tsx).
 */
export function useTaskCommands(): void {
  useEffect(() => {
    let unregister: (() => void) | null = null;
    let cancelled = false;

    const refresh = async (root: string | null) => {
      unregister?.();
      unregister = null;
      if (!root) return;
      const tasks = await loadProjectTasks(root);
      if (cancelled || tasks.length === 0) return;
      const actions: CommandAction[] = tasks.map((task) => ({
        // Keyed by source too — a Makefile and a package.json can both
        // define `build`, and colliding ids would drop one of them.
        id: `task.run.${task.source}.${task.name}`,
        title: taskTitle(task),
        group: 'Tasks',
        keywords: ['task', 'script', 'run', task.source, task.name, task.command],
        icon: Play,
        run: () => void useWorkspace.getState().runTask(task.command, task.name),
      }));
      unregister = useCommands.getState().registerMany(actions);
    };

    void refresh(useFiles.getState().root);
    const unsub = useFiles.subscribe((s, prev) => {
      if (s.root !== prev.root) void refresh(s.root);
    });

    return () => {
      cancelled = true;
      unsub();
      unregister?.();
    };
  }, []);
}
