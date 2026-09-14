import { create } from 'zustand';
import { isTauri } from '../lib/tauri';
import { isRemotePath } from '../lib/remote';
import { runUsage, type UsageSummary } from '../lib/usage';
import type { UsageAgent } from './settings';
import { useFiles } from './files';

// Status-bar usage popup: cached command output per agent id. Cached rather
// than re-run on every render because the command shells out — see
// `runUsage`'s docstring. Nothing here is persisted; a relaunch starts empty.

interface UsageResult {
  summary: UsageSummary | null;
  error: string | null;
  at: number;
}

interface UsageState {
  results: Record<string, UsageResult>;
  /** Agent id currently running, if any. */
  loading: string | null;
  /** Last agent picked in the popup. In-memory only — a relaunch just falls
   *  back to the first configured agent. */
  selectedId: string | null;
  select: (id: string) => void;
  refresh: (agent: UsageAgent) => Promise<void>;
}

export const useUsage = create<UsageState>((set, get) => ({
  results: {},
  loading: null,
  selectedId: null,

  select: (id) => set({ selectedId: id }),

  refresh: async (agent) => {
    if (!isTauri || get().loading === agent.id) return;
    set({ loading: agent.id });
    const root = useFiles.getState().root;
    const cwd = root && !isRemotePath(root) ? root : '.';
    try {
      const summary = await runUsage(agent.command, cwd);
      set((s) => ({
        loading: s.loading === agent.id ? null : s.loading,
        results: { ...s.results, [agent.id]: { summary, error: null, at: Date.now() } },
      }));
    } catch (e) {
      set((s) => ({
        loading: s.loading === agent.id ? null : s.loading,
        results: {
          ...s.results,
          [agent.id]: {
            summary: null,
            error: e instanceof Error ? e.message : String(e),
            at: Date.now(),
          },
        },
      }));
    }
  },
}));
