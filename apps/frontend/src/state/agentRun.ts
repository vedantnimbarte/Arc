import { create } from 'zustand';
import { gitChanges, gitRoot, isTauri } from '../lib/tauri';

/**
 * "What did the agent just change?", for every AI CLI ARC can launch.
 *
 * The Claude Code panel answers this by watching its tool calls stream past
 * (see `state/claudeCode.ts`), which only works for a CLI ARC parses. The
 * other eleven run as plain terminal tabs, so there is nothing to parse —
 * but there is a git repository, and it already knows.
 *
 * So: snapshot which files were dirty at the moment the agent launched, and
 * treat anything that differs from that snapshot afterwards as the agent's
 * work. No per-CLI wire format, nothing to keep in step with an upstream
 * release, and it works identically for all thirteen. On a clean tree the
 * snapshot is empty and every change is the agent's — the common case.
 *
 * The snapshot is deliberately not persisted: it describes one run, and a
 * baseline restored from three days ago would quietly filter the panel
 * against a tree that has moved on.
 */

/** What was already dirty in one repo when an agent started. */
export interface AgentBaseline {
  /** Display label of the CLI that was launched, e.g. `"Claude Code"`. */
  agent: string;
  startedAt: number;
  /**
   * Repo-relative path → porcelain status letter at launch. A path that is
   * absent, or present with a *different* letter, is the agent's doing —
   * which covers new files, edits to files you had already touched, and
   * anything that moved between the index and the worktree.
   */
  before: Record<string, string>;
}

interface AgentRunState {
  /** Keyed by workspace root, so two projects don't share one baseline. */
  baselines: Record<string, AgentBaseline>;
  /** Whether Source Control narrows to the agent's changes. */
  filtering: boolean;
  /** Snapshot `root` and start attributing changes to `agent`. No-op outside
   *  a git repo — there would be nothing to diff against. */
  mark: (root: string | null, agent: string) => Promise<void>;
  clear: (root: string) => void;
  setFiltering: (on: boolean) => void;
}

/** Did `entry` change since the baseline was taken? */
export function agentTouched(
  before: AgentBaseline['before'],
  entry: { path: string; status: string },
): boolean {
  return before[entry.path] !== entry.status;
}

export const useAgentRun = create<AgentRunState>((set) => ({
  baselines: {},
  filtering: true,

  mark: async (root, agent) => {
    if (!isTauri || !root) return;
    try {
      if (!(await gitRoot(root))) return;
      const before: AgentBaseline['before'] = {};
      for (const e of await gitChanges(root)) before[e.path] = e.status;
      set((s) => ({
        baselines: { ...s.baselines, [root]: { agent, startedAt: Date.now(), before } },
        // A fresh run re-arms the filter: the reason you launched an agent is
        // to see what it did.
        filtering: true,
      }));
    } catch (err) {
      // Best-effort. Without a baseline the panel just behaves as it always
      // has, which is a fine thing to fall back to.
      console.error('[agent-run] baseline failed:', err);
    }
  },

  clear: (root) =>
    set((s) => {
      const { [root]: _dropped, ...rest } = s.baselines;
      return { baselines: rest };
    }),

  setFiltering: (on) => set({ filtering: on }),
}));
