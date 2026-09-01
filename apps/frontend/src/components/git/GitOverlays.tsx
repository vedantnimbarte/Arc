import { BisectPanel } from './BisectPanel';
import { CherryPickDialog } from './CherryPickDialog';
import { PrPanel } from './PrPanel';
import { RebasePanel } from './RebasePanel';
import { ReflogPanel } from './ReflogPanel';
import { WorktreePanel } from './WorktreePanel';
import { useGitUi } from '../../state/gitUi';

/**
 * The git overlays that live at App level. Each self-gates on `useGitUi` and
 * renders null when closed, so grouping them costs nothing at runtime — but
 * it gives App a single lazy boundary, keeping the PR UI out of the entry
 * chunk until a git overlay is opened.
 *
 * Worktrees, rebase, reflog and bisect live inline in the source control
 * panel by default;
 * they appear here only once expanded, which is what makes them a modal.
 * Fixed positioning has to escape the sidebar's backdrop-filter, so the
 * expanded form is mounted at App level rather than in the panel.
 *
 * App only mounts this once `useGitUi` reports something open; see
 * `anyGitOverlayOpen` there.
 */
export function GitOverlays() {
  const worktreeExpanded = useGitUi((s) => s.worktreeExpanded);
  const rebaseExpanded = useGitUi((s) => s.rebaseExpanded);
  const reflogExpanded = useGitUi((s) => s.reflogExpanded);
  const bisectExpanded = useGitUi((s) => s.bisectExpanded);
  return (
    <>
      <CherryPickDialog />
      <PrPanel />
      {worktreeExpanded && <WorktreePanel />}
      {rebaseExpanded && <RebasePanel />}
      {reflogExpanded && <ReflogPanel />}
      {bisectExpanded && <BisectPanel />}
    </>
  );
}
