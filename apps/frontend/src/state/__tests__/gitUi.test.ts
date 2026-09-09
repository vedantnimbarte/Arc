import { describe, expect, it, beforeEach } from 'vitest';
import { useGitUi } from '../gitUi';

describe('gitUi panel flags', () => {
  beforeEach(() => useGitUi.getState().closeGitPanels());

  it('opens the tool sections independently', () => {
    useGitUi.getState().setWorktreePanelOpen(true);
    useGitUi.getState().setReflogPanelOpen(true);
    const s = useGitUi.getState();
    expect(s.worktreePanelOpen).toBe(true);
    expect(s.reflogPanelOpen).toBe(true);
  });

  it('drops back to inline when a section is reopened', () => {
    useGitUi.getState().setRebasePanelOpen(true);
    useGitUi.getState().setRebaseExpanded(true);
    useGitUi.getState().setRebasePanelOpen(true);
    expect(useGitUi.getState().rebaseExpanded).toBe(false);
  });

  it('closeGitPanels collapses every section, PRs included', () => {
    useGitUi.getState().setBisectPanelOpen(true);
    useGitUi.getState().setWorktreePanelOpen(true);
    useGitUi.getState().openPrList();
    useGitUi.getState().closeGitPanels();
    const s = useGitUi.getState();
    expect(s.bisectPanelOpen).toBe(false);
    expect(s.worktreePanelOpen).toBe(false);
    expect(s.prPanelView.kind).toBe('closed');
  });

  it('opens the PR panel inline, not as an overlay', () => {
    useGitUi.getState().openPrList();
    expect(useGitUi.getState().prExpanded).toBe(false);
    useGitUi.getState().setPrExpanded(true);
    useGitUi.getState().closePrPanel();
    expect(useGitUi.getState().prExpanded).toBe(false);
  });
});
