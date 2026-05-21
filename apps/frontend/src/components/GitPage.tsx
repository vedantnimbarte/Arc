import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitBranch, RefreshCw, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { cn } from '../lib/cn';
import {
  gitAuthors,
  gitLog,
  type GitAuthorInfo,
  type GitLogEntry,
} from '../lib/tauri';
import { useFiles } from '../state/files';
import { AuthorsSidebar, authorKey } from './git/AuthorsSidebar';
import {
  FilterBar,
  type DateRange,
  type ViewMode,
} from './git/FilterBar';
import { CommitList } from './git/CommitList';
import { CommitGraph } from './git/CommitGraph';

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
    <div className="flex h-screen w-screen flex-col bg-bg-base text-fg-base">
      <TitleBar onRefresh={refresh} />

      {!root ? (
        <EmptyState text="Open a folder in the main window to see its git history." />
      ) : (
        <div className="flex min-h-0 flex-1">
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
              <ErrorTray message={commitsError ?? authorsError ?? ''} />
            )}

            {view === 'flat' ? (
              <CommitList commits={commits} />
            ) : (
              <CommitGraph commits={commits} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function TitleBar({ onRefresh }: { onRefresh: () => void }) {
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
      className="material-toolbar relative flex h-9 items-center justify-center px-3"
    >
      <div className="flex items-center gap-1.5 font-display text-[12px] font-semibold tracking-tight text-fg-base">
        <GitBranch size={12} strokeWidth={2.1} />
        <span>Git history</span>
      </div>
      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
        <button
          onClick={onRefresh}
          className="group flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle transition-all duration-200 ease-out hover:bg-white/[0.08] hover:text-fg-base active:scale-95"
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCw size={12} strokeWidth={2.1} className="transition-transform duration-500 ease-apple group-hover:rotate-180" />
        </button>
        <button
          onClick={close}
          className="group flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle transition-all duration-200 ease-out hover:bg-red-500/[0.18] hover:text-red-300 active:scale-95"
          aria-label="Close"
          title="Close (esc)"
        >
          <X size={13} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex flex-1 items-center justify-center px-8 py-12">
      <p className="max-w-sm text-center font-display text-[12.5px] text-fg-subtle">{text}</p>
    </div>
  );
}

function ErrorTray({ message }: { message: string }) {
  return (
    <div
      className={cn(
        'shrink-0 border-b border-border-hairline px-3 py-1.5',
        'bg-status-err/[0.08] font-display text-[11px] text-status-err/90',
      )}
    >
      {message}
    </div>
  );
}
