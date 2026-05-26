import { create } from 'zustand';

// Open/close state for the Tier 2 git panels. Kept in one Zustand store so
// any component (status bar, command palette, commit-list context menu) can
// trigger them without prop-drilling through App.tsx.

interface CherryPickContext {
  oid: string;
  shortOid: string;
  subject: string;
}

interface GitUiState {
  worktreePanelOpen: boolean;
  setWorktreePanelOpen: (open: boolean) => void;
  toggleWorktreePanel: () => void;

  /** Commit currently being cherry-picked. `null` = dialog closed. */
  cherryPickTarget: CherryPickContext | null;
  openCherryPick: (ctx: CherryPickContext) => void;
  closeCherryPick: () => void;

  rebasePanelOpen: boolean;
  setRebasePanelOpen: (open: boolean) => void;

  /** PR panel is either closed, showing the list, or focused on a specific
   *  PR's detail, or in the create flow. Tracking which view is active in
   *  the store keeps PrPanel.tsx stateless across mounts. */
  prPanelView: { kind: 'closed' } | { kind: 'list' } | { kind: 'detail'; number: number } | { kind: 'create' };
  openPrList: () => void;
  openPrDetail: (number: number) => void;
  openPrCreate: () => void;
  closePrPanel: () => void;
}

export const useGitUi = create<GitUiState>((set) => ({
  worktreePanelOpen: false,
  setWorktreePanelOpen: (open) => set({ worktreePanelOpen: open }),
  toggleWorktreePanel: () =>
    set((s) => ({ worktreePanelOpen: !s.worktreePanelOpen })),

  cherryPickTarget: null,
  openCherryPick: (ctx) => set({ cherryPickTarget: ctx }),
  closeCherryPick: () => set({ cherryPickTarget: null }),

  rebasePanelOpen: false,
  setRebasePanelOpen: (open) => set({ rebasePanelOpen: open }),

  prPanelView: { kind: 'closed' },
  openPrList: () => set({ prPanelView: { kind: 'list' } }),
  openPrDetail: (number) => set({ prPanelView: { kind: 'detail', number } }),
  openPrCreate: () => set({ prPanelView: { kind: 'create' } }),
  closePrPanel: () => set({ prPanelView: { kind: 'closed' } }),
}));
