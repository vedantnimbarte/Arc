import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Copy,
  ExternalLink,
  GitBranch,
  GitMerge,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Scissors,
  Tag,
  Undo2,
} from 'lucide-react';
import {
  GIT_EMPTY_TREE,
  gitBranchCreate,
  gitCheckout,
  gitCherryPick,
  gitCommitFiles,
  gitCommitMessage,
  gitLog,
  gitRemotes,
  gitReset,
  gitRevert,
  gitTagCreate,
  isTauri,
  shellOpenExternal,
  type GitCommitFile,
  type GitLogEntry,
  type GitResetMode,
} from '../../lib/tauri';
import { commitWebUrl } from '../../lib/gitWebUrl';
import { copyText } from '../../lib/clipboard';
import { askConfirm, askText } from '../../state/confirm';
import { toast, toastError } from '../../state/toast';
import { useGit } from '../../state/git';
import { useGitUi } from '../../state/gitUi';
import { useWorkspace } from '../../state/workspace';
import { colorForAuthor } from './AuthorsSidebar';
import { formatRelative } from './CommitList';
import { cn } from '../../lib/cn';

/** Commits per request. A sidebar shows ~15 at a time, so a page this size
 *  covers several screens of scrolling without a second round trip. */
const PAGE = 100;
/** Distance from the bottom at which the next page starts loading. */
const PREFETCH_PX = 240;

interface Props {
  root: string;
  /** Put the panel into amend mode on the Changes tab — offered on HEAD only,
   *  since that's the only commit `git commit --amend` can rewrite. */
  onAmend: () => void;
}

/**
 * Current-branch commit history for the Source Control panel, the History
 * half of its Changes/History switch.
 *
 * `git log` with no revision argument already means "HEAD", so this is the
 * checked-out branch and nothing else — matching what GitHub Desktop shows.
 * Merges are kept (the wide Git window hides them by default) because a
 * branch's history reads wrong without the merges that shaped it.
 */
export function CommitHistory({ root, onAmend }: Props) {
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ commit: GitLogEntry; isHead: boolean; x: number; y: number } | null>(
    null,
  );

  // Bumped to force a reload after an action rewrote history.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => {
    setReloadKey((k) => k + 1);
    void useGit.getState().refresh(root);
  }, [root]);

  // Page loader. `skip` is the cursor; a short page means the branch ended.
  // A ref guards against the scroll handler firing again mid-request.
  const inFlight = useRef(false);
  const loadPage = useCallback(
    async (skip: number) => {
      if (!isTauri || inFlight.current) return;
      inFlight.current = true;
      setLoading(true);
      setError(null);
      try {
        const rows = await gitLog(root, PAGE, { includeMerges: true, skip });
        setCommits((prev) => (skip === 0 ? rows : [...prev, ...rows]));
        setDone(rows.length < PAGE);
      } catch (e) {
        setError(String(e));
        setDone(true);
      } finally {
        inFlight.current = false;
        setLoading(false);
      }
    },
    [root],
  );

  // First page, and again whenever the repo or history changes underneath us.
  useEffect(() => {
    setCommits([]);
    setDone(false);
    setSelected(null);
    void loadPage(0);
  }, [loadPage, reloadKey]);

  const onScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (done || loading) return;
      const el = e.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < PREFETCH_PX) {
        void loadPage(commits.length);
      }
    },
    [commits.length, done, loading, loadPage],
  );

  // ── Actions ───────────────────────────────────────────────────────────────
  // Each one reports through a toast and reloads, so the list and the Changes
  // tab never disagree about where HEAD is.

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        toast(label);
        reload();
      } catch (e) {
        toastError(String(e));
      }
    },
    [reload],
  );

  const onCheckout = useCallback(
    async (c: GitLogEntry) => {
      const ok = await askConfirm({
        title: `Check out ${c.short}?`,
        body: 'HEAD detaches from the branch. Commits made here belong to no branch until you make one.',
        confirmLabel: 'check out',
      });
      if (!ok) return;
      await run(`Checked out ${c.short}`, () => gitCheckout(root, c.oid));
    },
    [root, run],
  );

  const onBranchFrom = useCallback(
    async (c: GitLogEntry) => {
      const name = await askText(
        `New branch from ${c.short}`,
        { label: 'Branch name', placeholder: 'feature/my-work' },
        'create',
      );
      if (!name?.trim()) return;
      await run(`Created ${name.trim()}`, () => gitBranchCreate(root, name.trim(), true, c.oid));
    },
    [root, run],
  );

  const onReset = useCallback(
    async (c: GitLogEntry, mode: GitResetMode) => {
      if (
        mode === 'hard' &&
        !(await askConfirm({
          title: `Hard reset to ${c.short}?`,
          body: 'Every uncommitted change in the working tree is discarded.',
          confirmLabel: 'reset',
          destructive: true,
        }))
      )
        return;
      await run(`Reset (${mode}) to ${c.short}`, () => gitReset(root, c.oid, mode));
    },
    [root, run],
  );

  const onTag = useCallback(
    async (c: GitLogEntry) => {
      const name = await askText(
        `Tag ${c.short}`,
        { label: 'Tag name', placeholder: 'v1.2.0' },
        'create',
      );
      if (!name?.trim()) return;
      await run(`Tagged ${c.short}`, () => gitTagCreate(root, name.trim(), null, c.oid));
    },
    [root, run],
  );

  const onCopyMessage = useCallback(
    async (c: GitLogEntry) => {
      try {
        copyText(await gitCommitMessage(root, c.oid), 'Commit message');
      } catch {
        // Falling back to the subject beats copying nothing — it's the part
        // of the message the row already showed them.
        copyText(c.subject, 'Commit message');
      }
    },
    [root],
  );

  const onOpenOnHost = useCallback(
    async (c: GitLogEntry) => {
      try {
        const remotes = await gitRemotes(root);
        const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0];
        const url = origin && commitWebUrl(origin.fetch_url, c.oid);
        if (!url) {
          toastError('No web remote to open this commit on.');
          return;
        }
        await shellOpenExternal(url);
      } catch (e) {
        toastError(String(e));
      }
    },
    [root],
  );

  if (!isTauri) {
    return <Hint>Commit history needs the desktop app.</Hint>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="selectable min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5" onScroll={onScroll}>
        {error && (
          <p className="mx-1 mb-1.5 rounded-lg border border-status-err/25 bg-status-err/[0.07] px-2.5 py-2 font-display text-2xs leading-relaxed text-status-err/90">
            {error}
          </p>
        )}

        {commits.length === 0 && !loading && !error && (
          <Hint>No commits on this branch yet.</Hint>
        )}

        <ul className="flex flex-col gap-px">
          {commits.map((c, i) => (
            <CommitRow
              key={c.oid}
              commit={c}
              root={root}
              expanded={selected === c.oid}
              onToggle={() => setSelected((cur) => (cur === c.oid ? null : c.oid))}
              onMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenu({ commit: c, isHead: i === 0, x: e.clientX, y: e.clientY });
              }}
            />
          ))}
        </ul>

        {loading && (
          <p className="px-2.5 py-2 font-display text-2xs text-fg-subtle">Loading…</p>
        )}
        {done && commits.length > 0 && (
          <p className="px-2.5 py-2 font-display text-2xs text-fg-subtle/70">
            {commits.length} commit{commits.length === 1 ? '' : 's'} · start of branch
          </p>
        )}
      </div>

      {menu && (
        <CommitMenu
          commit={menu.commit}
          isHead={menu.isHead}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onCheckout={() => void onCheckout(menu.commit)}
          onBranchFrom={() => void onBranchFrom(menu.commit)}
          onCherryPick={() =>
            void run(`Cherry-picked ${menu.commit.short}`, () => gitCherryPick(root, menu.commit.oid))
          }
          onCherryPickTo={() =>
            useGitUi.getState().openCherryPick({
              oid: menu.commit.oid,
              shortOid: menu.commit.short,
              subject: menu.commit.subject,
            })
          }
          onRevert={() =>
            void run(`Reverted ${menu.commit.short}`, () => gitRevert(root, menu.commit.oid))
          }
          onReset={(mode) => void onReset(menu.commit, mode)}
          onTag={() => void onTag(menu.commit)}
          onAmend={onAmend}
          onCopySha={() => copyText(menu.commit.oid, 'Commit SHA')}
          onCopyMessage={() => void onCopyMessage(menu.commit)}
          onOpenOnHost={() => void onOpenOnHost(menu.commit)}
        />
      )}
    </div>
  );
}

// ── Rows ────────────────────────────────────────────────────────────────────

function CommitRow({
  commit,
  root,
  expanded,
  onToggle,
  onMenu,
}: {
  commit: GitLogEntry;
  root: string;
  expanded: boolean;
  onToggle: () => void;
  onMenu: (e: ReactMouseEvent) => void;
}) {
  const dot = colorForAuthor(commit.author, commit.email);
  const isMerge = commit.parents.length > 1;

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        onContextMenu={onMenu}
        title={commit.subject}
        className={cn(
          'group flex w-full cursor-default items-start gap-2 rounded-lg px-2 py-1.5 text-left',
          'transition-colors duration-150',
          expanded ? 'bg-surface-1 ring-1 ring-inset ring-edge-1' : 'hover:bg-surface-1',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
        )}
      >
        <span
          aria-hidden
          className="mt-[5px] h-2 w-2 shrink-0 rounded-full ring-1 ring-black/50"
          style={{ background: dot }}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate font-display text-xs text-fg-base">
              {commit.subject || <span className="italic text-fg-subtle">(no subject)</span>}
            </span>
            {isMerge && (
              <GitMerge size={10} strokeWidth={2.2} className="shrink-0 text-fg-subtle" />
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 font-mono text-2xs text-fg-subtle">
            <span className="min-w-0 truncate" title={commit.email}>
              {commit.author}
            </span>
            <span aria-hidden>·</span>
            <span className="shrink-0 tabular-nums">{formatRelative(commit.time)}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{commit.short}</span>
            <Stat additions={commit.additions} deletions={commit.deletions} />
          </span>
        </span>
        <button
          type="button"
          onClick={onMenu}
          aria-label={`Actions for ${commit.short}`}
          title="Commit actions"
          className={cn(
            'mt-px shrink-0 rounded p-0.5 text-fg-subtle opacity-0 transition',
            'hover:bg-surface-2 hover:text-fg-base group-hover:opacity-100',
            'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
          )}
        >
          <MoreHorizontal size={12} strokeWidth={2} />
        </button>
      </div>

      {expanded && <CommitFiles commit={commit} root={root} />}
    </li>
  );
}

/** Files the commit touched. Loaded on expand — 100 rows of file lists up
 *  front would be 100 `git show` calls for lists nobody opened. */
function CommitFiles({ commit, root }: { commit: GitLogEntry; root: string }) {
  const [files, setFiles] = useState<GitCommitFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openCommitDiff = useWorkspace((s) => s.openCommitDiff);

  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setError(null);
    gitCommitFiles(root, commit.oid)
      .then((rows) => !cancelled && setFiles(rows))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [commit.oid, root]);

  if (error) {
    return <p className="px-4 py-1 font-display text-2xs text-status-err/90">{error}</p>;
  }
  if (!files) {
    return <p className="px-4 py-1 font-display text-2xs text-fg-subtle">Loading files…</p>;
  }
  if (files.length === 0) {
    return <p className="px-4 py-1 font-display text-2xs text-fg-subtle">No file changes.</p>;
  }

  // The root commit has no parent to diff against; the empty tree stands in.
  const parent = commit.parents[0] ?? GIT_EMPTY_TREE;

  return (
    <ul className="mb-1 ml-3.5 flex flex-col gap-px border-l border-border-hairline pl-1.5">
      {files.map((f) => (
        <li key={f.path}>
          <button
            type="button"
            onClick={() =>
              openCommitDiff(joinPath(root, f.path), root, {
                oid: commit.oid,
                short: commit.short,
                parent,
              })
            }
            title={`${f.path} — open this commit's changes`}
            className={cn(
              'flex w-full items-center gap-1.5 rounded px-1.5 py-[3px] text-left',
              'transition-colors hover:bg-surface-2',
            )}
          >
            <span
              className={cn('w-2.5 shrink-0 text-center font-mono text-2xs', statusColor(f.status))}
            >
              {f.status}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-muted">
              {basename(f.path)}
            </span>
            {f.binary ? (
              <span className="shrink-0 font-mono text-2xs text-fg-subtle">bin</span>
            ) : (
              <Stat additions={f.additions} deletions={f.deletions} />
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function Stat({ additions, deletions }: { additions: number; deletions: number }) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-2xs tabular-nums">
      {additions > 0 && <span className="text-[#3ad28a]">+{additions}</span>}
      {deletions > 0 && <span className="text-[#ff5252]">−{deletions}</span>}
    </span>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-2 font-display text-2xs leading-relaxed text-fg-subtle">{children}</p>;
}

// ── Menu ────────────────────────────────────────────────────────────────────

function CommitMenu({
  commit,
  isHead,
  x,
  y,
  onClose,
  onCheckout,
  onBranchFrom,
  onCherryPick,
  onCherryPickTo,
  onRevert,
  onReset,
  onTag,
  onAmend,
  onCopySha,
  onCopyMessage,
  onOpenOnHost,
}: {
  commit: GitLogEntry;
  isHead: boolean;
  x: number;
  y: number;
  onClose: () => void;
  onCheckout: () => void;
  onBranchFrom: () => void;
  onCherryPick: () => void;
  onCherryPickTo: () => void;
  onRevert: () => void;
  onReset: (mode: GitResetMode) => void;
  onTag: () => void;
  onAmend: () => void;
  onCopySha: () => void;
  onCopyMessage: () => void;
  onOpenOnHost: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Keep the menu on screen — it opens at the pointer, which near the bottom
  // of a sidebar is exactly where a tall menu would run off.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: x + width > window.innerWidth ? Math.max(0, window.innerWidth - width - 8) : x,
      y: y + height > window.innerHeight ? Math.max(0, window.innerHeight - height - 8) : y,
    });
  }, [x, y]);

  useEffect(() => {
    const onMouse = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onMouse, { capture: true });
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouse, { capture: true });
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const item = (icon: React.ReactNode, label: string, action: () => void, danger = false) => (
    <button
      key={label}
      onClick={() => {
        action();
        onClose();
      }}
      className={cn(
        'group/item flex w-full items-center gap-2.5 rounded-md px-2.5 py-[6px]',
        'font-display text-sm tracking-tight transition-colors duration-100',
        danger
          ? 'text-status-err/85 hover:bg-status-err/[0.10] hover:text-status-err'
          : 'text-fg-base/85 hover:bg-surface-2 hover:text-fg-base',
      )}
    >
      <span
        className={cn(
          'flex h-3.5 w-3.5 shrink-0 items-center justify-center',
          danger ? 'text-status-err/70' : 'text-fg-subtle group-hover/item:text-fg-base/85',
        )}
      >
        {icon}
      </span>
      <span className="flex-1 text-left">{label}</span>
    </button>
  );

  const sep = (
    <div
      aria-hidden
      className="my-1 h-px bg-gradient-to-r from-transparent via-white/[0.07] to-transparent"
    />
  );

  return createPortal(
    <div
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      className={cn(
        'fixed z-[9999] min-w-[228px] rounded-xl p-1.5',
        'border border-border-strong bg-bg-panel/95 backdrop-blur-thick backdrop-saturate-180',
        'shadow-sheet animate-fade-in',
      )}
      role="menu"
      aria-label={`Actions for commit ${commit.short}`}
    >
      <div className="mx-1 mb-1 mt-0.5 truncate font-mono text-2xs tracking-wide text-fg-subtle/80">
        {commit.short} · {commit.subject || 'no subject'}
      </div>
      {item(<GitBranch size={12} strokeWidth={2} />, 'Check Out Commit', onCheckout)}
      {item(<GitBranch size={12} strokeWidth={2} />, 'New Branch from Commit…', onBranchFrom)}
      {sep}
      {item(<Scissors size={12} strokeWidth={2} />, 'Cherry-pick onto HEAD', onCherryPick)}
      {item(<Scissors size={12} strokeWidth={2} />, 'Cherry-pick to Branch…', onCherryPickTo)}
      {item(<Undo2 size={12} strokeWidth={2} />, 'Revert Commit', onRevert)}
      {/* Amend rewrites the commit in place, so it only exists for HEAD. */}
      {isHead && item(<Pencil size={12} strokeWidth={2} />, 'Amend Last Commit', onAmend)}
      {sep}
      {item(<RotateCcw size={12} strokeWidth={2} />, 'Reset — keep staged (soft)', () =>
        onReset('soft'),
      )}
      {item(<RotateCcw size={12} strokeWidth={2} />, 'Reset — keep files (mixed)', () =>
        onReset('mixed'),
      )}
      {item(
        <RotateCcw size={12} strokeWidth={2} />,
        'Reset — discard all (hard)',
        () => onReset('hard'),
        true,
      )}
      {sep}
      {item(<Tag size={12} strokeWidth={2} />, 'Tag Commit…', onTag)}
      {item(<Copy size={12} strokeWidth={2} />, 'Copy SHA', onCopySha)}
      {item(<Copy size={12} strokeWidth={2} />, 'Copy Message', onCopyMessage)}
      {item(<ExternalLink size={12} strokeWidth={2} />, 'Open on Remote', onOpenOnHost)}
    </div>,
    document.body,
  );
}

// ── Path helpers ────────────────────────────────────────────────────────────

function basename(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] ?? p;
}

/** Same rule as the Changes list: the separator follows the root's style. */
function joinPath(root: string, rel: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${rel.replace(/[\\/]+/g, sep)}`;
}

/** Porcelain status letter → the colour the file tree uses for that state. */
function statusColor(status: string): string {
  switch (status) {
    case 'A':
      return 'text-[#3ad28a]';
    case 'D':
      return 'text-[#ff5252]';
    case 'R':
    case 'C':
      return 'text-accent';
    default:
      return 'text-fg-subtle';
  }
}
