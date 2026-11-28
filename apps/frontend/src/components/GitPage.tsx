import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitBranch, GitPullRequest, ListOrdered, RefreshCw, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { cn } from '../lib/cn';
import {
  gitAuthors,
  gitCherryPick,
  gitLog,
  gitReset,
  gitRevert,
  type GitAuthorInfo,
  type GitLogEntry,
  type GitResetMode,
} from '../lib/tauri';
import { useFiles } from '../state/files';
import { useGitUi } from '../state/gitUi';
import { AuthorsSidebar, authorKey } from './git/AuthorsSidebar';
import { CherryPickDialog } from './git/CherryPickDialog';
import { PrPanel } from './git/PrPanel';
import { RebasePanel } from './git/RebasePanel';
import {
  FilterBar,
  type DateRange,
  type ViewMode,
} from './git/FilterBar';
import { CommitList } from './git/CommitList';
import { CommitGraph } from './git/CommitGraph';
import { askConfirm } from '../state/confirm';
import { EmptyState, ErrorNote } from './ui';

const COMMIT_LIMIT = 500;

export function GitPage() {
  const root = useFiles((s) => s.root);

  const [authors, setAuthors] = useState<GitAuthorInfo[]>([]);
  const [authorsLoading, setAuthorsLoading] = useState(false);
  const [authorsError, setAuthorsError] = useState<string | null>(null);

  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsError, setCommitsError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [range, setRange] = useState<DateRange>({ from: null, to: null, preset: null });
  const [view, setView] = useState<ViewMode>('flat');

  const selectedAuthors = useMemo(
    () => authors.filter((a) => selected.has(authorKey(a))),
    [authors, selected],
  );

  // Load authors once per root.
  useEffect(() => {
    if (!root) {
      setAuthors([]);
      return;
    }
    let cancelled = false;
    setAuthorsLoading(true);
    setAuthorsError(null);
    gitAuthors(root)
      .then((rows) => {
        if (cancelled) return;
        setAuthors(rows);
      })
      .catch((e) => {
        if (cancelled) return;
        setAuthorsError(String(e));
      })
      .finally(() => {
        if (!cancelled) setAuthorsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  // Build the git-log query whenever filters change.
  // Author filter: when one or more are selected, OR them by submitting
  // multiple regex alternations to --author (git accepts a POSIX BRE).
  // Empty selection = no filter.
  const fetchCommits = useCallback(
    async (signal: { cancelled: boolean }) => {
      if (!root) {
        setCommits([]);
        return;
      }
      setCommitsLoading(true);
      setCommitsError(null);
      const since = range.from ? Math.floor(new Date(range.from).getTime() / 1000) : null;
      // `until` is end-of-day so a single-day range still surfaces same-day commits.
      const until = range.to
        ? Math.floor((new Date(range.to).getTime() + 24 * 60 * 60 * 1000 - 1) / 1000)
        : null;

      const tokens = Array.from(selected).map(escapeRegex);
      const authorPattern = tokens.length === 0 ? null : tokens.join('|');

      try {
        const rows = await gitLog(root, COMMIT_LIMIT, {
          since,
          until,
          author: authorPattern,
          includeMerges: view === 'graph',
        });
        if (signal.cancelled) return;
        setCommits(rows);
      } catch (e) {
        if (signal.cancelled) return;
        setCommitsError(String(e));
        setCommits([]);
      } finally {
        if (!signal.cancelled) setCommitsLoading(false);
      }
    },
    [root, range.from, range.to, selected, view],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void fetchCommits(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [fetchCommits]);

  const toggleAuthor = useCallback((a: GitAuthorInfo) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = authorKey(a);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  const clearAuthors = useCallback(() => setSelected(new Set()), []);

  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const handleCherryPick = useCallback(async (oid: string) => {
    if (!root) return;
    const ok = await askConfirm({
      title: `Copy ${oid.slice(0, 7)} onto the current branch?`,
      body: 'Adds a new commit with the same changes on top of the branch you have checked out (cherry-pick).',
      confirmLabel: 'Copy commit',
    });
    if (!ok) return;
    setCommitsError(null);
    try {
      await gitCherryPick(root, oid);
      setActionMsg(`Copied ${oid.slice(0, 7)} onto the current branch`);
      setTimeout(() => setActionMsg(null), 3000);
      const signal = { cancelled: false };
      void fetchCommits(signal);
    } catch (e) {
      setCommitsError(String(e));
    }
  }, [root, fetchCommits]);

  // "Cherry-pick to…" — open the target-branch dialog. The dialog handles
  // the checkout + pick itself; we just push the snapshot in.
  const handleCherryPickTo = useCallback((commit: GitLogEntry) => {
    void import('../state/gitUi').then(({ useGitUi }) => {
      useGitUi.getState().openCherryPick({
        oid: commit.oid,
        shortOid: commit.short,
        subject: commit.subject,
      });
    });
  }, []);

  const handleRevert = useCallback(async (oid: string) => {
    if (!root) return;
    const ok = await askConfirm({
      title: `Undo ${oid.slice(0, 7)}?`,
      body: 'Adds a new commit that reverses its changes. The original commit stays in history (revert).',
      confirmLabel: 'Undo commit',
    });
    if (!ok) return;
    setCommitsError(null);
    try {
      await gitRevert(root, oid);
      setActionMsg(`Undid ${oid.slice(0, 7)} with a new commit`);
      setTimeout(() => setActionMsg(null), 3000);
      const signal = { cancelled: false };
      void fetchCommits(signal);
    } catch (e) {
      setCommitsError(String(e));
    }
  }, [root, fetchCommits]);

  const handleReset = useCallback(async (oid: string, mode: GitResetMode) => {
    if (!root) return;
    if (
      mode === 'hard' &&
      !(await askConfirm({
        title: `Move branch back to ${oid.slice(0, 7)} and throw away changes?`,
        body: 'Later commits and every uncommitted change in the working tree are discarded.',
        confirmLabel: 'Reset and discard changes',
        destructive: true,
      }))
    )
      return;
    setCommitsError(null);
    try {
      await gitReset(root, oid, mode);
      setActionMsg(`Moved branch back to ${oid.slice(0, 7)}`);
      setTimeout(() => setActionMsg(null), 3000);
      const signal = { cancelled: false };
      void fetchCommits(signal);
    } catch (e) {
      setCommitsError(String(e));
    }
  }, [root, fetchCommits]);

  const refresh = () => {
    if (!root) return;
    setAuthorsLoading(true);
    gitAuthors(root)
      .then(setAuthors)
      .catch((e) => setAuthorsError(String(e)))
      .finally(() => setAuthorsLoading(false));
    const signal = { cancelled: false };
    void fetchCommits(signal);
  };

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-bg-base text-fg-base">

      <TitleBar onRefresh={refresh} commitCount={commits.length} loading={commitsLoading} />

      {!root ? (
        // The Git window has no folder picker of its own; the main window does.
        <EmptyState
          icon={GitBranch}
          title="No folder open"
          body="Open a folder in the main Arc window, then its history shows up here."
          className="relative z-10 flex-1"
        />
      ) : (
        <div className="relative z-10 flex min-h-0 flex-1">
          <AuthorsSidebar
            authors={authors}
            selected={selected}
            onToggle={toggleAuthor}
            onClear={clearAuthors}
            loading={authorsLoading}
          />

          <div className="flex min-w-0 flex-1 flex-col">
            <FilterBar
              selectedAuthors={selectedAuthors}
              onRemoveAuthor={toggleAuthor}
              range={range}
              onRangeChange={setRange}
              view={view}
              onViewChange={setView}
              count={commits.length}
              loading={commitsLoading}
            />

            {(authorsError || commitsError) && (
              <ErrorNote error={commitsError ?? authorsError} className="mx-3 mt-2 shrink-0" />
            )}

            {actionMsg && (
              <div className="mx-3 mb-1 rounded-md bg-accent/10 px-3 py-1.5 font-display text-xs text-accent ring-1 ring-inset ring-accent/20">
                {actionMsg}
              </div>
            )}

            {view === 'flat' ? (
              <CommitList
                commits={commits}
                onCherryPick={handleCherryPick}
                onCherryPickTo={handleCherryPickTo}
                onRevert={handleRevert}
                onReset={handleReset}
              />
            ) : (
              <CommitGraph commits={commits} />
            )}
          </div>
        </div>
      )}

      <CherryPickDialog />
      <RebasePanel />
      <PrPanel />
    </div>
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function TitleBar({
  onRefresh,
  commitCount,
  loading,
}: {
  onRefresh: () => void;
  commitCount: number;
  loading: boolean;
}) {
  const close = () => {
    void getCurrentWindow().close();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      data-tauri-drag-region
      className="material-toolbar relative z-10 flex h-10 items-center justify-center px-3"
    >
      <div className="flex items-center gap-2 font-display text-sm font-semibold tracking-tight text-fg-base">
        <span
          className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-soft text-accent-bright"
          aria-hidden
        >
          <GitBranch size={11} strokeWidth={2.2} />
        </span>
        <span>Git history</span>
        {commitCount > 0 && (
          <span
            className={cn(
              'rounded-full bg-surface-1 px-1.5 py-[1px] font-mono text-2xs tabular-nums text-fg-muted',
              loading && 'animate-pulse-soft',
            )}
          >
            {commitCount}
          </span>
        )}
      </div>
      <div className="absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
        <button
          onClick={() => { useGitUi.getState().openPrList(); useGitUi.getState().setPrExpanded(true); }}
          className="group flex h-6 items-center gap-1 rounded-full px-2 text-fg-subtle transition-all duration-200 ease-out hover:bg-surface-2 hover:text-fg-base active:scale-95"
          aria-label="Pull requests"
          title="Pull requests"
        >
          <GitPullRequest size={11} strokeWidth={2.1} />
          <span className="font-display text-2xs">Pull requests</span>
        </button>
        <button
          onClick={() => useGitUi.getState().setRebasePanelOpen(true)}
          className="group flex h-6 items-center gap-1 rounded-full px-2 text-fg-subtle transition-all duration-200 ease-out hover:bg-surface-2 hover:text-fg-base active:scale-95"
          aria-label="Reorder commits (interactive rebase)"
          title="Reorder commits (interactive rebase)"
        >
          <ListOrdered size={11} strokeWidth={2.1} />
          <span className="font-display text-2xs">Reorder commits…</span>
        </button>
        <button
          onClick={onRefresh}
          className="group flex h-6 w-6 items-center justify-center rounded-full text-fg-subtle transition-all duration-200 ease-out hover:bg-surface-2 hover:text-fg-base active:scale-90"
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCw
            size={12}
            strokeWidth={2.1}
            className={cn(
              'transition-transform duration-500 ease-apple group-hover:rotate-180',
              loading && 'animate-spin',
            )}
          />
        </button>
        <button
          onClick={close}
          className="group flex h-6 w-6 items-center justify-center rounded-full text-fg-subtle transition-all duration-200 ease-out hover:bg-status-err/15 hover:text-status-err active:scale-90"
          aria-label="Close"
          title="Close (Esc)"
        >
          <X size={13} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  );
}
