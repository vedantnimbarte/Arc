import { WorktreePanel } from './WorktreePanel';
import { CherryPickDialog } from './CherryPickDialog';
import { RebasePanel } from './RebasePanel';
import { PrPanel } from './PrPanel';

/**
 * The four git overlays that live at App level. Each self-gates on `useGitUi`
 * and renders null when closed, so grouping them costs nothing at runtime —
 * but it gives App a single lazy boundary, keeping ~1.9k lines of rebase /
 * worktree / PR UI out of the entry chunk until a git overlay is opened.
 *
 * App only mounts this once `useGitUi` reports something open; see
 * `anyGitOverlayOpen` there.
 */
export function GitOverlays() {
  return (
    <>
      <WorktreePanel />
      <CherryPickDialog />
      <RebasePanel />
      <PrPanel />
    </>
  );
}
