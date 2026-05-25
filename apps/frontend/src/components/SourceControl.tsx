import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronRight,
  Copy,
  FileText,
  Files,
  GitBranch,
  GitCompare,
  Minus,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  fsReadFile,
  gitCommit,
  gitDiff,
  gitDiscard,
  gitStage,
  gitUnstage,
  isTauri,
  type GitChangeEntry,
  type GitDiffScope,
} from '../lib/tauri';
import { useFiles } from '../state/files';
import { useGit } from '../state/git';
import { useWorkspace } from '../state/workspace';
import { fileIcon } from '../lib/fileIcons';
import { cn } from '../lib/cn';

/** Path separator that matches the workspace root style. */
function joinPath(root: string, rel: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  const trimmedRoot = root.replace(/[\\/]+$/, '');
  const native = rel.replace(/[\\/]+/g, sep);
  return `${trimmedRoot}${sep}${native}`;
}

function basename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

function dirname(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx > 0 ? cleaned.slice(0, idx) : '';
}

type Section = 'staged' | 'changes' | 'untracked' | 'conflict';

function sectionFor(entry: GitChangeEntry): Section {
  switch (entry.kind) {
    case 'staged':
      return 'staged';
    case 'both':
    case 'unstaged':
      return 'changes';
    case 'untracked':
      return 'untracked';
    case 'conflict':
      return 'conflict';
  }
}

const SECTION_LABEL: Record<Section, string> = {
  staged: 'Staged Changes',
  changes: 'Changes',
  untracked: 'Untracked',
  conflict: 'Merge Conflicts',
};

const SECTION_ORDER: Section[] = ['conflict', 'staged', 'changes', 'untracked'];

/**
 * A small (16×16) tinted pill tone for the status letter. Returns Tailwind
 * classes for bg + text + ring so the chip reads as a single semantic unit
 * (think: tape label on a workshop drawer).
 */
function statusChipTone(letter: string): {
  bg: string;
  text: string;
  ring: string;
} {
  switch (letter.toUpperCase()) {
    case 'M':
      return {
        bg: 'bg-status-warn/15',
        text: 'text-status-warn',
        ring: 'ring-status-warn/25',
      };
    case 'A':
      return {
        bg: 'bg-status-ok/15',
        text: 'text-status-ok',
        ring: 'ring-status-ok/25',
      };
    case 'D':
      return {
        bg: 'bg-status-err/15',
        text: 'text-status-err',
        ring: 'ring-status-err/25',
      };
    case 'R':
    case 'C':
      return {
        bg: 'bg-accent-soft',
        text: 'text-accent-bright',
        ring: 'ring-accent/25',
      };
    case 'U':
      return {
        bg: 'bg-status-err/18',
        text: 'text-status-err',
        ring: 'ring-status-err/30',
      };
    case '?':
      return {
        bg: 'bg-white/[0.05]',
        text: 'text-fg-muted',
        ring: 'ring-white/[0.07]',
      };
    default:
      return {
        bg: 'bg-white/[0.05]',
        text: 'text-fg-muted',
        ring: 'ring-white/[0.07]',
      };
  }
}

/**
 * Section "character" — a soft dot + label tone applied to each group header.
 * Kept deliberately quiet so the colors function as wayfinding, not chrome.
 */
function sectionAccent(section: Section): {
  dot: string;
  pulse: boolean;
  label: string;
} {
  switch (section) {
    case 'conflict':
      return { dot: 'bg-status-err', pulse: true, label: 'text-status-err/85' };
    case 'staged':
      return { dot: 'bg-status-ok', pulse: false, label: 'text-fg-base/80' };
    case 'changes':
      return { dot: 'bg-status-warn', pulse: false, label: 'text-fg-base/80' };
    case 'untracked':
      return { dot: 'bg-fg-muted/60', pulse: false, label: 'text-fg-muted' };
  }
}

/** Quick +/- counter used in the diff modal footer. */
function diffStats(text: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

/** Split a repo-relative path into its breadcrumb segments. */
function pathSegments(p: string): string[] {
  return p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]+/)
    .filter(Boolean);
}

export function SourceControl() {
  const root = useFiles((s) => s.root);
  const setSidebarView = useFiles((s) => s.setSidebarView);
  const openFile = useWorkspace((s) => s.openFile);

  // Single shared poller lives in `Sidebar`; we just subscribe to the cache.
  const info = useGit((s) => s.info);
  const entries = useGit((s) => s.entries);
  const loading = useGit((s) => s.loading);
  const storeError = useGit((s) => s.error);
  const refreshStore = useGit((s) => s.refresh);

  const [opError, setOpError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    entry: GitChangeEntry;
    section: Section;
    x: number;
    y: number;
  } | null>(null);
  const [diffTarget, setDiffTarget] = useState<{
    entry: GitChangeEntry;
    section: Section;
  } | null>(null);
  const [discardTarget, setDiscardTarget] = useState<{
    entry: GitChangeEntry;
    section: Section;
  } | null>(null);

  const error = opError ?? storeError;

  const refresh = useCallback(async () => {
    if (!isTauri || !root) return;
    await refreshStore(root);
  }, [refreshStore, root]);

  useEffect(
    () => () => {
      if (flashTimer.current != null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  const showFlash = useCallback((text: string) => {
    setFlash(text);
    if (flashTimer.current != null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 2400);
  }, []);

  const grouped = useMemo(() => {
    const buckets: Record<Section, GitChangeEntry[]> = {
      staged: [],
      changes: [],
      untracked: [],
      conflict: [],
    };
    for (const e of entries) {
      buckets[sectionFor(e)].push(e);
    }
    for (const k of Object.keys(buckets) as Section[]) {
      buckets[k].sort((a, b) => a.path.localeCompare(b.path));
    }
    return buckets;
  }, [entries]);

  const stagedCount = grouped.staged.length;
  const total = entries.length;

  const handleOpen = useCallback(
    (entry: GitChangeEntry) => {
      if (!root) return;
      if (entry.kind === 'conflict') return;
      const abs = joinPath(root, entry.path);
      openFile(abs);
    },
    [openFile, root],
  );

  const runWithRefresh = useCallback(
    async (op: () => Promise<void>) => {
      if (!root || busy) return;
      setBusy(true);
      setOpError(null);
      try {
        await op();
        await refresh();
      } catch (e) {
        setOpError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, root],
  );

  const handleStage = useCallback(
    (paths: string[]) => {
      if (!root || paths.length === 0) return;
      void runWithRefresh(() => gitStage(root, paths));
    },
    [root, runWithRefresh],
  );

  const handleUnstage = useCallback(
    (paths: string[]) => {
      if (!root || paths.length === 0) return;
      void runWithRefresh(() => gitUnstage(root, paths));
    },
    [root, runWithRefresh],
  );

  const handleStageAll = useCallback(() => {
    const paths = [...grouped.changes, ...grouped.untracked].map((e) => e.path);
    handleStage(paths);
  }, [grouped.changes, grouped.untracked, handleStage]);

  const handleUnstageAll = useCallback(() => {
    handleUnstage(grouped.staged.map((e) => e.path));
  }, [grouped.staged, handleUnstage]);

  const handleCommit = useCallback(async () => {
    if (!root || busy) return;
    const msg = message.trim();
    if (!msg) {
      setOpError('write a commit message');
      return;
    }
    if (stagedCount === 0) {
      setOpError('nothing staged');
      return;
    }
    setBusy(true);
    setOpError(null);
    try {
      const res = await gitCommit(root, msg);
      setMessage('');
      const label = res.short ? res.short : 'committed';
      showFlash(`✓ ${label}`);
      await refresh();
    } catch (e) {
      setOpError(String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, message, refresh, root, showFlash, stagedCount]);

  const handleDiscard = useCallback(
    async (entry: GitChangeEntry, section: Section) => {
      if (!root) return;
      const tracked: string[] = [];
      const untracked: string[] = [];
      if (section === 'untracked') untracked.push(entry.path);
      else tracked.push(entry.path);
      await runWithRefresh(() => gitDiscard(root, tracked, untracked));
    },
    [root, runWithRefresh],
  );

  const copyToClipboard = useCallback((text: string) => {
    void navigator.clipboard.writeText(text);
  }, []);

  const absolutePath = useCallback(
    (rel: string) => (root ? joinPath(root, rel) : rel),
    [root],
  );

  const openContextMenu = useCallback(
    (entry: GitChangeEntry, section: Section, x: number, y: number) => {
      setContextMenu({ entry, section, x, y });
    },
    [],
  );

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const onMessageKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void handleCommit();
      }
    },
    [handleCommit],
  );

  const canCommit =
    isTauri && !!root && !busy && stagedCount > 0 && message.trim().length > 0;

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Header — branch glyph, name + sync indicators, change count, refresh */}
      <div className="relative flex h-11 shrink-0 items-center gap-1.5 border-b border-border-hairline px-2.5">
        {/* Subtle top-edge highlight, matches macOS toolbar lift. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.06] to-transparent"
        />
        <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent-soft ring-1 ring-inset ring-accent/15">
          <GitBranch size={10.5} strokeWidth={2.2} className="text-accent-bright/90" />
        </div>
        <span
          className="min-w-0 flex-1 truncate font-display text-[12px] font-medium tracking-tight text-fg-base/95"
          title={
            info?.branch
              ? `${info.branch}${info.upstream ? ` → ${info.upstream}` : ''}`
              : 'not a git repository'
          }
        >
          {info?.branch ?? '—'}
        </span>
        {/* Ahead/behind chevrons — only render the side that's non-zero. */}
        {info && (info.ahead > 0 || info.behind > 0) && (
          <div className="flex items-center gap-1 rounded-md bg-white/[0.04] px-1.5 py-[2px] font-mono text-[9.5px] tabular-nums text-fg-muted ring-1 ring-inset ring-white/[0.05]">
            {info.behind > 0 && (
              <span className="flex items-center gap-[1px]" title={`${info.behind} behind`}>
                <ArrowDownToLine size={9} strokeWidth={2.4} />
                {info.behind}
              </span>
            )}
            {info.ahead > 0 && (
              <span className="flex items-center gap-[1px]" title={`${info.ahead} ahead`}>
                <ArrowUpFromLine size={9} strokeWidth={2.4} />
                {info.ahead}
              </span>
            )}
          </div>
        )}
        {total > 0 && (
          <span
            className="flex h-[17px] min-w-[18px] items-center justify-center rounded-full bg-white/[0.05] px-[5px] font-mono text-[9.5px] font-semibold tabular-nums text-fg-base/85 ring-1 ring-inset ring-white/[0.06]"
            title={`${total} change${total === 1 ? '' : 's'}`}
          >
            {total > 99 ? '99+' : total}
          </span>
        )}
        <button
          onClick={() => void refresh()}
          disabled={!isTauri || !root || loading}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-md text-fg-muted transition-all duration-150 ease-apple',
            'hover:bg-white/[0.08] hover:text-fg-base hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]',
            'active:scale-[0.92]',
            'disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:shadow-none',
          )}
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCw
            size={12}
            strokeWidth={2.1}
            className={loading ? 'animate-spin-slow' : ''}
          />
        </button>
        <button
          onClick={() => setSidebarView('files')}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-md text-fg-muted transition-all duration-150 ease-apple',
            'hover:bg-white/[0.08] hover:text-fg-base hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]',
            'active:scale-[0.92]',
          )}
          aria-label="Show file tree"
          title="Files"
        >
          <Files size={12} strokeWidth={2.1} />
        </button>
      </div>

      {/* Commit composer — card with focus bloom + gradient commit bar */}
      {isTauri && info?.branch && (
        <div className="shrink-0 border-b border-border-hairline px-2.5 py-2.5">
          <div
            className={cn(
              'group/composer relative rounded-lg border border-white/[0.05] bg-bg-base/55',
              'shadow-[inset_0_1px_0_0_rgba(255,255,255,0.035)]',
              'transition-all duration-200 ease-apple',
              'focus-within:border-accent/45 focus-within:bg-bg-base/75 focus-within:shadow-focus',
            )}
          >
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={onMessageKeyDown}
              placeholder={
                stagedCount > 0
                  ? `Commit message…  (${stagedCount} file${stagedCount === 1 ? '' : 's'} staged)`
                  : 'Commit message…  stage a file to begin'
              }
              rows={2}
              disabled={busy}
              className={cn(
                'block w-full resize-none rounded-lg bg-transparent px-2.5 py-2',
                'font-display text-[12px] leading-snug tracking-tight text-fg-base placeholder:text-fg-subtle/85',
                'outline-none disabled:opacity-60',
              )}
            />
            {/* Right-anchored kbd hint, dims to invisible when textarea is empty */}
            <div
              aria-hidden
              className={cn(
                'pointer-events-none absolute bottom-1.5 right-2 flex items-center gap-1',
                'font-mono text-[9px] tabular-nums tracking-tight text-fg-subtle/80',
                'transition-opacity duration-200',
                message.length > 0 ? 'opacity-100' : 'opacity-0',
              )}
            >
              <kbd className="rounded bg-white/[0.05] px-1 py-[1px] ring-1 ring-inset ring-white/[0.05]">
                ⌘⏎
              </kbd>
            </div>
          </div>

          <div className="mt-2 flex items-center gap-1.5">
            <button
              onClick={() => void handleCommit()}
              disabled={!canCommit}
              className={cn(
                'group/btn relative flex h-[28px] flex-1 items-center justify-center gap-1.5 overflow-hidden rounded-lg',
                'font-display text-[11.5px] font-medium tracking-tight',
                'transition-all duration-200 ease-apple',
                canCommit
                  ? cn(
                      'bg-gradient-to-b from-white/[0.10] to-white/[0.04] text-accent-bright',
                      'ring-1 ring-inset ring-accent/25',
                      'shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08),0_1px_2px_0_rgba(0,0,0,0.35)]',
                      'hover:from-white/[0.14] hover:to-white/[0.06] hover:ring-accent/40 hover:shadow-glow-sm',
                      'active:scale-[0.985]',
                    )
                  : 'bg-white/[0.03] text-fg-subtle ring-1 ring-inset ring-white/[0.04]',
              )}
              title={
                stagedCount === 0
                  ? 'Stage a file first'
                  : 'Commit (⌘⏎)'
              }
            >
              {/* Soft inner sheen — only visible when armed. */}
              {canCommit && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.18] to-transparent"
                />
              )}
              <Check size={12} strokeWidth={2.4} />
              <span className="relative">
                {canCommit
                  ? `Commit ${stagedCount} ${stagedCount === 1 ? 'file' : 'files'}`
                  : stagedCount > 0
                    ? `Commit ${stagedCount} ${stagedCount === 1 ? 'file' : 'files'}`
                    : 'Commit'}
              </span>
            </button>
            {flash && (
              <span
                className={cn(
                  'flex items-center gap-1 rounded-md bg-status-ok/10 px-1.5 py-[3px]',
                  'font-mono text-[10px] tabular-nums text-status-ok ring-1 ring-inset ring-status-ok/25',
                  'animate-fade-in',
                )}
              >
                <Sparkles size={9} strokeWidth={2.2} />
                {flash}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Body */}
      <div className="selectable flex-1 overflow-auto px-1.5 py-2">
        {!isTauri && (
          <div className="mx-1 mb-2 flex items-start gap-2 rounded-lg border border-status-warn/20 bg-status-warn/[0.06] px-2.5 py-2 font-display text-[10.5px] leading-relaxed">
            <span className="mt-[3px] inline-flex h-1.5 w-1.5 shrink-0 animate-pulse-soft rounded-full bg-status-warn" />
            <span className="min-w-0 text-fg-muted">
              <span className="font-medium text-status-warn">Web preview</span> —
              source control requires the Tauri shell.
            </span>
          </div>
        )}
        {error && (
          <div className="mx-1 mb-2 flex items-start gap-2 rounded-lg border border-status-err/25 bg-status-err/[0.07] px-2.5 py-2 font-display text-[10.5px] leading-relaxed text-status-err shadow-[inset_0_1px_0_0_rgba(255,82,82,0.05)]">
            <AlertCircle size={12} strokeWidth={2} className="mt-px shrink-0" />
            <span className="min-w-0 break-words text-status-err/90" title={error}>
              {error}
            </span>
          </div>
        )}
        {isTauri && !error && total === 0 && !loading && (
          <EmptyState branch={info?.branch ?? null} />
        )}
        {SECTION_ORDER.map((section) => {
          const rows = grouped[section];
          if (rows.length === 0) return null;
          return (
            <SectionBlock
              key={section}
              section={section}
              title={SECTION_LABEL[section]}
              count={rows.length}
              busy={busy}
              onStageAll={
                section === 'changes' || section === 'untracked'
                  ? () => handleStage(rows.map((r) => r.path))
                  : undefined
              }
              onUnstageAll={
                section === 'staged'
                  ? handleUnstageAll
                  : undefined
              }
              onStageEverything={
                section === 'changes' &&
                grouped.untracked.length > 0 &&
                rows.length > 0
                  ? handleStageAll
                  : undefined
              }
            >
              {rows.map((entry) => (
                <ChangeRow
                  key={`${section}-${entry.path}`}
                  entry={entry}
                  section={section}
                  busy={busy}
                  onOpen={handleOpen}
                  onStage={() => handleStage([entry.path])}
                  onUnstage={() => handleUnstage([entry.path])}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openContextMenu(entry, section, e.clientX, e.clientY);
                  }}
                />
              ))}
            </SectionBlock>
          );
        })}
      </div>

      {contextMenu && (
        <ChangeContextMenu
          entry={contextMenu.entry}
          section={contextMenu.section}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
          onOpenFile={() => handleOpen(contextMenu.entry)}
          onOpenDiff={() =>
            setDiffTarget({
              entry: contextMenu.entry,
              section: contextMenu.section,
            })
          }
          onStage={() => handleStage([contextMenu.entry.path])}
          onUnstage={() => handleUnstage([contextMenu.entry.path])}
          onDiscard={() =>
            setDiscardTarget({
              entry: contextMenu.entry,
              section: contextMenu.section,
            })
          }
          onCopyPath={() => copyToClipboard(absolutePath(contextMenu.entry.path))}
          onCopyRelativePath={() => copyToClipboard(contextMenu.entry.path)}
        />
      )}

      {diffTarget && root && (
        <DiffViewer
          root={root}
          entry={diffTarget.entry}
          section={diffTarget.section}
          onClose={() => setDiffTarget(null)}
        />
      )}

      {discardTarget && (
        <DiscardDialog
          entry={discardTarget.entry}
          section={discardTarget.section}
          onConfirm={async () => {
            const t = discardTarget;
            setDiscardTarget(null);
            await handleDiscard(t.entry, t.section);
          }}
          onCancel={() => setDiscardTarget(null)}
        />
      )}
    </div>
  );
}

function SectionBlock({
  section,
  title,
  count,
  busy,
  onStageAll,
  onUnstageAll,
  onStageEverything,
  children,
}: {
  section: Section;
  title: string;
  count: number;
  busy: boolean;
  onStageAll?: () => void;
  onUnstageAll?: () => void;
  /** Shown on the `changes` header when there are also untracked rows below. */
  onStageEverything?: () => void;
  children: React.ReactNode;
}) {
  const accent = sectionAccent(section);
  return (
    <div className="group/section mb-2.5">
      <div className="flex items-center justify-between gap-1 px-2 pb-1 pt-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              accent.dot,
              accent.pulse && 'animate-pulse-soft',
            )}
          />
          <span
            className={cn(
              'truncate font-display text-[9.5px] font-medium uppercase tracking-widest2',
              accent.label,
            )}
          >
            {title}
          </span>
          <span
            className={cn(
              'inline-flex h-[14px] min-w-[15px] items-center justify-center rounded-full px-[4px]',
              'font-mono text-[9px] font-semibold leading-none tabular-nums tracking-tight',
              'bg-white/[0.04] text-fg-muted ring-1 ring-inset ring-white/[0.05]',
            )}
          >
            {count}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/section:opacity-100 focus-within:opacity-100">
          {onStageEverything && (
            <SectionAction
              icon={<Plus size={11} strokeWidth={2.2} />}
              label="Stage all changes (including untracked)"
              disabled={busy}
              onClick={onStageEverything}
            />
          )}
          {onStageAll && (
            <SectionAction
              icon={<Plus size={11} strokeWidth={2.2} />}
              label={
                section === 'untracked'
                  ? 'Stage all untracked'
                  : 'Stage all changes'
              }
              disabled={busy}
              onClick={onStageAll}
            />
          )}
          {onUnstageAll && (
            <SectionAction
              icon={<Minus size={11} strokeWidth={2.2} />}
              label="Unstage all"
              disabled={busy}
              onClick={onUnstageAll}
            />
          )}
        </div>
      </div>
      <div className="space-y-[1px]">{children}</div>
    </div>
  );
}

function SectionAction({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'flex h-[18px] w-[18px] items-center justify-center rounded-md text-fg-subtle transition-all duration-150 ease-apple',
        'hover:bg-white/[0.08] hover:text-fg-base hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]',
        'active:scale-[0.9]',
        'disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:shadow-none',
      )}
    >
      {icon}
    </button>
  );
}

/** Small illustrative empty-state mark + line of copy. */
function EmptyState({ branch }: { branch: string | null }) {
  return (
    <div className="flex flex-col items-center gap-3 px-2 py-8 text-center">
      {/* A trio of stacked rings — pure CSS, no asset. Reads as "all clean". */}
      <div className="relative h-9 w-9">
        <span
          aria-hidden
          className="absolute inset-0 rounded-full ring-1 ring-white/[0.08]"
        />
        <span
          aria-hidden
          className="absolute inset-[6px] rounded-full ring-1 ring-white/[0.06]"
        />
        <span
          aria-hidden
          className="absolute inset-[12px] flex items-center justify-center rounded-full bg-accent-soft ring-1 ring-inset ring-accent/20"
        >
          {branch ? (
            <Check size={9} strokeWidth={2.4} className="text-accent-bright/80" />
          ) : (
            <X size={9} strokeWidth={2.4} className="text-fg-subtle" />
          )}
        </span>
      </div>
      <div className="space-y-0.5">
        <p className="font-display text-[11.5px] font-medium tracking-tight text-fg-base/85">
          {branch ? 'Working tree clean' : 'Not a git repository'}
        </p>
        <p className="font-display text-[10.5px] leading-relaxed text-fg-subtle">
          {branch
            ? 'Every change committed. Make an edit to see it here.'
            : 'Open a folder under git to enable source control.'}
        </p>
      </div>
    </div>
  );
}

function ChangeRow({
  entry,
  section,
  busy,
  onOpen,
  onStage,
  onUnstage,
  onContextMenu,
}: {
  entry: GitChangeEntry;
  section: Section;
  busy: boolean;
  onOpen: (e: GitChangeEntry) => void;
  onStage: () => void;
  onUnstage: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const name = basename(entry.path);
  const folder = dirname(entry.path);
  const { Icon, color } = fileIcon(name);

  // Staged rows expose unstage; everything else exposes stage. Conflicts get
  // neither (resolution belongs in the editor, not in this rail).
  const canStage = section === 'changes' || section === 'untracked';
  const canUnstage = section === 'staged';

  const chip = statusChipTone(entry.status);

  return (
    <div
      onContextMenu={onContextMenu}
      className={cn(
        'group/row relative flex h-[28px] w-full items-center gap-1.5 rounded-md pr-1.5 font-display text-[12.5px] tracking-tight',
        'transition-colors duration-150 ease-apple',
        'hover:bg-white/[0.045]',
      )}
    >
      {/* Left accent rail — slides in on hover. A 2px ribbon, scale-y'd from 0
          to 1 so it animates rather than blinks. */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute left-0 top-1/2 h-3 w-[2px] -translate-y-1/2 rounded-r-full',
          'origin-center scale-y-0 bg-accent-bright/55 transition-transform duration-200 ease-apple',
          'group-hover/row:scale-y-100',
        )}
      />

      <button
        type="button"
        onClick={() => onOpen(entry)}
        className="flex min-w-0 flex-1 items-center gap-1.5 truncate pl-2.5 text-left"
        title={entry.path}
      >
        <Icon
          size={13}
          strokeWidth={1.7}
          style={{ color }}
          className="shrink-0 opacity-90 transition-opacity duration-150 group-hover/row:opacity-100"
        />
        <span className="truncate text-fg-base/85 group-hover/row:text-fg-base">
          {name}
        </span>
        {folder && (
          <span
            className="truncate text-[10px] text-fg-subtle/85"
            title={folder}
          >
            {folder}
          </span>
        )}
      </button>

      {/* Hover actions — sit to the left of the status pill so the pill stays
          readable when nothing is hovered. */}
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-within:opacity-100">
        {canUnstage && (
          <RowAction
            icon={<Minus size={11} strokeWidth={2.4} />}
            label="Unstage"
            disabled={busy}
            onClick={onUnstage}
          />
        )}
        {canStage && (
          <RowAction
            icon={<Plus size={11} strokeWidth={2.4} />}
            label="Stage"
            disabled={busy}
            onClick={onStage}
          />
        )}
      </div>

      {/* Status pill — a tinted micro-chip, replaces the bare letter. */}
      <span
        className={cn(
          'flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px]',
          'font-mono text-[9px] font-semibold tabular-nums leading-none ring-1 ring-inset',
          chip.bg,
          chip.text,
          chip.ring,
        )}
        title={`status: ${entry.status}`}
      >
        {entry.status}
      </span>
    </div>
  );
}

function RowAction({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'flex h-[20px] w-[20px] items-center justify-center rounded-md text-fg-muted',
        'transition-all duration-150 ease-apple',
        'hover:bg-white/[0.10] hover:text-accent-bright hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]',
        'active:scale-[0.9]',
        'disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted disabled:hover:shadow-none',
      )}
    >
      {icon}
    </button>
  );
}

// ── ChangeContextMenu ───────────────────────────────────────────────────────

function ChangeContextMenu({
  entry,
  section,
  x,
  y,
  onClose,
  onOpenFile,
  onOpenDiff,
  onStage,
  onUnstage,
  onDiscard,
  onCopyPath,
  onCopyRelativePath,
}: {
  entry: GitChangeEntry;
  section: Section;
  x: number;
  y: number;
  onClose: () => void;
  onOpenFile: () => void;
  onOpenDiff: () => void;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
  onCopyPath: () => void;
  onCopyRelativePath: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({
      x: x + width > vw ? Math.max(0, vw - width - 8) : x,
      y: y + height > vh ? Math.max(0, vh - height - 8) : y,
    });
  }, [x, y]);

  useEffect(() => {
    const onMouse = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
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

  const canStage = section === 'changes' || section === 'untracked';
  const canUnstage = section === 'staged';
  // Discard is destructive — only meaningful for live worktree changes and
  // untracked files. Staged entries should be unstaged first; conflicts need
  // resolution in the editor.
  const canDiscard = section === 'changes' || section === 'untracked';
  const canDiff = section !== 'conflict';

  const item = (
    icon: React.ReactNode,
    label: string,
    action: () => void,
    danger = false,
  ) => (
    <button
      key={label}
      onClick={() => {
        action();
        onClose();
      }}
      className={cn(
        'group/item flex w-full items-center gap-2.5 rounded-md px-2.5 py-[6px]',
        'font-display text-[12px] tracking-tight transition-colors duration-100',
        danger
          ? 'text-status-err/85 hover:bg-status-err/[0.10] hover:text-status-err'
          : 'text-fg-base/85 hover:bg-white/[0.06] hover:text-fg-base',
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
      ref={menuRef}
      style={{ left: pos.x, top: pos.y }}
      className={cn(
        'fixed z-[9999] min-w-[212px] rounded-xl p-1.5',
        'border border-border-strong bg-bg-panel/95 backdrop-blur-thick backdrop-saturate-180',
        'shadow-sheet animate-fade-in',
      )}
      role="menu"
      aria-label={`Source control actions for ${entry.path}`}
    >
      {/* Tiny header strip showing what we're acting on. */}
      <div className="mx-1 mb-1 mt-0.5 flex items-center gap-1.5 truncate font-display text-[9.5px] uppercase tracking-widest2 text-fg-subtle/80">
        <span
          aria-hidden
          className={cn(
            'h-1 w-1 shrink-0 rounded-full',
            sectionAccent(section).dot,
          )}
        />
        <span className="truncate">{SECTION_LABEL[section]}</span>
      </div>
      {item(<FileText size={12} strokeWidth={2} />, 'Open File', onOpenFile)}
      {canDiff &&
        item(<GitCompare size={12} strokeWidth={2} />, 'Open Changes', onOpenDiff)}
      {sep}
      {canStage &&
        item(<Plus size={12} strokeWidth={2.2} />, 'Stage Changes', onStage)}
      {canUnstage &&
        item(<Minus size={12} strokeWidth={2.2} />, 'Unstage Changes', onUnstage)}
      {canDiscard &&
        item(<Trash2 size={12} strokeWidth={2} />, 'Discard Changes', onDiscard, true)}
      {sep}
      {item(<Copy size={12} strokeWidth={2} />, 'Copy Path', onCopyPath)}
      {item(<Copy size={12} strokeWidth={2} />, 'Copy Relative Path', onCopyRelativePath)}
    </div>,
    document.body,
  );
}

// ── DiffViewer ──────────────────────────────────────────────────────────────

/** Pick the diff scope that best matches the entry's state. */
function scopeFor(section: Section): GitDiffScope {
  switch (section) {
    case 'staged':
      return 'staged';
    case 'changes':
    case 'untracked':
    case 'conflict':
    default:
      return 'worktree';
  }
}

function DiffViewer({
  root,
  entry,
  section,
  onClose,
}: {
  root: string;
  entry: GitChangeEntry;
  section: Section;
  onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Untracked rows have no git history — we fall back to the file's contents
  // so the user still gets a visual representation of "what would be added".
  const isUntracked = section === 'untracked';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setText(null);

    const load = async () => {
      try {
        if (isUntracked) {
          const content = await fsReadFile(joinPath(root, entry.path));
          if (!cancelled) setText(content);
        } else {
          const diff = await gitDiff(root, scopeFor(section), entry.path);
          if (!cancelled) setText(diff);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [root, entry.path, section, isUntracked]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const empty = !loading && !error && (text == null || text.length === 0);
  const stats = !loading && !error && text ? diffStats(text) : null;
  const segments = pathSegments(entry.path);
  const fileName = segments[segments.length - 1] ?? entry.path;
  const folderSegments = segments.slice(0, -1);

  // Scope pill tone — visually echoes the section dot.
  const scopeTone = isUntracked
    ? { bg: 'bg-fg-muted/15', text: 'text-fg-muted', ring: 'ring-fg-muted/20' }
    : section === 'staged'
      ? {
          bg: 'bg-status-ok/12',
          text: 'text-status-ok',
          ring: 'ring-status-ok/25',
        }
      : {
          bg: 'bg-status-warn/12',
          text: 'text-status-warn',
          ring: 'ring-status-warn/25',
        };
  const scopeLabel = isUntracked
    ? 'Untracked'
    : section === 'staged'
      ? 'Staged'
      : 'Working tree';

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/55 p-6 backdrop-blur-xs"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          'flex h-full max-h-[82vh] w-full max-w-[1000px] flex-col overflow-hidden rounded-window',
          'border border-border-strong bg-bg-panel/95 backdrop-blur-thick',
          'shadow-sheet animate-sheet-in',
        )}
      >
        {/* Header: scope pill, breadcrumb path, close. */}
        <div className="relative flex shrink-0 items-center gap-2 border-b border-border-hairline px-4 py-3">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.08] to-transparent"
          />
          <span
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-full px-2 py-[3px] ring-1 ring-inset',
              'font-display text-[9.5px] font-medium uppercase tracking-widest2',
              scopeTone.bg,
              scopeTone.text,
              scopeTone.ring,
            )}
          >
            <GitCompare size={9} strokeWidth={2.3} />
            {scopeLabel}
          </span>
          <div
            className="flex min-w-0 flex-1 items-center gap-1 truncate font-display text-[12px] tracking-tight"
            title={entry.path}
          >
            {folderSegments.length > 0 && (
              <span className="flex min-w-0 items-center gap-1 truncate text-fg-subtle/85">
                {folderSegments.map((seg, i) => (
                  <span key={`${seg}-${i}`} className="flex shrink-0 items-center gap-1">
                    <span className="truncate">{seg}</span>
                    <ChevronRight
                      size={10}
                      strokeWidth={2}
                      className="shrink-0 text-fg-subtle/45"
                    />
                  </span>
                ))}
              </span>
            )}
            <span className="truncate font-medium text-fg-base/95">{fileName}</span>
          </div>
          {stats && (stats.added > 0 || stats.removed > 0) && (
            <div className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] tabular-nums">
              {stats.added > 0 && (
                <span className="rounded-md bg-status-ok/12 px-1.5 py-[2px] text-status-ok ring-1 ring-inset ring-status-ok/25">
                  +{stats.added}
                </span>
              )}
              {stats.removed > 0 && (
                <span className="rounded-md bg-status-err/12 px-1.5 py-[2px] text-status-err ring-1 ring-inset ring-status-err/25">
                  −{stats.removed}
                </span>
              )}
            </div>
          )}
          <button
            onClick={onClose}
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-muted',
              'transition-all duration-150 ease-apple',
              'hover:bg-white/[0.08] hover:text-fg-base hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]',
              'active:scale-[0.92]',
            )}
            aria-label="Close diff"
            title="Close (Esc)"
          >
            <X size={12} strokeWidth={2.2} />
          </button>
        </div>

        {/* Body */}
        <div className="selectable min-h-0 flex-1 overflow-auto bg-bg-base/40 font-mono text-[11.5px] leading-[1.55]">
          {loading && (
            <div className="flex items-center gap-2 px-4 py-4 text-fg-subtle">
              <RefreshCw size={11} strokeWidth={2} className="animate-spin-slow" />
              <span className="font-display tracking-tight">Loading diff…</span>
            </div>
          )}
          {error && (
            <div className="m-4 flex items-start gap-2 rounded-lg border border-status-err/25 bg-status-err/[0.07] px-3 py-2.5 font-display text-[11.5px] tracking-tight text-status-err shadow-[inset_0_1px_0_0_rgba(255,82,82,0.05)]">
              <AlertCircle size={12} strokeWidth={2} className="mt-px shrink-0" />
              <span className="whitespace-pre-wrap break-words">{error}</span>
            </div>
          )}
          {empty && (
            <div className="flex flex-col items-center gap-2.5 px-4 py-12 text-center">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-soft ring-1 ring-inset ring-accent/15">
                <Check size={13} strokeWidth={2.2} className="text-accent-bright/80" />
              </div>
              <p className="font-display text-[11.5px] font-medium tracking-tight text-fg-base/85">
                No differences
              </p>
              <p className="font-display text-[10.5px] text-fg-subtle">
                This file matches the {scopeLabel.toLowerCase()} reference.
              </p>
            </div>
          )}
          {!loading && !error && text && (
            <DiffLines text={text} untracked={isUntracked} />
          )}
        </div>

        {/* Footer hint */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border-hairline bg-bg-chrome/40 px-4 py-2 font-display text-[10px] text-fg-subtle">
          <span className="tracking-tight">
            {isUntracked
              ? 'New file — showing contents as additions.'
              : section === 'staged'
                ? 'Comparing index against HEAD.'
                : 'Comparing working tree against index.'}
          </span>
          <span className="flex items-center gap-1 font-mono tabular-nums">
            <kbd className="rounded bg-white/[0.04] px-1 py-[1px] ring-1 ring-inset ring-white/[0.05]">
              Esc
            </kbd>
            to close
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Render a unified-diff (or untracked file's contents) with a left line-number
 * gutter, faint full-row tints on additions/removals, and a distinct hunk band.
 *
 * Layout is `[gutter | content]`, each line its own grid row so wide lines
 * scroll horizontally without breaking the gutter alignment.
 */
function DiffLines({ text, untracked }: { text: string; untracked: boolean }) {
  const lines = text.split('\n');
  return (
    <div className="grid grid-cols-[auto_1fr] font-mono text-[11.5px] leading-[1.55]">
      {lines.map((line, i) => {
        let kind:
          | 'add'
          | 'del'
          | 'hunk'
          | 'meta'
          | 'header'
          | 'context'
          | 'untracked' = 'context';
        if (untracked) kind = 'untracked';
        else if (line.startsWith('+++') || line.startsWith('---')) kind = 'header';
        else if (line.startsWith('@@')) kind = 'hunk';
        else if (line.startsWith('+')) kind = 'add';
        else if (line.startsWith('-')) kind = 'del';
        else if (line.startsWith('diff ') || line.startsWith('index '))
          kind = 'meta';

        const tone =
          kind === 'add' || kind === 'untracked'
            ? 'bg-status-ok/[0.07] text-status-ok/95'
            : kind === 'del'
              ? 'bg-status-err/[0.07] text-status-err/95'
              : kind === 'hunk'
                ? 'bg-accent-soft text-accent-bright ring-1 ring-inset ring-accent/15'
                : kind === 'meta'
                  ? 'text-fg-subtle/75'
                  : kind === 'header'
                    ? 'text-fg-muted'
                    : 'text-fg-base/80';

        const marker =
          kind === 'add' || kind === 'untracked'
            ? '+'
            : kind === 'del'
              ? '−'
              : ' ';

        return (
          <div key={i} className="contents">
            <span
              className={cn(
                'select-none px-3 text-right text-[10px] tabular-nums text-fg-subtle/45',
                'border-r border-white/[0.03]',
                kind === 'hunk' && 'text-accent/60',
                kind === 'add' && 'bg-status-ok/[0.04]',
                kind === 'del' && 'bg-status-err/[0.04]',
                kind === 'untracked' && 'bg-status-ok/[0.03]',
              )}
            >
              {i + 1}
            </span>
            <pre
              className={cn(
                'm-0 whitespace-pre px-3',
                tone,
              )}
            >
              <span className="mr-2 inline-block w-[10px] text-fg-subtle/55">
                {marker}
              </span>
              {kind === 'untracked' ? line || ' ' : line || ' '}
            </pre>
          </div>
        );
      })}
    </div>
  );
}

// ── DiscardDialog ───────────────────────────────────────────────────────────

function DiscardDialog({
  entry,
  section,
  onConfirm,
  onCancel,
}: {
  entry: GitChangeEntry;
  section: Section;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onConfirm, onCancel]);

  const isUntracked = section === 'untracked';
  const name = basename(entry.path);
  const folder = dirname(entry.path);

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/55 p-6 backdrop-blur-xs"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className={cn(
          'w-[420px] max-w-full overflow-hidden rounded-window',
          'border border-border-strong bg-bg-panel/95 backdrop-blur-thick',
          'shadow-sheet animate-sheet-in',
        )}
      >
        <div className="relative px-5 pt-5 pb-4">
          {/* Top highlight rule */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.08] to-transparent"
          />
          <div className="flex items-start gap-3.5">
            {/* Soft red puck — concentric tinted rings, single AlertCircle at center. */}
            <div className="relative h-10 w-10 shrink-0">
              <span
                aria-hidden
                className="absolute inset-0 rounded-full bg-status-err/[0.06] ring-1 ring-inset ring-status-err/15"
              />
              <span
                aria-hidden
                className="absolute inset-[5px] flex items-center justify-center rounded-full bg-status-err/15 ring-1 ring-inset ring-status-err/30"
              >
                <AlertCircle
                  size={14}
                  strokeWidth={2.2}
                  className="text-status-err"
                />
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-display text-[13.5px] font-semibold tracking-tight text-fg-base">
                {isUntracked ? 'Delete untracked file?' : 'Discard local changes?'}
              </p>
              <p className="mt-1.5 font-display text-[11.5px] leading-relaxed text-fg-muted">
                {isUntracked
                  ? 'This file will be permanently removed from disk. It is not in git history and cannot be recovered.'
                  : 'Local edits to this file will be reverted to HEAD. This action cannot be undone.'}
              </p>
              {/* Path chip — mono, tinted, with directory prefix in subtle text. */}
              <div className="mt-3 flex items-center gap-1 truncate rounded-md bg-bg-base/55 px-2 py-1.5 font-mono text-[10.5px] ring-1 ring-inset ring-white/[0.05]">
                {folder && (
                  <span className="shrink truncate text-fg-subtle/85" title={folder}>
                    {folder}
                  </span>
                )}
                {folder && (
                  <ChevronRight
                    size={9}
                    strokeWidth={2}
                    className="shrink-0 text-fg-subtle/50"
                  />
                )}
                <span className="truncate font-semibold text-fg-base/95">{name}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-1.5 border-t border-border-hairline bg-bg-chrome/40 px-4 py-3">
          <button
            onClick={onCancel}
            className={cn(
              'rounded-md px-3.5 py-1.5 font-display text-[11.5px] font-medium tracking-tight text-fg-muted',
              'transition-all duration-150 ease-apple',
              'hover:bg-white/[0.06] hover:text-fg-base active:scale-[0.985]',
            )}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={cn(
              'group/destruct relative overflow-hidden rounded-md px-3.5 py-1.5',
              'font-display text-[11.5px] font-semibold tracking-tight text-white',
              'bg-gradient-to-b from-status-err/95 to-status-err/75',
              'ring-1 ring-inset ring-status-err/40',
              'shadow-[inset_0_1px_0_0_rgba(255,255,255,0.16),0_1px_2px_0_rgba(0,0,0,0.4)]',
              'transition-all duration-150 ease-apple',
              'hover:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.22),0_0_18px_-2px_rgba(255,82,82,0.45)]',
              'active:scale-[0.985]',
            )}
          >
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.30] to-transparent"
            />
            <span className="relative inline-flex items-center gap-1.5">
              <Trash2 size={11} strokeWidth={2.2} />
              Discard
            </span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
