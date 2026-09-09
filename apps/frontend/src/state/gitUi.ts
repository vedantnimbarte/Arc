import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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

  /** Worktrees / rebase / reflog render inline in the source control panel;
   *  expanded pops the same panel out as the roomier modal. Closing resets to
   *  inline so the next open starts in the panel. */
  worktreeExpanded: boolean;
  setWorktreeExpanded: (v: boolean) => void;
  rebaseExpanded: boolean;
  setRebaseExpanded: (v: boolean) => void;
  reflogExpanded: boolean;
  setReflogExpanded: (v: boolean) => void;
  bisectExpanded: boolean;
  setBisectExpanded: (v: boolean) => void;

  /** Commit currently being cherry-picked. `null` = dialog closed. */
  cherryPickTarget: CherryPickContext | null;
  openCherryPick: (ctx: CherryPickContext) => void;
  closeCherryPick: () => void;

  rebasePanelOpen: boolean;
  setRebasePanelOpen: (open: boolean) => void;

  reflogPanelOpen: boolean;
  setReflogPanelOpen: (open: boolean) => void;

  bisectPanelOpen: boolean;
  setBisectPanelOpen: (open: boolean) => void;

  /** Collapse every git tool section at once — what the Changes row does. */
  closeGitPanels: () => void;

  /** Commit switches, remembered across sessions: `-S` (signature) and `-s`
   *  (Signed-off-by trailer). Off by default — a repo without a signing key
   *  configured fails the commit outright with `-S`. */
  signCommits: boolean;
  setSignCommits: (v: boolean) => void;
  signoffCommits: boolean;
  setSignoffCommits: (v: boolean) => void;

  /** PR panel is either closed, showing the list, or focused on a specific
   *  PR's detail, or in the create flow. Tracking which view is active in
   *  the store keeps PrPanel.tsx stateless across mounts. */
  prPanelView: { kind: 'closed' } | { kind: 'list' } | { kind: 'detail'; number: number } | { kind: 'create' };
  /** Same inline-vs-modal split as the other tools: the PR panel is a
   *  collapsible section of the source control panel until it's expanded. */
  prExpanded: boolean;
  setPrExpanded: (v: boolean) => void;
  openPrList: () => void;
  openPrDetail: (number: number) => void;
  openPrCreate: () => void;
  closePrPanel: () => void;
}

// Every git tool is its own collapsible section in the source control panel;
// they open independently, so only `closeGitPanels` clears the lot.
const CLOSED = {
  worktreePanelOpen: false,
  worktreeExpanded: false,
  rebasePanelOpen: false,
  rebaseExpanded: false,
  reflogPanelOpen: false,
  reflogExpanded: false,
  bisectPanelOpen: false,
  bisectExpanded: false,
} as const;

export const useGitUi = create<GitUiState>()(
  persist(
    (set) => ({
      ...CLOSED,
      setWorktreePanelOpen: (open) => set({ worktreePanelOpen: open, worktreeExpanded: false }),
      toggleWorktreePanel: () =>
        set((s) => ({ worktreePanelOpen: !s.worktreePanelOpen, worktreeExpanded: false })),

      setWorktreeExpanded: (v) => set({ worktreeExpanded: v }),
      setRebaseExpanded: (v) => set({ rebaseExpanded: v }),
      setReflogExpanded: (v) => set({ reflogExpanded: v }),
      setBisectExpanded: (v) => set({ bisectExpanded: v }),

      cherryPickTarget: null,
      openCherryPick: (ctx) => set({ cherryPickTarget: ctx }),
      closeCherryPick: () => set({ cherryPickTarget: null }),

      setRebasePanelOpen: (open) => set({ rebasePanelOpen: open, rebaseExpanded: false }),
      setReflogPanelOpen: (open) => set({ reflogPanelOpen: open, reflogExpanded: false }),
      setBisectPanelOpen: (open) => set({ bisectPanelOpen: open, bisectExpanded: false }),
      closeGitPanels: () => set({ ...CLOSED, prPanelView: { kind: 'closed' }, prExpanded: false }),

      signCommits: false,
      setSignCommits: (v) => set({ signCommits: v }),
      signoffCommits: false,
      setSignoffCommits: (v) => set({ signoffCommits: v }),

      prPanelView: { kind: 'closed' },
      prExpanded: false,
      setPrExpanded: (v) => set({ prExpanded: v }),
      openPrList: () => set({ prPanelView: { kind: 'list' } }),
      openPrDetail: (number) => set({ prPanelView: { kind: 'detail', number } }),
      openPrCreate: () => set({ prPanelView: { kind: 'create' } }),
      closePrPanel: () => set({ prPanelView: { kind: 'closed' }, prExpanded: false }),
    }),
    {
      name: 'arc-git-ui',
      // Which view the panel was showing, and the commit switches. The
      // expanded (modal) flags stay out: a modal shouldn't reopen itself on
      // launch, and neither should a cherry-pick or PR dialog.
      partialize: (s) => ({
        worktreePanelOpen: s.worktreePanelOpen,
        rebasePanelOpen: s.rebasePanelOpen,
        reflogPanelOpen: s.reflogPanelOpen,
        bisectPanelOpen: s.bisectPanelOpen,
        signCommits: s.signCommits,
        signoffCommits: s.signoffCommits,
      }),
    },
  ),
);
