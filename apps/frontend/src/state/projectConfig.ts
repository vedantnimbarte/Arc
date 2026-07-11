import { create } from 'zustand';
import {
  mcpConnect,
  mcpConnectHttp,
  projectConfigLoad,
  type ProjectConfig,
} from '../lib/tauri';
import { useAgents, type Agent } from './agents';
import { useFiles } from './files';
import { useTrust, configNeedsTrust } from './trust';

/** Map a `.arc/config.toml` agent onto the UI's Agent shape. Ids are prefixed
 *  so they can't collide with built-ins or user customs. */
function toAgent(a: ProjectConfig['agents'][number]): Agent {
  return {
    id: `project-${a.id}`,
    name: a.label || a.id,
    description: 'Defined in .arc/config.toml',
    systemPrompt: a.prompt,
    iconKey: 'terminal',
    tint: 'lime',
    builtin: false,
    createdAt: 0,
  };
}

/** Push a freshly-loaded config into its consumers: register project agents
 *  and auto-connect declared MCP servers. Both are best-effort — a failure in
 *  one server/agent must not block the others or the config load itself.
 *
 *  SECURITY: only call this for a trusted root. Both spawning MCP servers and
 *  registering agent prompts run repo-supplied content; the caller gates on
 *  `useTrust`. Exported so `<TrustPrompt>` can apply after the user consents. */
export function applyProjectConfig(cfg: ProjectConfig | null): void {
  useAgents.getState().setProjectAgents((cfg?.agents ?? []).map(toAgent));
  for (const s of cfg?.mcp_servers ?? []) {
    // stdio (command) takes precedence over HTTP (url) when both are set.
    if (s.command && s.command.length > 0) {
      void mcpConnect(s.id, s.command[0]!, s.command.slice(1)).catch((e) =>
        console.warn(`[project-config] MCP connect ${s.id} failed:`, e),
      );
    } else if (s.url) {
      void mcpConnectHttp(s.id, s.url, s.headers).catch((e) =>
        console.warn(`[project-config] MCP connect ${s.id} failed:`, e),
      );
    }
  }
}

// Per-project `.arc/config.toml` state. Loaded once when the workspace root
// changes; consumers (env injection, agents, theme override) read from here.
// Live re-load is intentionally out of scope for Tier 0 — adding a watcher is
// straightforward once a consumer actually needs sub-restart updates.

interface ProjectConfigState {
  config: ProjectConfig | null;
  /** Last root we attempted to load — keeps the loader idempotent so
   *  StrictMode's double-mount doesn't double-fetch. */
  loadedRoot: string | null;
  /** True between `reload()` start and resolve. */
  loading: boolean;
  /** Last parse / IO error from the loader. `null` when there's no config or
   *  it loaded cleanly. Surfaced in the settings panel for diagnostics. */
  error: string | null;
  /** Re-read `<root>/.arc/config.toml`. No-op when root is null. */
  reload: (root: string | null) => Promise<void>;
}

export const useProjectConfig = create<ProjectConfigState>((set, get) => ({
  config: null,
  loadedRoot: null,
  loading: false,
  error: null,
  reload: async (root) => {
    if (root === null) {
      set({ config: null, loadedRoot: null, error: null, loading: false });
      applyProjectConfig(null);
      return;
    }
    if (get().loadedRoot === root && !get().error) return;
    set({ loading: true, loadedRoot: root, error: null });
    try {
      const cfg = await projectConfigLoad(root);
      set({ config: cfg, loading: false });
      // Never apply repo-supplied MCP servers / agents / env from an untrusted
      // folder — that's drive-by RCE on `git clone && open`. Prompt instead;
      // `<TrustPrompt>` re-applies once the user consents.
      if (configNeedsTrust(cfg) && !useTrust.getState().isTrusted(root)) {
        applyProjectConfig(null);
        useTrust.getState().request(root, cfg!);
      } else {
        applyProjectConfig(cfg);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[project-config] load failed:', message);
      set({ config: null, loading: false, error: message });
    }
  },
}));

// Auto-reload whenever the file-tree root changes. Subscribing here keeps the
// orchestration out of the workspace store and out of App.tsx — any code that
// reads `useProjectConfig` just gets the current snapshot.
useFiles.subscribe((state, prev) => {
  if (state.root === prev.root) return;
  void useProjectConfig.getState().reload(state.root);
});

// Kick off an initial load for whatever root files.ts has at module-init
// time. Safe to call before hydrate — `reload(null)` is a no-op.
void useProjectConfig.getState().reload(useFiles.getState().root);
