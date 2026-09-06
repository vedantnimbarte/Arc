import { useCallback, useEffect, useState } from 'react';
import {
  CircleDot,
  GitCommitHorizontal,
  GitPullRequest,
  MessagesSquare,
  RefreshCw,
  Tag,
  type LucideIcon,
} from 'lucide-react';
import {
  gitHostNotificationList,
  gitHostNotificationRead,
  type GitHostNotification,
} from '../../lib/tauri';
import { useGitHub, type GitHubSection } from '../../state/github';
import { cn } from '../../lib/cn';
import { ListRow } from './ListRow';
import { meta, relative } from './format';
import { ErrorTray, StateFilter } from './parts';

/** Why it reached you, in words a person would use. */
const REASON: Record<string, string> = {
  assign: 'assigned to you',
  author: 'you opened it',
  comment: 'new comment',
  ci_activity: 'a workflow finished',
  invitation: 'you were invited',
  manual: 'you subscribed',
  mention: 'you were mentioned',
  review_requested: 'your review was requested',
  security_alert: 'security alert',
  state_change: 'it was opened or closed',
  subscribed: 'you watch this repository',
  team_mention: 'your team was mentioned',
};

function subjectIcon(type: string): LucideIcon {
  switch (type) {
    case 'Issue':
      return CircleDot;
    case 'PullRequest':
      return GitPullRequest;
    case 'Commit':
      return GitCommitHorizontal;
    case 'Release':
      return Tag;
    default:
      return MessagesSquare;
  }
}

/**
 * The notification inbox — the one section that spans every repository, which
 * is why it doesn't use the repo-scoped split pane. Clicking a row jumps to the
 * thing it's about: it repoints the tab at that repository and opens the right
 * section, which is the whole reason to read the inbox inside the editor rather
 * than in a browser tab.
 */
export function InboxView() {
  const setRepo = useGitHub((s) => s.setRepo);
  const setSection = useGitHub((s) => s.setSection);

  const [showAll, setShowAll] = useState(false);
  const [items, setItems] = useState<GitHostNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await gitHostNotificationList(showAll));
    } catch (e) {
      setError(String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [showAll]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (n: GitHostNotification) => {
    // Mark read optimistically — the row's whole job is to stop demanding
    // attention, and a failed PATCH shouldn't block navigating to the thing.
    if (n.unread) {
      setItems((prev) => prev.map((i) => (i.id === n.id ? { ...i, unread: false } : i)));
      void gitHostNotificationRead(n.id).catch(() => {});
    }
    if (!n.repo) return;
    const target: GitHubSection | null =
      n.subject_type === 'PullRequest'
        ? 'pulls'
        : n.subject_type === 'Issue'
          ? 'issues'
          : n.subject_type === 'Release'
            ? 'releases'
            : null;
    setRepo(n.repo);
    if (target) setSection(target);
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge-1 px-3 py-2">
        <StateFilter
          value={showAll ? 'all' : 'unread'}
          onChange={(v) => setShowAll(v === 'all')}
          options={[
            { value: 'unread', label: 'Unread' },
            { value: 'all', label: 'All' },
          ]}
        />
        <div className="flex-1" />
        <button
          onClick={() => void load()}
          aria-label="Refresh"
          title="Refresh"
          className="flex h-6 w-6 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base focus-visible:outline-none focus-visible:shadow-focus"
        >
          <RefreshCw size={12} strokeWidth={2} className={cn(loading && 'animate-spin')} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {error && <ErrorTray message={error} />}
        {items.length === 0 && !loading && !error ? (
          <p className="px-2 py-8 text-center font-display text-xs text-fg-subtle">
            {showAll ? 'Nothing in your inbox.' : 'Nothing unread. You are caught up.'}
          </p>
        ) : (
          items.map((n) => (
            <ListRow
              key={n.id}
              glyph={subjectIcon(n.subject_type)}
              glyphClass={n.unread ? 'text-accent-bright' : 'text-fg-subtle'}
              title={n.title}
              title_={`${n.repo} — ${REASON[n.reason] ?? n.reason}`}
              meta={meta(
                n.repo,
                n.number != null && `#${n.number}`,
                REASON[n.reason] ?? n.reason,
                relative(n.updated_at),
              )}
              onClick={() => open(n)}
            />
          ))
        )}
      </div>
    </div>
  );
}
