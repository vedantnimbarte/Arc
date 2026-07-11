import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ProjectConfig } from '../lib/tauri';

// Workspace trust (VS Code's lesson): a repo's `.arc/config.toml` can inject
// shell env into terminals — which runs attacker-influenced values the moment
// you open a cloned folder. Nothing from a config is applied until the user
// explicitly trusts that root.

/** True when the config carries anything that can alter the shell environment
 *  — the only case that needs a trust decision. A config with just a theme /
 *  workspace name is harmless and never prompts. */
export function configNeedsTrust(cfg: ProjectConfig | null): boolean {
  if (!cfg) return false;
  return Object.keys(cfg.env ?? {}).length > 0;
}

interface Pending {
  root: string;
  cfg: ProjectConfig;
}

interface TrustState {
  /** Absolute roots the user has explicitly trusted. Persisted. */
  trustedRoots: string[];
  /** A risky config awaiting the user's decision, or null. Not persisted. */
  pending: Pending | null;
  isTrusted: (root: string | null) => boolean;
  /** Park a trust decision for a root's risky config (no-op if already
   *  trusted). Surfaces `<TrustPrompt>`. */
  request: (root: string, cfg: ProjectConfig) => void;
  /** Resolve the pending prompt. `true` marks the root trusted for good. */
  respond: (trust: boolean) => void;
}

export const useTrust = create<TrustState>()(
  persist(
    (set, get) => ({
      trustedRoots: [],
      pending: null,
      isTrusted: (root) => !!root && get().trustedRoots.includes(root),
      request: (root, cfg) => {
        if (get().isTrusted(root)) return;
        set({ pending: { root, cfg } });
      },
      respond: (trust) => {
        const p = get().pending;
        if (!p) return;
        set((s) => ({
          pending: null,
          trustedRoots:
            trust && !s.trustedRoots.includes(p.root)
              ? [...s.trustedRoots, p.root]
              : s.trustedRoots,
        }));
      },
    }),
    { name: 'arc-trust', partialize: (s) => ({ trustedRoots: s.trustedRoots }) },
  ),
);
