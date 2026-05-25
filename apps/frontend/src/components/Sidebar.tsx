import { useEffect } from 'react';
import { FileTree } from './FileTree';
import { SourceControl } from './SourceControl';
import { isTauri } from '../lib/tauri';
import { useFiles } from '../state/files';
import { useGit } from '../state/git';

/**
 * Left-rail container that owns the file tree / source control switch. The
 * two views toggle from their own header (FileTree shows a Source Control
 * icon top-right; SourceControl shows a Files icon) — there is no separate
 * tab strip. We keep the git poller here so both views share one cache.
 */
export function Sidebar() {
  const view = useFiles((s) => s.sidebarView);
  const root = useFiles((s) => s.root);
  const refresh = useGit((s) => s.refresh);
  const reset = useGit((s) => s.reset);

  // Single git poller for the whole sidebar — both `SourceControl` and the
  // FileTree header badge subscribe to the same store, so we never poll twice.
  useEffect(() => {
    if (!isTauri || !root) {
      reset();
      return;
    }
    void refresh(root);
    const id = window.setInterval(() => void refresh(root), 4000);
    return () => window.clearInterval(id);
  }, [refresh, reset, root]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="min-h-0 flex-1">
        {view === 'files' ? <FileTree /> : <SourceControl />}
      </div>
    </div>
  );
}
