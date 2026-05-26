import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ExternalLink,
  FileDiff,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  KeyRound,
  Plus,
  RefreshCw,
  Search,
  X,
  XCircle,
} from 'lucide-react';
import {
  gitBranches,
  gitHostDetect,
  gitHostPrCreate,
  gitHostPrGet,
  gitHostPrList,
  gitHostTokenGet,
  gitHostTokenSet,
  isTauri,
  type GitBranchInfo,
  type GitHostPrDetail,
  type GitHostPrListFilter,
  type GitHostPrState,
  type GitHostPrSummary,
  type GitHostRepoSlug,
} from '../../lib/tauri';
import { useFiles } from '../../state/files';
import { useGitUi } from '../../state/gitUi';
import { cn } from '../../lib/cn';

/**
 * GitHub PR panel — list, detail, create. V1 scope: read + create only.
 * Review threads, comments, and merge are deferred to a follow-up.
 *
 * Auth: PAT stored in OS keychain under `dev.arc.terminal.git-host`. If the
 * token is missing, the panel shows a one-time token-entry pane.
 */
export function PrPanel() {
  const view = useGitUi((s) => s.prPanelView);
  const close = useGitUi((s) => s.closePrPanel);
  const openList = useGitUi((s) => s.openPrList);
  const openDetail = useGitUi((s) => s.openPrDetail);
  const openCreate = useGitUi((s) => s.openPrCreate);
  const root = useFiles((s) => s.root);

  const [slug, setSlug] = useState<GitHostRepoSlug | null>(null);
  const [hasToken, setHasToken] = useState<boolean | null>(null);

  // Esc closes (only from the list view; the detail view shows a back arrow).
  useEffect(() => {
    if (view.kind === 'closed') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, close]);

  // Detect repo slug + token state when the panel opens.
  useEffect(() => {
    if (view.kind === 'closed' || !root || !isTauri) return;
    void gitHostDetect(root)
      .then(setSlug)
      .catch(() => setSlug(null));
    void gitHostTokenGet('github')
      .then((t) => setHasToken(!!t && t.length > 0))
      .catch(() => setHasToken(false));
  }, [view.kind, root]);

  if (view.kind === 'closed') return null;

  const isGitHubRepo = slug !== null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm"
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="material-sheet mt-[6vh] flex h-[80vh] w-[860px] max-w-[96vw] animate-sheet-in flex-col overflow-hidden rounded-window shadow-sheet ring-1 ring-white/10"
      >
        <Header
          slug={slug}
          view={view}
          onBack={view.kind === 'detail' ? openList : null}
          onCreate={view.kind === 'list' && isGitHubRepo && hasToken === true ? openCreate : null}
          onClose={close}
        />

        {!root && (
          <EmptyMessage>open a repository first</EmptyMessage>
        )}

        {root && !isGitHubRepo && (
          <EmptyMessage>
            no <span className="font-mono">origin</span> remote pointing at github.com on this repo.
          </EmptyMessage>
        )}

        {root && isGitHubRepo && hasToken === false && (
          <TokenPane
            onSaved={() => setHasToken(true)}
          />
        )}

        {root && isGitHubRepo && hasToken === true && view.kind === 'list' && (
          <ListView root={root} onPick={openDetail} />
        )}

        {root && isGitHubRepo && hasToken === true && view.kind === 'detail' && (
          <DetailView root={root} number={view.number} />
        )}

        {root && isGitHubRepo && hasToken === true && view.kind === 'create' && (
          <CreateView
            root={root}
            onCreated={(pr) => openDetail(pr.number)}
            onCancel={openList}
          />
        )}
      </div>
    </div>
  );
}

function Header({
  slug,
  view,
  onBack,
  onCreate,
  onClose,
}: {
  slug: GitHostRepoSlug | null;
  view: { kind: string };
  onBack: (() => void) | null;
  onCreate: (() => void) | null;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border-hairline px-4 py-2.5">
      <div className="flex items-center gap-2 font-display text-[12.5px] font-semibold tracking-tight text-fg-base">
        {onBack && (
          <button
            onClick={onBack}
            className="rounded p-1 text-fg-muted transition-colors hover:bg-white/[0.06] hover:text-fg-base"
            title="Back to list"
          >
            <ArrowLeft size={12} strokeWidth={2.2} />
          </button>
        )}
        <GitPullRequest size={12} strokeWidth={2.1} className="text-fg-muted" />
        {view.kind === 'create' ? 'New Pull Request' : 'Pull Requests'}
        {slug && (
          <span className="font-mono text-[10px] font-normal text-fg-subtle">
            · {slug.owner}/{slug.name}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        {onCreate && (
          <button
            onClick={onCreate}
            className="flex items-center gap-1 rounded bg-accent-soft px-2 py-0.5 font-display text-[10.5px] font-medium text-fg-base ring-1 ring-accent/45 hover:bg-accent/20"
          >
            <Plus size={10} strokeWidth={2.4} />
            new PR
          </button>
        )}
        <button
          onClick={onClose}
          title="Close (esc)"
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-white/[0.06] hover:text-fg-base"
        >
          <X size={11} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  );
}

function EmptyMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-10 text-center font-display text-[11.5px] italic text-fg-subtle">
      {children}
    </div>
  );
}

function TokenPane({ onSaved }: { onSaved: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!token.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await gitHostTokenSet('github', token.trim());
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 py-10">
      <KeyRound size={20} strokeWidth={1.8} className="text-fg-muted" />
      <div className="text-center font-display text-[12.5px] text-fg-base">
        Add a GitHub personal access token
      </div>
      <div className="max-w-md text-center font-display text-[11px] leading-relaxed text-fg-muted">
        Create one at{' '}
        <span className="font-mono">github.com/settings/tokens</span> with the{' '}
        <span className="font-mono">repo</span> scope (classic) or read+write access to pull
        requests (fine-grained). The token is stored in your OS keychain.
      </div>
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="ghp_..."
        className="w-[420px] max-w-full rounded border border-border-subtle bg-bg-base/60 px-3 py-1.5 font-mono text-[12px] text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:outline-none"
        autoFocus
        spellCheck={false}
      />
      {err && <div className="font-mono text-[10.5px] text-red-300">{err}</div>}
      <button
        onClick={() => void save()}
        disabled={!token.trim() || busy}
        className="rounded bg-accent-soft px-4 py-1.5 font-display text-[11.5px] font-medium text-fg-base ring-1 ring-accent/45 hover:bg-accent/20 disabled:opacity-50"
      >
        {busy ? 'saving…' : 'save token'}
      </button>
    </div>
  );
}

function ListView({ root, onPick }: { root: string; onPick: (n: number) => void }) {
  const [filter, setFilter] = useState<GitHostPrListFilter>('open');
  const [prs, setPrs] = useState<GitHostPrSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const list = await gitHostPrList(root, filter);
      setPrs(list);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, filter]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return prs;
    return prs.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.author.toLowerCase().includes(q) ||
        String(p.number).includes(q),
    );
  }, [prs, search]);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border-hairline px-4 py-2">
        <FilterToggle value={filter} onChange={setFilter} />
        <div className="flex flex-1 items-center gap-1.5 rounded bg-bg-base/40 px-2 py-1 ring-1 ring-border-subtle">
          <Search size={10} strokeWidth={2.1} className="text-fg-subtle" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="filter by title / author / #number"
            className="flex-1 bg-transparent font-display text-[11.5px] text-fg-base placeholder:text-fg-subtle focus:outline-none"
            spellCheck={false}
          />
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-white/[0.06] hover:text-fg-base disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw size={11} strokeWidth={2.1} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {err && (
        <div className="border-b border-border-hairline bg-red-500/[0.06] px-4 py-2 font-mono text-[11px] text-red-300">
          {err}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading && visible.length === 0 && (
          <div className="px-4 py-10 text-center font-display text-[11.5px] italic text-fg-subtle">
            loading PRs…
          </div>
        )}
        {!loading && visible.length === 0 && (
          <div className="px-4 py-10 text-center font-display text-[11.5px] italic text-fg-subtle">
            no PRs match
          </div>
        )}
        {visible.map((pr) => (
          <PrRow key={pr.number} pr={pr} onClick={() => onPick(pr.number)} />
        ))}
      </div>
    </>
  );
}

function FilterToggle({
  value,
  onChange,
}: {
  value: GitHostPrListFilter;
  onChange: (v: GitHostPrListFilter) => void;
}) {
  const options: { id: GitHostPrListFilter; label: string }[] = [
    { id: 'open', label: 'open' },
    { id: 'closed', label: 'closed' },
    { id: 'all', label: 'all' },
  ];
  return (
    <div className="flex shrink-0 gap-0.5 rounded bg-bg-base/40 p-0.5 ring-1 ring-border-subtle">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            'rounded px-2 py-0.5 font-display text-[10.5px] font-medium tracking-tight transition-colors',
            value === o.id
              ? 'bg-accent-soft text-fg-base ring-1 ring-accent/45'
              : 'text-fg-subtle hover:bg-white/[0.05] hover:text-fg-base',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function PrRow({ pr, onClick }: { pr: GitHostPrSummary; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-start gap-3 border-b border-border-hairline/60 px-4 py-2 text-left transition-colors last:border-b-0 hover:bg-white/[0.04]"
    >
      <StateIcon state={pr.state} draft={pr.draft} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-display text-[12.5px] font-medium tracking-tight text-fg-base">
            {pr.title}
          </span>
          <span className="font-mono text-[10.5px] text-fg-subtle">#{pr.number}</span>
        </div>
        <div className="mt-0.5 truncate font-display text-[10.5px] text-fg-subtle">
          {pr.head} → {pr.base} · by {pr.author} · {formatRelative(pr.updated_at)}
        </div>
      </div>
    </button>
  );
}

function StateIcon({ state, draft }: { state: GitHostPrState; draft: boolean }) {
  if (state === 'merged') return <GitMerge size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-purple-400" />;
  if (state === 'closed') return <XCircle size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-red-400" />;
  if (draft)
    return <GitPullRequestDraft size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-fg-muted" />;
  return <GitPullRequest size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-green-400" />;
}

function DetailView({ root, number }: { root: string; number: number }) {
  const [pr, setPr] = useState<GitHostPrDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void gitHostPrGet(root, number)
      .then((d) => {
        if (!cancelled) setPr(d);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root, number]);

  if (loading) {
    return <EmptyMessage>loading PR #{number}…</EmptyMessage>;
  }
  if (err) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="max-w-md font-mono text-[11px] text-red-300">{err}</div>
      </div>
    );
  }
  if (!pr) return null;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-border-hairline px-4 py-3">
        <div className="flex items-start gap-3">
          <StateIcon state={pr.state} draft={pr.draft} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="font-display text-[14px] font-semibold text-fg-base">
                {pr.title}
              </span>
              <span className="font-mono text-[11px] text-fg-subtle">#{pr.number}</span>
            </div>
            <div className="mt-0.5 font-display text-[11px] text-fg-muted">
              <span className="font-mono">{pr.head}</span> →{' '}
              <span className="font-mono">{pr.base}</span> · by {pr.author}
            </div>
          </div>
          <a
            href={pr.html_url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 rounded border border-border-subtle px-2 py-1 font-display text-[10.5px] text-fg-muted hover:border-border-strong hover:text-fg-base"
          >
            <ExternalLink size={10} strokeWidth={2.1} />
            github
          </a>
        </div>
        {pr.body && (
          <pre className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-black/20 p-2 font-display text-[11px] leading-relaxed text-fg-base/90">
            {pr.body}
          </pre>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-[300px] shrink-0 flex-col border-r border-border-hairline">
          <SectionLabel>commits ({pr.commits.length})</SectionLabel>
          <div className="flex-1 overflow-y-auto">
            {pr.commits.map((c) => (
              <div
                key={c.oid}
                className="border-b border-border-hairline/60 px-3 py-1.5 last:border-b-0"
              >
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[10.5px] text-fg-subtle">{c.short}</span>
                  <span className="truncate font-display text-[11.5px] text-fg-base/90">
                    {firstLine(c.message)}
                  </span>
                </div>
                <div className="mt-0.5 truncate font-display text-[10px] text-fg-subtle">
                  {c.author}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <SectionLabel>files ({pr.files.length})</SectionLabel>
          <div className="flex-1 overflow-y-auto">
            {pr.files.map((f) => (
              <FileRow key={f.path} file={f} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function FileRow({ file }: { file: { path: string; status: string; additions: number; deletions: number; patch: string | null } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border-hairline/60 last:border-b-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
      >
        <FileDiff size={10} strokeWidth={2.1} className="shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-base/90">
          {file.path}
        </span>
        <span className="shrink-0 font-display text-[10px] text-fg-subtle">{file.status}</span>
        {file.additions > 0 && (
          <span className="font-mono text-[10px] text-green-400">+{file.additions}</span>
        )}
        {file.deletions > 0 && (
          <span className="font-mono text-[10px] text-red-400">−{file.deletions}</span>
        )}
      </button>
      {open && file.patch && (
        <pre className="max-h-64 overflow-auto whitespace-pre bg-black/30 px-3 py-2 font-mono text-[10.5px] leading-snug">
          {file.patch.split('\n').map((line, i) => (
            <div
              key={i}
              className={cn(
                line.startsWith('+') && !line.startsWith('+++') && 'text-green-400',
                line.startsWith('-') && !line.startsWith('---') && 'text-red-400',
                line.startsWith('@@') && 'text-fg-muted',
                !line.startsWith('+') && !line.startsWith('-') && !line.startsWith('@@') && 'text-fg-base/80',
              )}
            >
              {line || ' '}
            </div>
          ))}
        </pre>
      )}
      {open && !file.patch && (
        <div className="px-3 py-2 font-display text-[10.5px] italic text-fg-subtle">
          binary or oversized — patch omitted by GitHub
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b border-border-hairline bg-bg-base/30 px-3 py-1.5 font-display text-[10px] uppercase tracking-wider text-fg-subtle">
      {children}
    </div>
  );
}

function CreateView({
  root,
  onCreated,
  onCancel,
}: {
  root: string;
  onCreated: (pr: GitHostPrSummary) => void;
  onCancel: () => void;
}) {
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [head, setHead] = useState('');
  const [base, setBase] = useState('main');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submitOnce = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void gitBranches(root)
      .then((list) => {
        if (cancelled) return;
        setBranches(list);
        const current = list.find((b) => b.current);
        if (current) setHead(current.name);
        // Default base: a `main` or `master` if it exists, else upstream
        // of the current branch's upstream.
        const main = list.find((b) => b.name === 'main' || b.name === 'master');
        if (main) setBase(main.name);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [root]);

  const submit = async () => {
    if (submitOnce.current) return;
    submitOnce.current = true;
    setBusy(true);
    setErr(null);
    try {
      const pr = await gitHostPrCreate(root, {
        title: title.trim(),
        body,
        head,
        base,
        draft,
      });
      onCreated(pr);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      submitOnce.current = false;
    } finally {
      setBusy(false);
    }
  };

  const localBranches = branches.filter((b) => !b.remote);

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
      <div className="grid grid-cols-2 gap-3">
        <BranchPicker label="From (head)" value={head} options={localBranches} onChange={setHead} />
        <BranchPicker label="Into (base)" value={base} options={localBranches} onChange={setBase} />
      </div>

      <label className="flex flex-col gap-1">
        <span className="font-display text-[10.5px] uppercase tracking-wider text-fg-subtle">
          title
        </span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What does this PR do?"
          className="rounded border border-border-subtle bg-bg-base/60 px-2.5 py-1.5 font-display text-[12px] text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:outline-none"
          spellCheck={false}
        />
      </label>

      <label className="flex flex-1 flex-col gap-1">
        <span className="font-display text-[10.5px] uppercase tracking-wider text-fg-subtle">
          description
        </span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Markdown body. Bullet the highlights, link issues with #123."
          rows={10}
          className="min-h-[160px] flex-1 rounded border border-border-subtle bg-bg-base/60 px-2.5 py-1.5 font-display text-[12px] text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:outline-none"
          spellCheck
        />
      </label>

      <label className="flex items-center gap-1.5 font-display text-[11px] text-fg-muted">
        <input
          type="checkbox"
          checked={draft}
          onChange={(e) => setDraft(e.target.checked)}
          className="accent-accent"
        />
        Mark as draft
      </label>

      {err && (
        <div className="rounded bg-red-500/[0.08] px-3 py-2 font-mono text-[11px] text-red-300 ring-1 ring-red-500/20">
          {err}
        </div>
      )}

      <div className="flex justify-end gap-2 border-t border-border-hairline pt-3">
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded px-2.5 py-1 font-display text-[11px] text-fg-muted hover:bg-white/[0.05] hover:text-fg-base disabled:opacity-50"
        >
          cancel
        </button>
        <button
          onClick={() => void submit()}
          disabled={busy || !title.trim() || !head || !base || head === base}
          className="rounded bg-accent-soft px-3 py-1 font-display text-[11px] font-medium text-fg-base ring-1 ring-accent/45 hover:bg-accent/20 disabled:opacity-50"
        >
          {busy ? 'creating…' : draft ? 'create draft' : 'create PR'}
        </button>
      </div>
    </div>
  );
}

function BranchPicker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: GitBranchInfo[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-display text-[10.5px] uppercase tracking-wider text-fg-subtle">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none rounded border border-border-subtle bg-bg-base/60 px-2.5 py-1.5 font-mono text-[11.5px] text-fg-base focus:border-accent/45 focus:outline-none"
      >
        {!options.find((b) => b.name === value) && <option value={value}>{value}</option>}
        {options.map((b) => (
          <option key={b.name} value={b.name}>
            {b.name}
            {b.current ? ' (current)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i < 0 ? s : s.slice(0, i);
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Math.max(0, (Date.now() - t) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 30 * 86_400) return `${Math.floor(diff / 86_400)}d ago`;
  return new Date(t).toLocaleDateString();
}

