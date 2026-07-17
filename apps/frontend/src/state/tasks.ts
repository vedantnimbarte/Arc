import { useEffect } from 'react';
import { Play } from 'lucide-react';
import { fsReadDir, fsReadFile, isTauri } from '../lib/tauri';
import { useFiles } from './files';
import { useCommands, type CommandAction } from './commands';
import { useWorkspace } from './workspace';

// Task runner: surface a project's `package.json` scripts as ⌘K commands that
// each run in a fresh terminal tab. Kept deliberately small — only the
// workspace root's package.json is read (not nested workspaces).
// ponytail: root package.json only; walk up/into monorepo packages if anyone
// actually needs per-package scripts.

export interface ProjectTask {
  /** Script name from `package.json#scripts`. */
  name: string;
  /** Full shell command, e.g. `pnpm run dev`. */
  command: string;
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

/** Load the workspace root's runnable scripts. Empty when there's no
 *  package.json, no scripts, or we're outside Tauri. */
export async function loadProjectTasks(root: string): Promise<ProjectTask[]> {
  if (!isTauri) return [];
  const base = root.replace(/[\\/]+$/, '');
  let raw: string;
  try {
    raw = await fsReadFile(`${base}/package.json`);
  } catch {
    return []; // no package.json at the root
  }
  const scripts = parsePackageScripts(raw);
  if (scripts.length === 0) return [];
  const manager = await detectManager(base);
  return scripts.map((name) => ({ name, command: runnerCommand(manager, name) }));
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
        id: `task.run.${task.name}`,
        title: `Run: ${task.name}`,
        group: 'Tasks',
        keywords: ['task', 'script', 'run', task.name, task.command],
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
