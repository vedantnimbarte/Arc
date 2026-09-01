import { create } from 'zustand';
import { fsReadDir, isTauri, procRun } from '../lib/tauri';
import { isRemotePath } from '../lib/remote';
import {
  actionCommand,
  findComposeFile,
  listCommand,
  parseContainers,
  type Container,
  type ContainerAction,
} from '../lib/docker';

// Docker panel state: what containers exist, and whether docker is even here.
//
// Everything runs through `proc_run` against the local machine — see
// `lib/docker.ts` for why there is no backend crate.
//
// `status` distinguishes the three cases the panel must render differently:
// docker isn't installed (offer nothing), the daemon isn't running (the CLI
// is there but every command fails), and normal operation. Collapsing the
// first two into one error would leave the user guessing which they have.

const LIST_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 60_000;

export type DockerStatus = 'unknown' | 'missing' | 'daemon-down' | 'ready';

interface DockerState {
  status: DockerStatus;
  containers: Container[];
  /** Compose file at the workspace root, if any — enables the compose bar. */
  composeFile: string | null;
  /** Root the compose detection belongs to. */
  root: string | null;
  loading: boolean;
  /** Last command error worth showing above the list. */
  error: string | null;
  /** Container ids with an action in flight. */
  busy: Record<string, true>;

  refresh: () => Promise<void>;
  detectCompose: (root: string | null) => Promise<void>;
  act: (id: string, action: ContainerAction) => Promise<void>;
}

export const useDocker = create<DockerState>((set, get) => ({
  status: 'unknown',
  containers: [],
  composeFile: null,
  root: null,
  loading: false,
  error: null,
  busy: {},

  refresh: async () => {
    if (!isTauri) {
      set({ status: 'missing', containers: [] });
      return;
    }
    set({ loading: true, error: null });
    const { program, args } = listCommand();
    try {
      // cwd only matters for compose; `docker ps` is daemon-wide. Use the
      // workspace root when there is one so a relative compose file resolves.
      const cwd = localRoot(get().root);
      const out = await procRun(cwd, program, args, LIST_TIMEOUT_MS);
      if (out.code === 0) {
        set({ status: 'ready', containers: parseContainers(out.stdout), loading: false });
        return;
      }
      // The CLI exists (it ran) but refused. Overwhelmingly this is the
      // daemon being down, and docker says so on stderr.
      set({
        status: 'daemon-down',
        containers: [],
        loading: false,
        error: firstLine(out.stderr) || 'docker is installed but not responding',
      });
    } catch (e) {
      // proc_run rejects when the binary itself could not be spawned.
      set({
        status: 'missing',
        containers: [],
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  detectCompose: async (root) => {
    if (!root || !isTauri || isRemotePath(root)) {
      set({ root, composeFile: null });
      return;
    }
    try {
      const entries = await fsReadDir(root);
      set({ root, composeFile: findComposeFile(entries.map((e) => e.name)) });
    } catch {
      set({ root, composeFile: null });
    }
  },

  act: async (id, action) => {
    if (!isTauri || get().busy[id]) return;
    const { program, args } = actionCommand(action, id);
    set((s) => ({ busy: { ...s.busy, [id]: true }, error: null }));
    try {
      const out = await procRun(localRoot(get().root), program, args, ACTION_TIMEOUT_MS);
      if (out.code !== 0) {
        set({ error: firstLine(out.stderr) || `docker ${action} failed` });
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set((s) => {
        const { [id]: _drop, ...busy } = s.busy;
        return { busy };
      });
    }
    await get().refresh();
  },
}));

/** A cwd `proc_run` can actually chdir into. A remote root is not one. */
function localRoot(root: string | null): string {
  return root && !isRemotePath(root) ? root : '.';
}

function firstLine(s: string): string {
  return s.trim().split(/\r?\n/)[0]?.trim() ?? '';
}
