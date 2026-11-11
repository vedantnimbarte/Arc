import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, FileCode2, GitCommitHorizontal, MessageSquare } from 'lucide-react';
import {
  gitHostIssueComment,
  gitHostIssueGet,
  gitHostIssueSetState,
  gitHostPrGetFor,
  gitHostPrMerge,
  gitHostPrReviews,
  type GitHostComment,
  type GitHostMergeMethod,
  type GitHostPrDetail,
  type GitHostPrListFilter,
  type GitHostPrSummary,
  type GitHostReview,
} from '../../lib/tauri';
import { splitRepoKey, useGitHub } from '../../state/github';
import { askConfirm } from '../../state/confirm';
import { cn } from '../../lib/cn';
import { Select } from '../Select';
import { ListRow, laneEnds } from './ListRow';
import { prGlyph } from './stateGlyph';
import { laneColor } from './format';
import {
  Avatar,
  BranchFlow,
  CommentThread,
  Count,
  DetailHeader,
  EmptyNote,
  ErrorTray,
  Fact,
  Loading,
  RefreshButton,
  SplitPane,
  StateFilter,
  ago,
  buttonGhost,
  buttonPrimary,
} from './parts';

export function PullsView() {
  const repoKey = useGitHub((s) => s.repo);
  const parts = repoKey ? splitRepoKey(repoKey) : null;

  const [filter, setFilter] = useState<GitHostPrListFilter>('open');
  const [prs, setPrs] = useState<GitHostPrSummary[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Through the store, not `gitHostPrListFor` directly: the Source Control
  // sidebar's PR sheet reads the same cache, so merging here is visible there
  // without a second fetch or a stale list.
  const load = useCallback(
    async (force = false) => {
      if (!parts) return;
      setLoading(true);
      setError(null);
      try {
        setPrs(await useGitHub.getState().loadPrs(parts.owner, parts.name, filter, force));
      } catch (e) {
        setError(String(e));
        setPrs([]);
      } finally {
        setLoading(false);
      }
    },
    [parts?.owner, parts?.name, filter],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (selected !== null && !prs.some((p) => p.number === selected)) setSelected(null);
  }, [prs, selected]);

  if (!parts) return null;

  return (
    <SplitPane
      toolbar={
        <>
          <StateFilter
            value={filter}
            onChange={(v) => setFilter(v as GitHostPrListFilter)}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'closed', label: 'Closed' },
              { value: 'all', label: 'All' },
            ]}
          />
          {!loading && <Count n={prs.length} one="pull request" many="pull requests" />}
          <div className="flex-1" />
          <RefreshButton loading={loading} onClick={() => void load(true)} />
        </>
      }
      list={
        <>
          {error && <ErrorTray message={error} />}
          {prs.length === 0 && loading && <Loading />}
          {prs.length === 0 && !loading && !error ? (
            <EmptyNote>
              {filter === 'open'
                ? 'No open pull requests in this repository.'
                : `No ${filter} pull requests here.`}
            </EmptyNote>
          ) : (
            <div className={laneEnds}>
              {prs.map((p) => {
                const g = prGlyph(p);
                return (
                  <ListRow
                    key={p.number}
                    glyph={g.icon}
                    glyphClass={g.className}
                    title={p.title}
                    number={`#${p.number}`}
                    title_={`${g.label}: ${p.title}`}
                    meta={
                      <>
                        <BranchFlow head={p.head} base={p.base} />
                        <Avatar src={p.author_avatar} login={p.author} />
                        <Fact>{ago(p.updated_at)}</Fact>
                      </>
                    }
                    selected={selected === p.number}
                    onClick={() => setSelected(p.number)}
                  />
                );
              })}
            </div>
          )}
        </>
      }
      detail={
        selected === null ? (
          <div className="flex h-full items-center justify-center px-8">
            <p className="max-w-xs text-center font-display text-xs text-fg-subtle">
              Pick a pull request to read its conversation and diff.
            </p>
          </div>
        ) : (
          <PullDetail
            key={`${repoKey}#${selected}`}
            owner={parts.owner}
            name={parts.name}
            number={selected}
            onMerged={() => {
              useGitHub.getState().invalidatePrs(parts.owner, parts.name);
              void load(true);
            }}
          />
        )
      }
    />
  );
}

type Tab = 'conversation' | 'commits' | 'files';

function PullDetail({
  owner,
  name,
  number,
  onMerged,
}: {
  owner: string;
  name: string;
  number: number;
  onMerged: () => void;
}) {
  const [pr, setPr] = useState<GitHostPrDetail | null>(null);
  const [reviews, setReviews] = useState<GitHostReview[]>([]);
  const [thread, setThread] = useState<GitHostComment[]>([]);
  const [tab, setTab] = useState<Tab>('conversation');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState<GitHostMergeMethod>('merge');

  useEffect(() => {
    let cancelled = false;
    setPr(null);
    setError(null);
    setTab('conversation');
    gitHostPrGetFor(owner, name, number)
      .then((d) => !cancelled && setPr(d))
      .catch((e) => !cancelled && setError(String(e)));
    // Reviews and the conversation thread are extra colour, not the point of
    // the pane — a failure to load either shouldn't blank the whole PR.
    gitHostPrReviews(owner, name, number)
      .then((r) => !cancelled && setReviews(r))
      .catch(() => {});
    gitHostIssueGet(owner, name, number)
      .then((i) => !cancelled && setThread(i.thread))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [owner, name, number]);

  const merge = async () => {
    if (!pr) return;
    const ok = await askConfirm({
      title: `${method === 'merge' ? 'Merge' : method === 'squash' ? 'Squash and merge' : 'Rebase and merge'} #${pr.number}?`,
      body: `${pr.title}\n\n${pr.head} into ${pr.base}. This writes to the repository.`,
      confirmLabel: 'Merge',
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await gitHostPrMerge(owner, name, number, method);
      setPr({ ...pr, state: 'merged' });
      onMerged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    if (!pr) return;
    const ok = await askConfirm({
      title: `Close #${pr.number} without merging?`,
      body: pr.title,
      confirmLabel: 'Close',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await gitHostIssueSetState(owner, name, number, false);
      setPr({ ...pr, state: 'closed' });
      onMerged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !pr) {
    return (
      <div className="p-3">
        <ErrorTray message={error} />
      </div>
    );
  }
  if (!pr) return <Loading />;

  const g = prGlyph(pr);
  const open = pr.state === 'open';
  const additions = pr.files.reduce((n, f) => n + f.additions, 0);
  const deletions = pr.files.reduce((n, f) => n + f.deletions, 0);

  return (
    <div className="flex h-full flex-col">
      <DetailHeader
        glyph={g}
        number={`#${pr.number}`}
        title={pr.title}
        facts={
          <>
            <Avatar src={pr.author_avatar} login={pr.author} />
            <span className="font-display text-2xs text-fg-subtle">wants to merge</span>
            <BranchFlow head={pr.head} base={pr.base} />
            <span className="font-mono text-2xs tabular-nums">
              <span className="text-status-ok">+{additions}</span>{' '}
              <span className="text-status-err">−{deletions}</span>
            </span>
            {reviews.map((r, i) => (
              <span
                key={`${r.author}-${i}`}
                className={cn(
                  'font-mono text-2xs',
                  r.state === 'APPROVED'
                    ? 'text-status-ok'
                    : r.state === 'CHANGES_REQUESTED'
                      ? 'text-status-err'
                      : 'text-fg-subtle',
                )}
              >
                {r.author} {reviewWord(r.state)}
              </span>
            ))}
          </>
        }
        htmlUrl={pr.html_url}
        actions={
          open && (
            <div className="flex shrink-0 items-center gap-1">
              <Select
                value={method}
                onChange={setMethod}
                ariaLabel="Merge method"
                size="compact"
                className="w-auto rounded-lg"
                options={[
                  { value: 'merge', label: 'Merge', hint: 'Keeps every commit and adds a merge commit.' },
                  { value: 'squash', label: 'Squash', hint: 'Collapses the branch into one commit on the base.' },
                  { value: 'rebase', label: 'Rebase', hint: 'Replays each commit onto the base, no merge commit.' },
                ]}
              />
              <button
                onClick={() => void merge()}
                disabled={busy || pr.mergeable === false}
                title={pr.mergeable === false ? 'This branch has conflicts with the base' : undefined}
                className={buttonPrimary}
              >
                Merge
              </button>
              <button onClick={() => void close()} disabled={busy} className={buttonGhost}>
                Close
              </button>
            </div>
          )
        }
      />

      {(error || (pr.mergeable === false && open)) && (
        <div className="px-5 pt-3">
          {error && <ErrorTray message={error} />}
          {pr.mergeable === false && open && (
            <p className="rounded-lg bg-status-warn/[0.08] px-3 py-2 font-display text-xs text-status-warn ring-1 ring-inset ring-status-warn/20">
              This branch conflicts with {pr.base}. Resolve it locally before merging.
            </p>
          )}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-1 border-b border-edge-1 px-4">
        <TabButton active={tab === 'conversation'} onClick={() => setTab('conversation')} icon={MessageSquare} count={thread.length}>
          Conversation
        </TabButton>
        <TabButton active={tab === 'commits'} onClick={() => setTab('commits')} icon={GitCommitHorizontal} count={pr.commits.length}>
          Commits
        </TabButton>
        <TabButton active={tab === 'files'} onClick={() => setTab('files')} icon={FileCode2} count={pr.files.length}>
          Files
        </TabButton>
      </div>

      {tab === 'conversation' && (
        <CommentThread
          body={pr.body}
          author={pr.author}
          authorAvatar={pr.author_avatar}
          comments={thread}
          onPost={async (body) => {
            const posted = await gitHostIssueComment(owner, name, number, body);
            setThread((prev) => [...prev, posted]);
          }}
        />
      )}
      {tab === 'commits' && <CommitGraph commits={pr.commits} branch={pr.head} />}
      {tab === 'files' && <FileList files={pr.files} />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof MessageSquare;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        '-mb-px flex h-10 items-center gap-1.5 border-b-2 px-2.5 font-display text-xs transition-colors',
        'focus-visible:outline-none focus-visible:shadow-focus',
        active
          ? 'border-accent font-medium text-fg-base'
          : 'border-transparent text-fg-subtle hover:text-fg-muted',
      )}
    >
      <Icon size={13} strokeWidth={2} />
      {children}
      <span className="rounded-full bg-surface-2 px-1.5 font-mono text-2xs tabular-nums text-fg-muted">
        {count}
      </span>
    </button>
  );
}

/**
 * The branch's commits as a graph: one lane in the head branch's colour, a
 * node per commit, newest at the top — the way a git client draws a branch.
 */
function CommitGraph({ commits, branch }: { commits: GitHostPrDetail['commits']; branch: string }) {
  const c = laneColor(branch);
  const newestFirst = [...commits].reverse();

  if (commits.length === 0) return <EmptyNote>This pull request has no commits.</EmptyNote>;

  return (
    <ol className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {newestFirst.map((k, i) => {
        const subject = k.message.split('\n')[0];
        const last = i === newestFirst.length - 1;
        return (
          <li key={k.oid} className="flex gap-3">
            <span className="flex w-4 shrink-0 flex-col items-center" aria-hidden>
              <span className="h-[11px] w-[2px]" style={{ backgroundColor: i === 0 ? 'transparent' : c }} />
              <span
                className="h-[11px] w-[11px] shrink-0 rounded-full border-2"
                style={{ borderColor: c, backgroundColor: i === 0 ? c : 'transparent' }}
              />
              <span className="w-[2px] flex-1" style={{ backgroundColor: last ? 'transparent' : c }} />
            </span>
            <div className="min-w-0 flex-1 rounded-md py-1.5 pr-2">
              <p className="truncate font-display text-xs font-medium text-fg-base/90" title={k.message}>
                {subject}
              </p>
              <p className="mt-0.5 flex items-center gap-2.5">
                <span className="font-mono text-2xs" style={{ color: c }}>
                  {k.short}
                </span>
                <Fact>{k.author}</Fact>
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** The changed files, each expandable into its unified diff.
 *
 *  The patch GitHub returns is already a unified diff, so it is shown as one
 *  rather than re-parsed into a side-by-side view — that machinery lives in
 *  Arc's DiffView, which reads from a working tree, not from a PR API. */
function FileList({ files }: { files: GitHostPrDetail['files'] }) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
      {files.map((f) => {
        const expanded = open === f.path;
        const slash = f.path.lastIndexOf('/');
        return (
          <div key={f.path} className="overflow-hidden rounded-lg ring-1 ring-inset ring-edge-1">
            <button
              onClick={() => setOpen(expanded ? null : f.path)}
              aria-expanded={expanded}
              title={f.path}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
                'focus-visible:outline-none focus-visible:shadow-focus',
                expanded ? 'bg-surface-2' : 'bg-surface-1 hover:bg-surface-2',
              )}
            >
              <ChevronRight
                size={12}
                strokeWidth={2.2}
                className={cn('shrink-0 text-fg-subtle transition-transform', expanded && 'rotate-90')}
              />
              <FileStatus status={f.status} />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                <span className="text-fg-subtle">{slash >= 0 ? f.path.slice(0, slash + 1) : ''}</span>
                <span className="text-fg-base/90">{f.path.slice(slash + 1)}</span>
              </span>
              <span className="shrink-0 font-mono text-2xs tabular-nums">
                <span className="text-status-ok">+{f.additions}</span>{' '}
                <span className="text-status-err">−{f.deletions}</span>
              </span>
              <ChangeBar additions={f.additions} deletions={f.deletions} />
            </button>
            {expanded && (
              <pre className="overflow-x-auto border-t border-edge-1 py-2 font-mono text-2xs leading-relaxed">
                {f.patch ? (
                  f.patch.split('\n').map((line, i) => (
                    <div
                      key={i}
                      className={cn(
                        'whitespace-pre px-3',
                        line.startsWith('+') && !line.startsWith('+++') && 'bg-status-ok/[0.08] text-status-ok',
                        line.startsWith('-') && !line.startsWith('---') && 'bg-status-err/[0.08] text-status-err',
                        line.startsWith('@@') && 'bg-surface-1 text-accent-muted',
                      )}
                    >
                      {line || ' '}
                    </div>
                  ))
                ) : (
                  <span className="px-3 italic text-fg-subtle">
                    No diff — the file is binary, or the patch was too large for the API.
                  </span>
                )}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** One letter for what happened to the file, coloured like a git client's. */
function FileStatus({ status }: { status: string }) {
  const [letter, cls] =
    status === 'added'
      ? ['A', 'text-status-ok']
      : status === 'removed'
        ? ['D', 'text-status-err']
        : status === 'renamed'
          ? ['R', 'text-status-merged']
          : ['M', 'text-status-warn'];
  return (
    <span className={cn('w-3 shrink-0 text-center font-mono text-2xs font-bold', cls)} title={status}>
      {letter}
    </span>
  );
}

/** Five blocks split between added and removed lines, as GitHub draws it. */
function ChangeBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  const green = total === 0 ? 0 : Math.round((additions / total) * 5);
  return (
    <span className="flex shrink-0 gap-px" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={cn(
            'h-2 w-2 rounded-[2px]',
            total === 0 ? 'bg-surface-3' : i < green ? 'bg-status-ok' : 'bg-status-err',
          )}
        />
      ))}
    </span>
  );
}

function reviewWord(state: string): string {
  switch (state) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes requested';
    case 'DISMISSED':
      return 'dismissed';
    default:
      return 'commented';
  }
}
