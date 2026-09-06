import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Plus, RefreshCw } from 'lucide-react';
import {
  gitHostIssueComment,
  gitHostIssueCreate,
  gitHostIssueGet,
  gitHostIssueList,
  gitHostIssueSetState,
  gitHostLabelList,
  shellOpenExternal,
  type GitHostIssueDetail,
  type GitHostIssueState,
  type GitHostIssueSummary,
  type GitHostLabel,
} from '../../lib/tauri';
import { splitRepoKey, useGitHub } from '../../state/github';
import { askConfirm } from '../../state/confirm';
import { cn } from '../../lib/cn';
import { ListRow } from './ListRow';
import { issueGlyph } from './stateGlyph';
import { meta, relative } from './format';
import { CommentThread, DetailHeader, ErrorTray, SplitPane, StateFilter } from './parts';

export function IssuesView() {
  const repoKey = useGitHub((s) => s.repo);
  const parts = repoKey ? splitRepoKey(repoKey) : null;

  const [state, setState] = useState<GitHostIssueState>('open');
  const [issues, setIssues] = useState<GitHostIssueSummary[]>([]);
  const [labels, setLabels] = useState<GitHostLabel[]>([]);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const load = useCallback(async () => {
    if (!parts) return;
    setLoading(true);
    setError(null);
    try {
      setIssues(
        await gitHostIssueList(parts.owner, parts.name, {
          state,
          labels: activeLabel ? [activeLabel] : [],
          assignee: null,
          author: null,
        }),
      );
    } catch (e) {
      setError(String(e));
      setIssues([]);
    } finally {
      setLoading(false);
    }
  }, [parts?.owner, parts?.name, state, activeLabel]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!parts) return;
    void gitHostLabelList(parts.owner, parts.name)
      .then(setLabels)
      .catch(() => {
        /* labels are a convenience — the list works without the filter */
      });
  }, [parts?.owner, parts?.name]);

  // Selecting an issue that's no longer in the list (state filter changed)
  // would leave the detail pane showing something the list denies exists.
  useEffect(() => {
    if (selected !== null && !issues.some((i) => i.number === selected)) {
      setSelected(null);
    }
  }, [issues, selected]);

  if (!parts) return null;

  /** Fold a changed issue back into the list so both panes agree. */
  const patch = (updated: GitHostIssueSummary) => {
    setIssues((prev) =>
      state === 'all' || updated.state === state
        ? prev.map((i) => (i.number === updated.number ? updated : i))
        : prev.filter((i) => i.number !== updated.number),
    );
  };

  return (
    <SplitPane
      toolbar={
        <>
          <StateFilter
            value={state}
            onChange={(v) => setState(v as GitHostIssueState)}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'closed', label: 'Closed' },
              { value: 'all', label: 'All' },
            ]}
          />
          {labels.length > 0 && (
            <select
              value={activeLabel ?? ''}
              onChange={(e) => setActiveLabel(e.target.value || null)}
              aria-label="Filter by label"
              className="h-7 max-w-[140px] rounded-md bg-surface-1 px-2 font-display text-2xs text-fg-muted ring-1 ring-inset ring-edge-1 focus:outline-none focus:shadow-focus"
            >
              <option value="">Any label</option>
              {labels.map((l) => (
                <option key={l.name} value={l.name}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
          <div className="flex-1" />
          <button
            onClick={() => setComposing(true)}
            className="flex h-7 items-center gap-1 rounded-md px-2 font-display text-2xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base focus-visible:outline-none focus-visible:shadow-focus"
          >
            <Plus size={11} strokeWidth={2.2} />
            New issue
          </button>
          <button
            onClick={() => void load()}
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
          {issues.length === 0 && !loading && !error ? (
            <p className="px-2 py-8 text-center font-display text-xs text-fg-subtle">
              {state === 'open'
                ? 'No open issues in this repository.'
                : `No ${state} issues here.`}
            </p>
          ) : (
            issues.map((i) => {
              const g = issueGlyph(i.state);
              return (
                <ListRow
                  key={i.number}
                  glyph={g.icon}
                  glyphClass={g.className}
                  title={i.title}
                  title_={`${g.label} · ${i.title}`}
                  meta={meta(
                    `#${i.number}`,
                    i.author,
                    relative(i.updated_at),
                    i.comments > 0 && `${i.comments} comments`,
                    ...i.labels.slice(0, 2).map((l) => l.name),
                  )}
                  selected={selected === i.number}
                  onClick={() => setSelected(i.number)}
                />
              );
            })
          )}
        </>
      }
      detail={
        composing ? (
          <NewIssueForm
            owner={parts.owner}
            name={parts.name}
            labels={labels}
            onCancel={() => setComposing(false)}
            onCreated={(created) => {
              setComposing(false);
              setSelected(created.number);
              void load();
            }}
          />
        ) : selected === null ? (
          <EmptyDetail />
        ) : (
          <IssueDetail
            key={`${repoKey}#${selected}`}
            owner={parts.owner}
            name={parts.name}
            number={selected}
            onChanged={patch}
          />
        )
      }
    />
  );
}

function EmptyDetail() {
  return (
    <div className="flex h-full items-center justify-center px-8">
      <p className="max-w-xs text-center font-display text-xs text-fg-subtle">
        Pick an issue to read it and its comments.
      </p>
    </div>
  );
}

function IssueDetail({
  owner,
  name,
  number,
  onChanged,
}: {
  owner: string;
  name: string;
  number: number;
  onChanged: (updated: GitHostIssueSummary) => void;
}) {
  const [issue, setIssue] = useState<GitHostIssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIssue(null);
    setError(null);
    gitHostIssueGet(owner, name, number)
      .then((d) => !cancelled && setIssue(d))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [owner, name, number]);

  const toggleState = async () => {
    if (!issue) return;
    const closing = issue.state === 'open';
    if (closing) {
      const ok = await askConfirm({
        title: `Close issue #${issue.number}?`,
        body: issue.title,
        confirmLabel: 'Close issue',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const updated = await gitHostIssueSetState(owner, name, number, !closing);
      setIssue({ ...issue, state: updated.state });
      onChanged(updated);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const postComment = async (body: string) => {
    const posted = await gitHostIssueComment(owner, name, number, body);
    setIssue((prev) => (prev ? { ...prev, thread: [...prev.thread, posted] } : prev));
  };

  if (error) {
    return (
      <div className="p-3">
        <ErrorTray message={error} />
      </div>
    );
  }
  if (!issue) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-accent" />
      </div>
    );
  }

  const g = issueGlyph(issue.state);

  return (
    <div className="flex h-full flex-col">
      <DetailHeader
        glyph={g}
        number={issue.number}
        title={issue.title}
        subtitle={meta(issue.author, `opened ${relative(issue.updated_at)} ago`)}
        htmlUrl={issue.html_url}
        actions={
          <button
            onClick={() => void toggleState()}
            disabled={busy}
            className="h-7 rounded-lg bg-surface-2 px-3 font-display text-xs font-medium text-fg-base ring-1 ring-inset ring-edge-2 transition-all duration-200 ease-apple hover:bg-surface-3 active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-40"
          >
            {issue.state === 'open' ? 'Close issue' : 'Reopen issue'}
          </button>
        }
      />

      {issue.labels.length > 0 && (
        <div className="flex flex-wrap gap-1 px-4 pb-2">
          {issue.labels.map((l) => (
            <span
              key={l.name}
              className="rounded-full px-2 py-0.5 font-display text-2xs"
              style={{
                // The label's own colour is the information — it's how the
                // repo's maintainers chose to group things.
                color: `#${l.color || '888888'}`,
                backgroundColor: `#${l.color || '888888'}1a`,
                boxShadow: `inset 0 0 0 1px #${l.color || '888888'}33`,
              }}
            >
              {l.name}
            </span>
          ))}
        </div>
      )}

      <CommentThread body={issue.body} author={issue.author} comments={issue.thread} onPost={postComment} />
    </div>
  );
}

function NewIssueForm({
  owner,
  name,
  labels,
  onCancel,
  onCreated,
}: {
  owner: string;
  name: string;
  labels: GitHostLabel[];
  onCancel: () => void;
  onCreated: (issue: GitHostIssueSummary) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(
        await gitHostIssueCreate(owner, name, {
          title: title.trim(),
          body,
          labels: picked,
        }),
      );
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col p-4">
      <h2 className="font-display text-sm font-semibold tracking-tight text-fg-base">
        New issue in <span className="font-mono font-normal">{owner}/{name}</span>
      </h2>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        autoFocus
        className="mt-3 h-8 rounded-lg bg-surface-1 px-2.5 font-display text-sm text-fg-base ring-1 ring-inset ring-edge-2 placeholder:text-fg-subtle/70 focus:outline-none focus:shadow-focus"
      />

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Describe the problem, and what you expected instead."
        className="mt-2 min-h-0 flex-1 resize-none rounded-lg bg-surface-1 p-2.5 font-display text-xs leading-relaxed text-fg-base ring-1 ring-inset ring-edge-2 placeholder:text-fg-subtle/70 focus:outline-none focus:shadow-focus"
      />

      {labels.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {labels.slice(0, 12).map((l) => {
            const on = picked.includes(l.name);
            return (
              <button
                key={l.name}
                onClick={() =>
                  setPicked((p) => (on ? p.filter((x) => x !== l.name) : [...p, l.name]))
                }
                className={cn(
                  'rounded-full px-2 py-0.5 font-display text-2xs transition-opacity',
                  !on && 'opacity-45 hover:opacity-80',
                  'focus-visible:outline-none focus-visible:shadow-focus',
                )}
                style={{
                  color: `#${l.color || '888888'}`,
                  backgroundColor: `#${l.color || '888888'}1a`,
                  boxShadow: `inset 0 0 0 1px #${l.color || '888888'}33`,
                }}
                aria-pressed={on}
              >
                {l.name}
              </button>
            );
          })}
        </div>
      )}

      {error && <div className="mt-2"><ErrorTray message={error} /></div>}

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => void submit()}
          disabled={busy || !title.trim()}
          className="h-7 rounded-lg bg-surface-2 px-3 font-display text-xs font-medium text-fg-base ring-1 ring-inset ring-edge-2 transition-all duration-200 ease-apple hover:bg-surface-3 active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-40"
        >
          {busy ? 'Creating…' : 'Create issue'}
        </button>
        <button
          onClick={onCancel}
          className="h-7 rounded-lg px-3 font-display text-xs text-fg-muted transition-colors hover:bg-surface-1 hover:text-fg-base focus-visible:outline-none focus-visible:shadow-focus"
        >
          Cancel
        </button>
        <div className="flex-1" />
        <button
          onClick={() => void shellOpenExternal(`https://github.com/${owner}/${name}/issues/new`)}
          className="flex items-center gap-1 font-display text-2xs text-fg-subtle transition-colors hover:text-fg-muted focus-visible:outline-none focus-visible:shadow-focus"
        >
          <ExternalLink size={10} strokeWidth={2} />
          Open on github.com
        </button>
      </div>
    </div>
  );
}
