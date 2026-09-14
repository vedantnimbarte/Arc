import { create } from 'zustand';
import { isTauri } from '../lib/tauri';
import { isRemotePath } from '../lib/remote';
import { fetchPlanLimits, runUsage, type PlanLimit, type UsageSummary } from '../lib/usage';
import type { UsageAgent } from './settings';
import { useFiles } from './files';

// Status-bar usage popup: cached command output per agent id. Cached rather
// than re-run on every render because the command shells out — see
// `runUsage`'s docstring. Nothing here is persisted; a relaunch starts empty.

interface UsageResult {
  summary: UsageSummary | null;
  error: string | null;
  at: number;
  /** Claude plan limits — only fetched for Claude agents (`isClaudeAgent`).
   *  Undefined until they land, which is usually well before the command. */
  limits?: PlanLimit[];
  limitsError?: string;
}

/** Claude agents get plan-limit bars on top of their command output. The id
 *  check keeps the default agent working after a rename. */
export function isClaudeAgent(agent: UsageAgent): boolean {
  return agent.id === 'claude' || /claude|ccusage/i.test(agent.command);
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

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useUsage = create<UsageState>((set, get) => {
  /** Merge into one agent's result without clobbering the other fetch's half. */
  const patch = (id: string, fields: Partial<UsageResult>) =>
    set((s) => ({
      results: {
        ...s.results,
        [id]: { summary: null, error: null, ...s.results[id], ...fields, at: Date.now() },
      },
    }));

  return {
    results: {},
    loading: null,
    selectedId: null,

    select: (id) => set({ selectedId: id }),

    refresh: async (agent) => {
      if (!isTauri || get().loading === agent.id) return;
      set({ loading: agent.id });
      const root = useFiles.getState().root;
      const cwd = root && !isRemotePath(root) ? root : '.';

      const limits = isClaudeAgent(agent)
        ? fetchPlanLimits().then(
            (l) => patch(agent.id, { limits: l, limitsError: undefined }),
            (e) => patch(agent.id, { limits: undefined, limitsError: errMsg(e) }),
          )
        : undefined;

      try {
        patch(agent.id, { summary: await runUsage(agent.command, cwd), error: null });
      } catch (e) {
        patch(agent.id, { summary: null, error: errMsg(e) });
      }
      await limits;
      set((s) => ({ loading: s.loading === agent.id ? null : s.loading }));
    },
  };
});
