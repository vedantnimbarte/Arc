import { useEffect } from 'react';
import {
  ChevronRight,
  ChevronsUpDown,
  CircleDot,
  FolderGit2,
  GitPullRequest,
  Inbox,
  LogOut,
  Play,
  Tag,
  type LucideIcon,
} from 'lucide-react';
import {
  githubRepoFromRemote,
  splitRepoKey,
  useGitHub,
  type GitHubSection,
} from '../../state/github';
import { useFiles } from '../../state/files';
import { gitRemotes } from '../../lib/tauri';
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
 * Three panes: a breadcrumb toolbar across the top, a section rail down the
 * left, and the section's own view filling the rest. It reads like a git
 * client — repositories as lanes, every list a timeline — rather than like
 * github.com: this is a workspace surface, not a browser.
 */
export function GitHubView() {
  const signedIn = useGitHub((s) => s.signedIn);
  const checkAuth = useGitHub((s) => s.checkAuth);
  const refreshRateLimit = useGitHub((s) => s.refreshRateLimit);
  useRememberWorkspaceClone();

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
    return <div className="h-full" />;
  }

  if (!signedIn) {
    return (
      <div className="h-full overflow-y-auto">
        <SignIn onSignedIn={() => void checkAuth()} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
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

/** Learn where the open workspace's repository lives, so its card can offer
 *  Open instead of Clone. Every GitHub remote counts — a fork's `upstream`
 *  is the same checkout. */
function useRememberWorkspaceClone() {
  const root = useFiles((s) => s.root);
  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    void gitRemotes(root)
      .then((remotes) => {
        if (cancelled) return;
        for (const r of remotes) {
          const key = githubRepoFromRemote(r.fetch_url);
          if (key) useGitHub.getState().rememberClone(key, root);
        }
      })
      .catch(() => {
        /* not a git repo, or no remotes — nothing to learn */
      });
    return () => {
      cancelled = true;
    };
  }, [root]);
}

// ─── Account bar ───────────────────────────────────────────────────────────

/**
 * Where you are: account, then the repository the sections are pointed at,
 * as a breadcrumb — the way a git client's toolbar names the open repo.
 */
function AccountBar() {
  const viewer = useGitHub((s) => s.viewer);
  const repo = useGitHub((s) => s.repo);
  const rateRemaining = useGitHub((s) => s.rateRemaining);
  const signOut = useGitHub((s) => s.signOut);
  const setSection = useGitHub((s) => s.setSection);
  const clones = useGitHub((s) => s.clones);
  const root = useFiles((s) => s.root);
  const parts = repo ? splitRepoKey(repo) : null;
  const isWorkspace = !!repo && !!root && clones[repo.toLowerCase()] === root;

  return (
    <div className="material-toolbar flex h-11 shrink-0 items-center gap-2 px-3">
      {viewer && (
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <img
            src={viewer.avatarUrl}
            alt=""
            className="h-6 w-6 shrink-0 rounded-full ring-1 ring-edge-2"
          />
          <span className="truncate font-display text-xs font-semibold text-fg-base">
            {viewer.login}
          </span>
        </div>
      )}

      <ChevronRight size={13} strokeWidth={2} className="shrink-0 text-fg-subtle" aria-hidden />

      {parts ? (
        <button
          onClick={() => setSection('repos')}
          title="Pick a different repository"
          className="flex h-7 min-w-0 items-center gap-1.5 rounded-md bg-surface-1 px-2.5 ring-1 ring-inset ring-edge-1 transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:shadow-focus"
        >
          <FolderGit2 size={13} strokeWidth={2} className="shrink-0 text-fg-subtle" />
          <span className="truncate font-mono text-xs">
            <span className="text-fg-subtle">{parts.owner}/</span>
            <span className="font-semibold text-fg-base">{parts.name}</span>
          </span>
          {isWorkspace && (
            <span
              className="ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-status-ok"
              title="This is your open workspace"
            />
          )}
          <ChevronsUpDown size={11} strokeWidth={2} className="shrink-0 text-fg-subtle" />
        </button>
      ) : (
        <span className="font-display text-xs text-fg-subtle">No repository picked</span>
      )}

      <div className="flex-1" />

      {/* Only worth a pixel when it's actually running out. */}
      {rateRemaining !== null && rateRemaining < 500 && (
        <span className="rounded-full bg-status-warn/10 px-2 py-0.5 font-mono text-2xs tabular-nums text-status-warn ring-1 ring-inset ring-status-warn/25">
          {rateRemaining} requests left this hour
        </span>
      )}

      <button
        onClick={() => void signOut()}
        aria-label="Sign out of GitHub"
        title="Sign out"
        className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base focus-visible:outline-none focus-visible:shadow-focus"
      >
        <LogOut size={13} strokeWidth={2} />
      </button>
    </div>
  );
}

// ─── Section rail ──────────────────────────────────────────────────────────

type RailItem = { id: GitHubSection; label: string; icon: LucideIcon };

const ACCOUNT_SECTIONS: RailItem[] = [
  { id: 'repos', label: 'Repositories', icon: FolderGit2 },
  { id: 'inbox', label: 'Inbox', icon: Inbox },
];

const REPO_SECTIONS: RailItem[] = [
  { id: 'issues', label: 'Issues', icon: CircleDot },
  { id: 'pulls', label: 'Pull requests', icon: GitPullRequest },
  { id: 'actions', label: 'Actions', icon: Play },
  { id: 'releases', label: 'Releases', icon: Tag },
];

/** Sections that read one repository and can't render without one picked. */
const REPO_SCOPED = new Set<GitHubSection>(REPO_SECTIONS.map((s) => s.id));

/**
 * Two groups, because they answer different questions: the account group
 * spans everything you can reach, the repository group is about the one repo
 * in the breadcrumb — so it's headed by that repo's name.
 */
function SectionRail() {
  const repo = useGitHub((s) => s.repo);
  const parts = repo ? splitRepoKey(repo) : null;

  return (
    <nav
      aria-label="GitHub sections"
      className="flex w-[196px] shrink-0 flex-col gap-4 border-r border-edge-1 px-2 py-3"
    >
      <RailGroup items={ACCOUNT_SECTIONS} />
      <RailGroup heading={parts ? parts.name : 'Repository'} title={repo ?? undefined} items={REPO_SECTIONS} dim={!repo} />
    </nav>
  );
}

function RailGroup({
  heading,
  title,
  items,
  dim,
}: {
  heading?: string;
  title?: string;
  items: RailItem[];
  dim?: boolean;
}) {
  const section = useGitHub((s) => s.section);
  const setSection = useGitHub((s) => s.setSection);

  return (
    <div className="flex flex-col gap-px">
      {heading && (
        <p title={title} className="mb-1 truncate px-2.5 font-display text-2xs font-semibold text-fg-subtle">
          {heading}
        </p>
      )}
      {items.map(({ id, label, icon: Icon }) => {
        const active = section === id;
        return (
          <button
            key={id}
            onClick={() => setSection(id)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-left',
              'font-display text-xs transition-colors duration-150',
              'focus-visible:outline-none focus-visible:shadow-focus',
              active
                ? 'bg-surface-2 font-medium text-fg-base'
                : dim
                  ? 'text-fg-subtle hover:bg-surface-1 hover:text-fg-muted'
                  : 'text-fg-muted hover:bg-surface-1 hover:text-fg-base',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'absolute inset-y-2 left-0 w-[2px] rounded-full bg-accent transition-opacity',
                active ? 'opacity-100' : 'opacity-0',
              )}
            />
            <Icon
              size={14}
              strokeWidth={2}
              className={active ? 'text-accent-bright' : 'text-fg-subtle'}
            />
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </div>
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
