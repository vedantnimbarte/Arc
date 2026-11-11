import { useCallback, useEffect, useState } from 'react';
import {
  CircleDot,
  GitCommitHorizontal,
  GitPullRequest,
  MessagesSquare,
  Tag,
  type LucideIcon,
} from 'lucide-react';
import {
  gitHostNotificationList,
  gitHostNotificationRead,
  type GitHostNotification,
} from '../../lib/tauri';
import { useGitHub, type GitHubSection } from '../../state/github';
import { ListRow, laneEnds } from './ListRow';
import { laneColor } from './format';
import {
  Count,
  EmptyNote,
  ErrorTray,
  Fact,
  Loading,
  RefreshButton,
  StateFilter,
  Toolbar,
  ago,
} from './parts';

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

  // One group per repository, in the order its newest notification arrived —
  // the inbox is a set of conversations, and they live in repos.
  const groups: { repo: string; items: GitHostNotification[] }[] = [];
  for (const n of items) {
    const g = groups.find((x) => x.repo === n.repo);
    if (g) g.items.push(n);
    else groups.push({ repo: n.repo, items: [n] });
  }
  const unread = items.filter((n) => n.unread).length;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <Toolbar>
        <StateFilter
          value={showAll ? 'all' : 'unread'}
          onChange={(v) => setShowAll(v === 'all')}
          options={[
            { value: 'unread', label: 'Unread' },
            { value: 'all', label: 'All' },
          ]}
        />
        {!loading && <Count n={unread} one="unread" many="unread" />}
        <div className="flex-1" />
        <RefreshButton loading={loading} onClick={() => void load()} />
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {error && <ErrorTray message={error} />}
        {items.length === 0 && loading && <Loading />}
        {items.length === 0 && !loading && !error ? (
          <EmptyNote>
            {showAll ? 'Nothing in your inbox.' : 'Nothing unread. You are caught up.'}
          </EmptyNote>
        ) : (
          <div className="mx-auto max-w-4xl space-y-4">
            {groups.map((g) => (
              <section key={g.repo}>
                <h3 className="mb-1 flex items-center gap-2 px-1 font-mono text-2xs">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: laneColor(g.repo) }}
                    aria-hidden
                  />
                  <span className="truncate font-semibold text-fg-muted">{g.repo}</span>
                  <span className="text-fg-subtle">{g.items.length}</span>
                </h3>
                <div className={laneEnds}>
                  {g.items.map((n) => (
                    <ListRow
                      key={n.id}
                      glyph={subjectIcon(n.subject_type)}
                      glyphClass={n.unread ? 'text-accent-bright' : 'text-fg-subtle'}
                      title={
                        <span className={n.unread ? 'font-semibold text-fg-base' : 'text-fg-muted'}>
                          {n.title}
                        </span>
                      }
                      number={n.number != null ? `#${n.number}` : undefined}
                      title_={`${n.repo}: ${REASON[n.reason] ?? n.reason}`}
                      meta={
                        <>
                          <Fact>{REASON[n.reason] ?? n.reason}</Fact>
                          <Fact>{ago(n.updated_at)}</Fact>
                        </>
                      }
                      right={
                        n.unread ? (
                          <span className="h-2 w-2 rounded-full bg-accent" aria-label="Unread" />
                        ) : undefined
                      }
                      onClick={() => open(n)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
