import { useCallback, useEffect, useState } from 'react';
import { FileDiff, RefreshCw } from 'lucide-react';
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
import { ListRow } from './ListRow';
import { prGlyph } from './stateGlyph';
import { meta, relative } from './format';
import { CommentThread, DetailHeader, ErrorTray, SplitPane, StateFilter } from './parts';

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
          <div className="flex-1" />
          <button
            onClick={() => void load(true)}
            aria-label="Refresh"
            title="Refresh"
            className="flex h-6 w-6 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base focus-visible:outline-none focus-visible:shadow-focus"
          >
            <RefreshCw size={12} strokeWidth={2} className={cn(loading && 'animate-spin')} />
          </button>
        </>
      }
      list={
        <>
          {error && <ErrorTray message={error} />}
          {prs.length === 0 && !loading && !error ? (
            <p className="px-2 py-8 text-center font-display text-xs text-fg-subtle">
              {filter === 'open'
                ? 'No open pull requests in this repository.'
                : `No ${filter} pull requests here.`}
            </p>
          ) : (
            prs.map((p) => {
              const g = prGlyph(p);
              return (
                <ListRow
                  key={p.number}
                  glyph={g.icon}
                  glyphClass={g.className}
                  title={p.title}
                  title_={`${g.label} · ${p.title}`}
                  meta={meta(
                    `#${p.number}`,
                    p.author,
                    relative(p.updated_at),
                    `${p.base} ← ${p.head}`,
                  )}
                  selected={selected === p.number}
                  onClick={() => setSelected(p.number)}
                />
              );
            })
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

type Tab = 'conversation' | 'files';

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
  if (!pr) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-accent" />
      </div>
    );
  }

  const g = prGlyph(pr);
  const open = pr.state === 'open';

  return (
    <div className="flex h-full flex-col">
      <DetailHeader
        glyph={g}
        number={pr.number}
        title={pr.title}
        subtitle={meta(pr.author, `${pr.base} ← ${pr.head}`, pr.draft && 'draft')}
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
                className="h-7 rounded-lg bg-surface-2 px-3 font-display text-xs font-medium text-fg-base ring-1 ring-inset ring-edge-2 transition-all duration-200 ease-apple hover:bg-surface-3 active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-40"
              >
                Merge
              </button>
              <button
                onClick={() => void close()}
                disabled={busy}
                className="h-7 rounded-lg px-2 font-display text-xs text-fg-muted transition-colors hover:bg-surface-1 hover:text-fg-base focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-40"
              >
                Close
              </button>
            </div>
          )
        }
      />

      {error && (
        <div className="px-4 pb-1">
          <ErrorTray message={error} />
        </div>
      )}

      {pr.mergeable === false && open && (
        <p className="px-4 pb-2 font-display text-2xs text-status-warn/90">
          This branch conflicts with {pr.base}. Resolve it locally before merging.
        </p>
      )}

      {reviews.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 px-4 pb-2">
          {reviews.map((r, i) => (
            <span key={`${r.author}-${i}`} className="font-mono text-2xs text-fg-subtle">
              <span
                className={cn(
                  r.state === 'APPROVED' && 'text-status-ok',
                  r.state === 'CHANGES_REQUESTED' && 'text-status-err',
                )}
              >
                {reviewWord(r.state)}
              </span>{' '}
              {r.author}
            </span>
          ))}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-0.5 border-b border-edge-1 px-4">
        <TabButton active={tab === 'conversation'} onClick={() => setTab('conversation')}>
          Conversation
        </TabButton>
        <TabButton active={tab === 'files'} onClick={() => setTab('files')}>
          Files {pr.files.length}
        </TabButton>
        <span className="ml-2 font-mono text-2xs tabular-nums text-fg-subtle">
          {pr.commits.length} commits
        </span>
      </div>

      {tab === 'conversation' ? (
        <CommentThread
          body={pr.body}
          author={pr.author}
          comments={thread}
          onPost={async (body) => {
            const posted = await gitHostIssueComment(owner, name, number, body);
            setThread((prev) => [...prev, posted]);
          }}
        />
      ) : (
        <FileList files={pr.files} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'border-b-2 px-2 py-1.5 font-display text-xs transition-colors',
        'focus-visible:outline-none focus-visible:shadow-focus',
        active
          ? 'border-accent text-fg-base'
          : 'border-transparent text-fg-subtle hover:text-fg-muted',
      )}
    >
      {children}
    </button>
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
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
      {files.map((f) => (
        <div key={f.path}>
          <ListRow
            glyph={FileDiff}
            title={f.path}
            title_={f.path}
            meta={meta(f.status, `+${f.additions}`, `−${f.deletions}`)}
            selected={open === f.path}
            onClick={() => setOpen(open === f.path ? null : f.path)}
          />
          {open === f.path && (
            <pre className="mx-2 mb-2 overflow-x-auto rounded-lg bg-surface-1 p-2.5 font-mono text-2xs leading-relaxed ring-1 ring-inset ring-edge-1">
              {f.patch ? (
                f.patch.split('\n').map((line, i) => (
                  <div
                    key={i}
                    className={cn(
                      line.startsWith('+') && !line.startsWith('+++') && 'text-status-ok',
                      line.startsWith('-') && !line.startsWith('---') && 'text-status-err',
                      line.startsWith('@@') && 'text-accent-muted',
                      'whitespace-pre',
                    )}
                  >
                    {line || ' '}
                  </div>
                ))
              ) : (
                <span className="italic text-fg-subtle">
                  No diff — the file is binary, or the patch was too large for the API.
                </span>
              )}
            </pre>
          )}
        </div>
      ))}
    </div>
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
