import { useEffect } from 'react';
import { FileTree } from './FileTree';
import { SourceControl } from './SourceControl';
import { fsWatchStart, fsWatchStop, isTauri } from '../lib/tauri';
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

  // Single git refresh driver for the whole sidebar — both `SourceControl`
  // and the FileTree header badge subscribe to the same store, so the work
  // happens once. A recursive fs watcher (which also sees `.git/` churn —
  // staging, commits, checkouts) refreshes near-instantly; a slow interval
  // backstops changes the OS watcher can miss (network drives, atomic-rename
  // saves).
  useEffect(() => {
    if (!isTauri || !root) {
      reset();
      return;
    }
    let active = true;
    let unlisten: (() => void) | null = null;
    let watchId: string | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    void refresh(root);

    // Coalesce a burst of fs events (git writes many `.git/*` files at once)
    // into a single refresh shortly after they settle.
    const onChange = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(root), 400);
    };
    void fsWatchStart(root, onChange)
      .then((res) => {
        if (!active) {
          res.unlisten();
          void fsWatchStop(res.watchId);
          return;
        }
        watchId = res.watchId;
        unlisten = res.unlisten;
      })
      .catch(() => {
        /* Watcher unavailable; the backstop poll still keeps status fresh. */
      });

    const pollId = window.setInterval(() => void refresh(root), 20_000);

    return () => {
      active = false;
      if (debounce) clearTimeout(debounce);
      window.clearInterval(pollId);
      unlisten?.();
      if (watchId) void fsWatchStop(watchId);
    };
  }, [refresh, reset, root]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="min-h-0 flex-1">
        {view === 'files' ? <FileTree /> : <SourceControl />}
      </div>
    </div>
  );
}
