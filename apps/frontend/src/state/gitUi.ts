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

  /** Worktrees / rebase render inline in the source control panel; expanded
   *  pops the same panel out as the roomier modal. Closing resets to inline
   *  so the next open starts in the panel. */
  worktreeExpanded: boolean;
  setWorktreeExpanded: (v: boolean) => void;
  rebaseExpanded: boolean;
  setRebaseExpanded: (v: boolean) => void;

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

// Worktrees and rebase share one slot in the source control panel — opening
// one replaces the other rather than stacking a second section below it.
const CLOSED = {
  worktreePanelOpen: false,
  worktreeExpanded: false,
  rebasePanelOpen: false,
  rebaseExpanded: false,
} as const;

export const useGitUi = create<GitUiState>((set) => ({
  ...CLOSED,
  setWorktreePanelOpen: (open) =>
    set(open ? { ...CLOSED, worktreePanelOpen: true } : CLOSED),
  toggleWorktreePanel: () =>
    set((s) => (s.worktreePanelOpen ? CLOSED : { ...CLOSED, worktreePanelOpen: true })),

  setWorktreeExpanded: (v) => set({ worktreeExpanded: v }),
  setRebaseExpanded: (v) => set({ rebaseExpanded: v }),

  cherryPickTarget: null,
  openCherryPick: (ctx) => set({ cherryPickTarget: ctx }),
  closeCherryPick: () => set({ cherryPickTarget: null }),

  setRebasePanelOpen: (open) => set(open ? { ...CLOSED, rebasePanelOpen: true } : CLOSED),

  prPanelView: { kind: 'closed' },
  openPrList: () => set({ prPanelView: { kind: 'list' } }),
  openPrDetail: (number) => set({ prPanelView: { kind: 'detail', number } }),
  openPrCreate: () => set({ prPanelView: { kind: 'create' } }),
  closePrPanel: () => set({ prPanelView: { kind: 'closed' } }),
}));
