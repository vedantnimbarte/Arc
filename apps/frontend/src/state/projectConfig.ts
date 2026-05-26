import { create } from 'zustand';
import { projectConfigLoad, type ProjectConfig } from '../lib/tauri';
import { useFiles } from './files';

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
      return;
    }
    if (get().loadedRoot === root && !get().error) return;
    set({ loading: true, loadedRoot: root, error: null });
    try {
      const cfg = await projectConfigLoad(root);
      set({ config: cfg, loading: false });
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
