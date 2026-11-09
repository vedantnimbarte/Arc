import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useFiles } from './files';
import { useWorkspace } from './workspace';

/**
 * "Vibe" is the agent-first layout: the Claude window fills the work area
 * and the sidebar steps aside. "IDE" puts back exactly what Vibe changed —
 * nothing more — so a user who maximized a pane or collapsed the sidebar
 * themselves doesn't get it undone on the way out.
 */
interface VibeState {
  vibe: boolean;
  /** Agents panel shown as a floating card over the editor. Persisted. */
  floatingAgentOpen: boolean;
  /** What Vibe changed, so exiting restores only that. */
  restore: {
    maximizedPaneId: string | null;
    sidebarCollapsed: boolean;
    floatingAgentOpen: boolean;
  } | null;
  enterVibe: () => void;
  exitVibe: () => void;
  toggleVibe: () => void;
  toggleFloatingAgent: () => void;
  setFloatingAgentOpen: (open: boolean) => void;
}

export const useVibe = create<VibeState>()(
  persist(
    (set, get) => ({
      vibe: false,
      floatingAgentOpen: false,
      restore: null,
      enterVibe: () => {
        if (get().vibe) return;
        const workspace = useWorkspace.getState();
        const files = useFiles.getState();
        const restore = {
          maximizedPaneId: workspace.maximizedPaneId,
          sidebarCollapsed: files.collapsed,
          floatingAgentOpen: get().floatingAgentOpen,
        };

        const existing = workspace.tabs.find(
          (t) =>
            t.kind === 'claude' &&
            (t.workspaceId ?? workspace.activeWorkspaceId) === workspace.activeWorkspaceId,
        );
        const tabId = existing?.id ?? workspace.openClaudeCode(files.root);
        useWorkspace.getState().setActive(tabId);

        const { focusedPaneId, maximizedPaneId } = useWorkspace.getState();
        if (maximizedPaneId !== focusedPaneId) {
          useWorkspace.getState().toggleMaximizePane(focusedPaneId);
        }
        if (!files.collapsed) files.toggleCollapsed();
        set({ vibe: true, restore, floatingAgentOpen: false });
      },
      exitVibe: () => {
        const { vibe, restore } = get();
        if (!vibe) return;
        if (restore) {
          const workspace = useWorkspace.getState();
          if (workspace.maximizedPaneId !== restore.maximizedPaneId) {
            useWorkspace.setState({ maximizedPaneId: restore.maximizedPaneId });
          }
          const files = useFiles.getState();
          if (files.collapsed !== restore.sidebarCollapsed) files.toggleCollapsed();
        }
        set({
          vibe: false,
          restore: null,
          floatingAgentOpen: restore?.floatingAgentOpen ?? get().floatingAgentOpen,
        });
      },
      toggleVibe: () => (get().vibe ? get().exitVibe() : get().enterVibe()),
      toggleFloatingAgent: () => set((s) => ({ floatingAgentOpen: !s.floatingAgentOpen })),
      setFloatingAgentOpen: (open) => set({ floatingAgentOpen: open }),
    }),
    {
      name: 'arc-vibe',
      // Vibe itself is per-session: relaunching into a maximized agent with a
      // hidden sidebar would read as a broken layout.
      partialize: (s) => ({ floatingAgentOpen: s.floatingAgentOpen }),
    },
  ),
);
