import { useEffect } from 'react';
import {
  CircleDot,
  FolderGit2,
  GitPullRequest,
  Inbox,
  LogOut,
  Play,
  Tag,
  type LucideIcon,
} from 'lucide-react';
import { useGitHub, type GitHubSection } from '../../state/github';
import { cn } from '../../lib/cn';
import { SignIn } from './SignIn';
import { ReposView } from './ReposView';
import { IssuesView } from './IssuesView';
import { PullsView } from './PullsView';
import { ActionsView } from './ActionsView';
import { ReleasesView } from './ReleasesView';
import { InboxView } from './InboxView';

/** How often to re-read the hourly request budget. Five minutes: the number
 *  only matters as it approaches zero, and the call itself is free. */
const RATE_POLL_MS = 5 * 60 * 1000;

/**
 * The GitHub tab.
 *
 * Three panes: an account bar across the top, a section rail down the left,
 * and the section's own list/detail split filling the rest. It reads like the
 * Problems panel or a mail client rather than like github.com — this is a
 * workspace surface, not a browser.
 */
export function GitHubView() {
  const signedIn = useGitHub((s) => s.signedIn);
  const checkAuth = useGitHub((s) => s.checkAuth);
  const refreshRateLimit = useGitHub((s) => s.refreshRateLimit);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  // Poll the budget, not the data. `/rate_limit` costs nothing, so a slow tick
  // is free — and every other request in this tab is user-triggered, which is
  // what keeps the hourly budget from draining while the tab sits open.
  useEffect(() => {
    if (!signedIn) return;
    void refreshRateLimit();
    const id = setInterval(() => void refreshRateLimit(), RATE_POLL_MS);
    return () => clearInterval(id);
  }, [signedIn, refreshRateLimit]);

  if (signedIn === undefined) {
    // One frame of nothing beats flashing the sign-in screen at someone who
    // is already signed in.
    return <div className="h-full bg-bg-base" />;
  }

  if (!signedIn) {
    return (
      <div className="h-full overflow-y-auto bg-bg-base">
        <SignIn onSignedIn={() => void checkAuth()} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-bg-base">
      <AccountBar />
      <div className="flex min-h-0 flex-1">
        <SectionRail />
        <div className="min-w-0 flex-1">
          <SectionOutlet />
        </div>
      </div>
    </div>
  );
}

// ─── Account bar ───────────────────────────────────────────────────────────

function AccountBar() {
  const viewer = useGitHub((s) => s.viewer);
  const repo = useGitHub((s) => s.repo);
  const rateRemaining = useGitHub((s) => s.rateRemaining);
  const signOut = useGitHub((s) => s.signOut);
  const setSection = useGitHub((s) => s.setSection);

  return (
    <div className="material-toolbar flex h-10 shrink-0 items-center gap-2.5 px-3">
      {viewer && (
        <div className="flex min-w-0 items-center gap-1.5">
          <img
            src={viewer.avatarUrl}
            alt=""
            className="h-5 w-5 shrink-0 rounded-full ring-1 ring-edge-2"
          />
          <span className="truncate font-mono text-xs text-fg-muted">{viewer.login}</span>
        </div>
      )}

      {repo && (
        <button
          onClick={() => setSection('repos')}
          title="Pick a different repository"
          className="flex min-w-0 items-center rounded-md bg-surface-1 px-2 py-0.5 font-mono text-xs text-fg-base/85 ring-1 ring-inset ring-edge-1 transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:shadow-focus"
        >
          <span className="truncate">{repo}</span>
        </button>
      )}

      <div className="flex-1" />

      {/* Only worth a pixel when it's actually running out. */}
      {rateRemaining !== null && rateRemaining < 500 && (
        <span className="font-mono text-2xs tabular-nums text-status-warn/90">
          {rateRemaining} requests left this hour
        </span>
      )}

      <button
        onClick={() => void signOut()}
        aria-label="Sign out of GitHub"
        title="Sign out"
        className="flex h-6 w-6 items-center justify-center rounded-full text-fg-subtle transition-all duration-200 ease-out hover:bg-surface-2 hover:text-fg-base active:scale-90 focus-visible:outline-none focus-visible:shadow-focus"
      >
        <LogOut size={12} strokeWidth={2} />
      </button>
    </div>
  );
}

// ─── Section rail ──────────────────────────────────────────────────────────

const SECTIONS: { id: GitHubSection; label: string; icon: LucideIcon }[] = [
  { id: 'repos', label: 'Repositories', icon: FolderGit2 },
  { id: 'issues', label: 'Issues', icon: CircleDot },
  { id: 'pulls', label: 'Pull requests', icon: GitPullRequest },
  { id: 'actions', label: 'Actions', icon: Play },
  { id: 'releases', label: 'Releases', icon: Tag },
  { id: 'inbox', label: 'Inbox', icon: Inbox },
];

/** Sections that read one repository and can't render without one picked. */
const REPO_SCOPED = new Set<GitHubSection>(['issues', 'pulls', 'actions', 'releases']);

function SectionRail() {
  const section = useGitHub((s) => s.section);
  const setSection = useGitHub((s) => s.setSection);

  return (
    <nav
      aria-label="GitHub sections"
      className="flex w-[180px] shrink-0 flex-col gap-px border-r border-edge-1 p-2"
    >
      {SECTIONS.map(({ id, label, icon: Icon }) => {
        const active = section === id;
        return (
          <button
            key={id}
            onClick={() => setSection(id)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-left',
              'font-display text-xs transition-colors duration-150',
              'focus-visible:outline-none focus-visible:shadow-focus',
              active
                ? 'bg-surface-2 text-fg-base'
                : 'text-fg-muted hover:bg-surface-1 hover:text-fg-base',
            )}
          >
            <Icon
              size={13}
              strokeWidth={1.9}
              className={active ? 'text-accent-bright' : 'text-fg-subtle'}
            />
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

// ─── Section outlet ────────────────────────────────────────────────────────

function SectionOutlet() {
  const section = useGitHub((s) => s.section);
  const repo = useGitHub((s) => s.repo);
  const setSection = useGitHub((s) => s.setSection);

  if (REPO_SCOPED.has(section) && !repo) {
    return (
      <Placeholder
        title="Pick a repository first"
        body="Choose one in Repositories and this section will follow it."
        action={{ label: 'Go to Repositories', run: () => setSection('repos') }}
      />
    );
  }

  switch (section) {
    case 'repos':
      return <ReposView />;
    case 'issues':
      return <IssuesView />;
    case 'pulls':
      return <PullsView />;
    case 'actions':
      return <ActionsView />;
    case 'releases':
      return <ReleasesView />;
    case 'inbox':
      return <InboxView />;
  }
}

function Placeholder({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { label: string; run: () => void };
}) {
  return (
    <div className="flex h-full items-center justify-center px-8 py-12">
      <div className="max-w-xs text-center">
        <p className="font-display text-sm font-medium text-fg-base">{title}</p>
        <p className="mt-1 font-display text-xs leading-relaxed text-fg-muted">{body}</p>
        {action && (
          <button
            onClick={action.run}
            className="mt-4 h-7 rounded-lg bg-surface-2 px-3 font-display text-xs font-medium text-fg-base ring-1 ring-inset ring-edge-2 transition-all duration-200 ease-apple hover:bg-surface-3 active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-focus"
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}
