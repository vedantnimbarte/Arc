import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bot,
  ChevronRight,
  Folder,
  GitBranch,
  Keyboard,
  Server,
  Sparkles,
  Terminal as TerminalIcon,
} from 'lucide-react';
import { useSsh } from '../state/ssh';
import {
  isTauri,
  ptyListAiClis,
  ptyListShells,
  ptyWrite,
  type AiCliInfo,
  type GitDiffStat,
  type GitInfo,
  type ShellInfo,
} from '../lib/tauri';
import { useWorkspace } from '../state/workspace';
import { useFiles } from '../state/files';
import { useGit } from '../state/git';
import { useSettings } from '../state/settings';
import { cn } from '../lib/cn';
import { formatBinding, getBinding } from '../state/shortcuts';
import { BranchPicker } from './BranchPicker';
import { ModelTriggerPill } from './ChatPanel';

interface Props {
  chatOpen: boolean;
  onToggleChat: () => void;
  onOpenShortcuts: () => void;
}

export function StatusBar({ chatOpen, onToggleChat, onOpenShortcuts }: Props) {
  const tabs = useWorkspace((s) => s.tabs);
  const launchAiCli = useWorkspace((s) => s.launchAiCli);
  const newTerminal = useWorkspace((s) => s.newTerminal);
  const root = useFiles((s) => s.root);

  // Shared git refresh driver lives on the Sidebar (fs-watcher + backstop
  // poll). We just subscribe here so the branch pill + diff-stat badge ride
  // the same cache as the sidebar source-control view — no duplicate work.
  const git = useGit((s) => s.info);
  const diffStat = useGit((s) => s.diffStat);
  const refreshGit = useCallback(() => {
    if (isTauri && root) void useGit.getState().refresh(root);
  }, [root]);
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <>
      <footer
        className={cn(
          // Taller chrome (32px) gives every pill a real touch target and
          // lets typography breathe. The inset top hairline is the Apple
          // signature — a single bright pixel that reads as a light source
          // above the bar.
          'relative flex h-8 shrink-0 items-center justify-between gap-6 px-5',
          'border-t border-border-hairline bg-bg-chrome/65 backdrop-blur-md',
          'shadow-[inset_0_1px_0_0_rgba(255,255,255,0.045)]',
          'font-display text-[10.75px] tracking-[-0.005em] text-fg-muted',
        )}
      >
        <div className="flex min-w-0 items-center gap-3.5">
          <ShellPickerPill onSpawn={(shell) => void newTerminal({ shellOverride: shell })} />
          {root && (
            <>
              <Dot />
              <Breadcrumbs root={root} />
            </>
          )}
          {!isTauri && (
            <>
              <Dot />
              <span className="text-status-warn">web preview</span>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3.5">
          {git?.branch && (
            <>
              <BranchIndicator
                info={git}
                onClick={() => setPickerOpen(true)}
              />
              {diffStat && (diffStat.files_changed > 0 || diffStat.insertions > 0 || diffStat.deletions > 0) && (
                <DiffStatBadge stat={diffStat} />
              )}
              <Dot />
            </>
          )}
          <span className="tabular-nums text-fg-muted/90">
            {tabs.length} {tabs.length === 1 ? 'tab' : 'tabs'}
          </span>
          <Dot />
          <ModelTriggerPill placement="up" align="end" compact />
          <Dot />

          {/* Trailing control cluster — the bar is now 32px tall so the
              pills sit at their natural 22px height with vertical breathing
              room above and below. Same accent-soft "active" tint across
              the cluster keeps the rhythm uniform. */}
          <div className="flex items-center gap-1">
            <StatusIconButton
              onClick={onOpenShortcuts}
              ariaLabel="Keyboard shortcuts"
              title={`Keyboard shortcuts (${formatBinding(getBinding('open-shortcuts'))})`}
            >
              <Keyboard size={11.5} strokeWidth={2} />
            </StatusIconButton>

            <AiCliButton onLaunch={launchAiCli} />

            <SshStatusButton />

            <button
              type="button"
              onClick={onToggleChat}
              aria-label={chatOpen ? 'Close assistant' : 'Open assistant'}
              aria-pressed={chatOpen}
              title="Assistant"
              className={cn(
                'group relative flex h-[22px] items-center gap-1.5 rounded-md px-2 transition-colors',
                chatOpen
                  ? 'bg-accent-soft text-accent-bright shadow-[inset_0_0_0_1px_rgba(220,224,232,0.18)]'
                  : 'text-fg-muted hover:bg-white/[0.06] hover:text-fg-base/95 focus-visible:bg-white/[0.06] focus:outline-none',
              )}
            >
              <Sparkles
                size={11.5}
                strokeWidth={2}
                className={cn(
                  'transition-transform duration-300 ease-apple',
                  chatOpen && 'scale-110 drop-shadow-[0_0_6px_rgba(220,224,232,0.6)]',
                )}
              />
              <span className="font-display text-[10.5px] tracking-tight">assistant</span>
              {chatOpen && (
                <span
                  className="pointer-events-none absolute -bottom-[3px] left-1/2 h-[2px] w-3 -translate-x-1/2 rounded-full bg-accent-bright/85 shadow-glow-sm"
                  aria-hidden
                />
              )}
            </button>
          </div>

          <Dot />
          <span className="font-mono text-[10px] tracking-tight tabular-nums text-fg-subtle/85">
            arc 0.0.1
          </span>
        </div>
      </footer>

      <BranchPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onCheckedOut={() => refreshGit()}
      />
    </>
  );
}

// ----- subcomponents -------------------------------------------------------

/** Compact icon button that opens the SSH panel and badges the count of
 *  currently-live SSH sessions. Hidden when no hosts are saved AND no
 *  session is live — keeps the bar quiet for users who don't use SSH. */
function SshStatusButton() {
  const open = useSsh((s) => s.panelOpen);
  const toggle = useSsh((s) => s.togglePanel);
  const liveCount = useSsh((s) => Object.keys(s.liveByHost).length);
  const hostCount = useSsh((s) => s.hosts.length);

  if (hostCount === 0 && liveCount === 0) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={open ? 'Close SSH panel' : 'Open SSH panel'}
      aria-pressed={open}
      title={`SSH (${formatBinding(getBinding('toggle-ssh-panel'))})`}
      className={cn(
        'group relative flex h-[22px] items-center gap-1.5 rounded-md px-2 transition-colors',
        open
          ? 'bg-accent-soft text-accent-bright shadow-[inset_0_0_0_1px_rgba(220,224,232,0.18)]'
          : 'text-fg-muted hover:bg-white/[0.06] hover:text-fg-base/95 focus-visible:bg-white/[0.06] focus:outline-none',
      )}
    >
      <Server size={11.5} strokeWidth={2} />
      <span className="font-display text-[10.5px] tracking-tight">ssh</span>
      {liveCount > 0 && (
        <span className="font-mono text-[9px] tabular-nums text-status-ok">
          {liveCount}
        </span>
      )}
    </button>
  );
}

/** Inter-pill separator. A 2px circular glyph reads more deliberately than
 *  the middle-dot character at this size — the dot stays optically centred
 *  on the typographic baseline and matches the bar's refined density. */
function Dot() {
  return (
    <span
      aria-hidden
      className="inline-block h-[2px] w-[2px] shrink-0 rounded-full bg-fg-subtle/55 select-none"
    />
  );
}

/** Square icon button. Sits at the natural 22px height inside the 32px bar
 *  with ~5px of vertical breathing room above and below. */
function StatusIconButton({
  children,
  onClick,
  ariaLabel,
  title,
  active,
  buttonRef,
  ariaExpanded,
  ariaHaspopup,
  dimmed,
}: {
  children: React.ReactNode;
  onClick: () => void;
  ariaLabel: string;
  title: string;
  active?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
  ariaExpanded?: boolean;
  ariaHaspopup?: 'menu' | 'true';
  dimmed?: boolean;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={active}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHaspopup}
      title={title}
      className={cn(
        'group relative flex h-[22px] w-[22px] items-center justify-center rounded-md transition-colors focus:outline-none',
        active
          ? 'bg-accent-soft text-accent-bright shadow-[inset_0_0_0_1px_rgba(220,224,232,0.18)]'
          : dimmed
            ? 'text-fg-subtle/60 hover:bg-white/[0.045] hover:text-fg-muted focus-visible:bg-white/[0.045]'
            : 'text-fg-muted hover:bg-white/[0.06] hover:text-fg-base/95 focus-visible:bg-white/[0.06]',
      )}
    >
      {children}
    </button>
  );
}

/**
 * AI CLI launcher — same shape as the other status-bar pills, but opens
 * a dropdown *upward* from the status bar (instead of downward like the
 * original topbar version). The dropdown is portaled to body so the
 * status bar's backdrop-filter doesn't trap it.
 */
function AiCliButton({ onLaunch }: { onLaunch: (cli: AiCliInfo) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null);
  const [clis, setClis] = useState<AiCliInfo[]>([]);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // One-shot probe; re-runs every time the menu opens to catch CLIs
  // installed mid-session.
  useEffect(() => {
    if (!isTauri) return;
    ptyListAiClis().then(setClis).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open || !isTauri) return;
    ptyListAiClis().then(setClis).catch(() => {});
  }, [open]);

  // Anchor the menu to the top edge of the button so it opens upward.
  // Using viewport `bottom` instead of `top` saves us from measuring the
  // menu's height before painting.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const vh = window.innerHeight;
      // Right-align (subtract menu width 192px from the button's right edge)
      // so the menu doesn't extend past the viewport.
      setPos({
        bottom: vh - r.top + 4,
        left: Math.max(8, r.right - 192),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (menuRef.current?.contains(t)) return;
      if (btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <StatusIconButton
        onClick={() => setOpen((o) => !o)}
        ariaLabel="Launch AI CLI"
        title={
          clis.length > 0
            ? `Launch AI CLI (${clis.length} installed)`
            : 'Launch AI CLI (none detected on PATH)'
        }
        active={open}
        buttonRef={btnRef}
        ariaExpanded={open}
        ariaHaspopup="menu"
        dimmed={clis.length === 0 && !open}
      >
        <Bot size={11} strokeWidth={2} />
      </StatusIconButton>

      {open && pos && typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ position: 'fixed', bottom: pos.bottom, left: pos.left }}
            className="material-sheet z-50 w-48 animate-popover-in overflow-hidden rounded-md shadow-sheet ring-1 ring-white/10"
          >
            {clis.length === 0 ? (
              <div className="px-3 py-3 font-display text-[11.5px] leading-snug text-fg-muted">
                <div className="mb-1 font-medium text-fg-base">No AI CLIs found</div>
                <div className="text-fg-subtle">
                  Install <code className="font-mono">claude</code>,{' '}
                  <code className="font-mono">codex</code>, or{' '}
                  <code className="font-mono">opencode</code> on your{' '}
                  <code className="font-mono">PATH</code>.
                </div>
              </div>
            ) : (
              clis.map((cli) => (
                <button
                  key={cli.id}
                  role="menuitem"
                  onClick={() => {
                    onLaunch(cli);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left font-display text-[12px] text-fg-base/90 transition-colors hover:bg-white/[0.06]"
                  title={cli.path}
                >
                  <Bot size={12} strokeWidth={2} className="text-fg-subtle" />
                  <span className="flex-1 truncate">{cli.label}</span>
                </button>
              ))
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * Status-bar pill anchored to the left cluster. Lists every shell detected
 * on the user's machine (same source as Settings → Terminal) and spawns a
 * new terminal tab running the chosen shell. Menu pops *upward* through a
 * portal so the status bar's backdrop-filter doesn't trap it.
 */
function ShellPickerPill({ onSpawn }: { onSpawn: (shellPath: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Probe once on mount, then again every time the menu opens to catch
  // shells installed mid-session.
  useEffect(() => {
    if (!isTauri) return;
    ptyListShells().then(setShells).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open || !isTauri) return;
    ptyListShells().then(setShells).catch(() => {});
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const vh = window.innerHeight;
      setPos({
        bottom: vh - r.top + 4,
        left: Math.max(8, r.left),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (menuRef.current?.contains(t)) return;
      if (btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          shells.length > 0
            ? `Open terminal (${shells.length} shell${shells.length === 1 ? '' : 's'} detected)`
            : 'Open terminal'
        }
        className={cn(
          'group relative flex h-[22px] items-center gap-1.5 rounded-md px-2 transition-colors focus:outline-none',
          open
            ? 'bg-accent-soft text-accent-bright shadow-[inset_0_0_0_1px_rgba(220,224,232,0.18)]'
            : 'text-fg-muted hover:bg-white/[0.06] hover:text-fg-base/95 focus-visible:bg-white/[0.06]',
        )}
      >
        <TerminalIcon size={11.5} strokeWidth={2} />
        <span className="font-display text-[10.5px] tracking-tight">terminal</span>
      </button>

      {open && pos && typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ position: 'fixed', bottom: pos.bottom, left: pos.left }}
            className="material-sheet z-50 max-h-[280px] w-56 animate-popover-in overflow-y-auto rounded-md shadow-sheet ring-1 ring-white/10"
          >
            {shells.length === 0 ? (
              <div className="px-3 py-3 font-display text-[11.5px] leading-snug text-fg-muted">
                <div className="mb-1 font-medium text-fg-base">No shells detected</div>
                <div className="text-fg-subtle">
                  Tauri shell wasn’t able to probe <code className="font-mono">PATH</code>.
                </div>
              </div>
            ) : (
              shells.map((s) => (
                <button
                  key={s.path}
                  role="menuitem"
                  onClick={() => {
                    onSpawn(s.path);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-display text-[12px] text-fg-base/90 transition-colors hover:bg-white/[0.06]"
                  title={s.path}
                >
                  <TerminalIcon size={11} strokeWidth={2} className="text-fg-subtle" />
                  <span className="flex-1 truncate">{s.label}</span>
                  {s.is_default && (
                    <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fg-subtle">
                      default
                    </span>
                  )}
                </button>
              ))
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

function BranchIndicator({
  info,
  onClick,
}: {
  info: GitInfo;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex h-[22px] items-center gap-1.5 rounded-md font-mono text-[10px]',
        'px-1.5 transition-colors',
        'hover:bg-white/[0.06] focus-visible:bg-white/[0.06] focus:outline-none',
      )}
      title={
        info.upstream
          ? `${info.branch} → ${info.upstream}${info.ahead || info.behind ? ` (+${info.ahead}/-${info.behind})` : ''}${info.dirty ? ' · dirty' : ''}\nclick to switch branch`
          : `${info.branch}${info.dirty ? ' · dirty' : ''}\nclick to switch branch`
      }
    >
      <GitBranch
        size={10}
        strokeWidth={2}
        className={cn(
          'transition-colors',
          info.dirty ? 'text-accent-bright' : 'text-fg-subtle group-hover:text-fg-muted',
        )}
      />
      <span
        className={cn(
          'transition-colors',
          info.dirty ? 'text-fg-base/90' : 'text-fg-muted group-hover:text-fg-base/90',
        )}
      >
        {info.branch}
      </span>
      {info.dirty && (
        <span
          className="h-[5px] w-[5px] rounded-full bg-accent-bright shadow-[0_0_6px_rgba(220,224,232,0.55)]"
          aria-label="dirty"
        />
      )}
      {info.ahead > 0 && (
        <span className="tabular-nums text-fg-subtle">↑{info.ahead}</span>
      )}
      {info.behind > 0 && (
        <span className="tabular-nums text-fg-subtle">↓{info.behind}</span>
      )}
    </button>
  );
}

/**
 * Compact +ins/−del/files badge that mirrors the `git status --short` summary
 * line. Insertions render in the diff-add green, deletions in the diff-remove
 * red, and the file count sits in a muted neutral so the eye lands on the
 * line counts first. The whole badge is non-interactive — it's a glance
 * indicator, not a control.
 */
function DiffStatBadge({ stat }: { stat: GitDiffStat }) {
  const { insertions, deletions, files_changed } = stat;
  const title =
    `${files_changed} ${files_changed === 1 ? 'file' : 'files'} changed` +
    (insertions > 0 ? `, ${insertions} insertion${insertions === 1 ? '' : 's'}(+)` : '') +
    (deletions > 0 ? `, ${deletions} deletion${deletions === 1 ? '' : 's'}(−)` : '');
  return (
    <span
      className="flex h-[22px] items-center gap-1.5 px-1 font-mono text-[10px] tabular-nums"
      title={title}
      aria-label={title}
    >
      {insertions > 0 && (
        <span className="text-emerald-400/90">+{insertions}</span>
      )}
      {deletions > 0 && (
        <span className="text-rose-400/90">−{deletions}</span>
      )}
      {files_changed > 0 && (
        <span className="text-fg-subtle/80">
          {files_changed}f
        </span>
      )}
    </span>
  );
}

// ----- Breadcrumbs ---------------------------------------------------------

interface PathSegment {
  /** Display label for the segment ("C:", "Users", "foo"). */
  label: string;
  /** Absolute path to navigate to when this segment is clicked. */
  path: string;
}

/**
 * Decompose an absolute path into clickable ancestor segments. Handles both
 * Windows (`C:\Users\foo` or `C:/Users/foo`) and POSIX (`/home/foo`). The
 * separator used in the returned paths matches whichever the input used —
 * so navigating to a segment hands the rest of the app a path that looks
 * like the one it gave us.
 */
function splitPath(root: string): PathSegment[] {
  if (!root) return [];

  // Windows drive + body: C:\Users\foo
  const winMatch = root.match(/^([A-Za-z]:)[\\/](.*)$/);
  if (winMatch) {
    const drive = winMatch[1]!;
    const sep = root.includes('\\') ? '\\' : '/';
    const rest = winMatch[2]!;
    const parts = rest.split(/[\\/]+/).filter(Boolean);
    const segments: PathSegment[] = [{ label: drive, path: drive + sep }];
    let acc = drive;
    for (const p of parts) {
      acc = acc + sep + p;
      segments.push({ label: p, path: acc });
    }
    return segments;
  }

  // Bare drive: "C:" or "C:\"
  const bareDrive = root.match(/^([A-Za-z]:)[\\/]?$/);
  if (bareDrive) {
    const sep = root.includes('\\') ? '\\' : '/';
    return [{ label: bareDrive[1]!, path: bareDrive[1]! + sep }];
  }

  // POSIX absolute: /home/foo
  if (root.startsWith('/')) {
    const parts = root.split('/').filter(Boolean);
    const segments: PathSegment[] = [{ label: '/', path: '/' }];
    let acc = '';
    for (const p of parts) {
      acc = acc + '/' + p;
      segments.push({ label: p, path: acc });
    }
    return segments;
  }

  // Relative fallback — uncommon for `root`, but degrade gracefully.
  const parts = root.split(/[\\/]+/).filter(Boolean);
  const sep = root.includes('\\') ? '\\' : '/';
  return parts.map((p, i) => ({
    label: p,
    path: parts.slice(0, i + 1).join(sep),
  }));
}

/** Quote a path for safe insertion after `cd` in any shell we support. Mirrors
 *  the helper FileTree uses for click-to-paste so navigation feels uniform. */
function shellQuote(p: string): string {
  if (/^[\w./\\:+-]+$/.test(p)) return p;
  return `"${p.replace(/(["\\])/g, '\\$1')}"`;
}

/** True when `shellPath` points at cmd.exe — which needs `/d` to cross drives.
 *  PowerShell, bash, zsh, fish, nu all swallow `cd <path>` cross-drive. */
function isCmdExe(shellPath: string | null | undefined): boolean {
  if (!shellPath) return false;
  const name = shellPath.toLowerCase().replace(/^.*[\\/]/, '');
  return name === 'cmd.exe' || name === 'cmd';
}

/** Send a `cd <path>` to the active terminal tab so it follows wherever the
 *  file tree just moved. No-op when the active tab isn't a live terminal. */
function cdActiveTerminal(target: string) {
  const { tabs, activeTabId } = useWorkspace.getState();
  const active = tabs.find((t) => t.id === activeTabId);
  if (!active?.ptyId) return;
  const shellPath = active.shellOverride ?? useSettings.getState().defaultShell ?? null;
  const quoted = shellQuote(target);
  const cmd = isCmdExe(shellPath) ? `cd /d ${quoted}\r` : `cd ${quoted}\r`;
  void ptyWrite(active.ptyId, cmd).catch(() => {
    /* terminal closing */
  });
}

/**
 * Breadcrumb trail anchored to the left cluster of the status bar. When the
 * trail exceeds {@link COLLAPSE_THRESHOLD} segments we keep the root + last
 * two visible and tuck the middle behind an ellipsis dropdown.
 */
function Breadcrumbs({ root }: { root: string | null }) {
  if (!root) return null;
  const segments = splitPath(root);
  if (segments.length === 0) return null;

  const COLLAPSE_THRESHOLD = 4;
  // Clicking a segment moves both panes: the file tree (setRoot) and the
  // active terminal (cd). The terminal's own OSC 7 / cd-sniffer will then
  // re-confirm the cwd on the next prompt, so the two stay coherent even if
  // the shell rejects the cd.
  const navigate = (p: string) => {
    useFiles.getState().setRoot(p);
    cdActiveTerminal(p);
  };
  const lastIdx = segments.length - 1;
  const collapse = segments.length > COLLAPSE_THRESHOLD;

  return (
    <div
      className="flex min-w-0 items-center gap-1.5"
      aria-label="folder breadcrumbs"
    >
      {!collapse &&
        segments.map((s, i) => (
          <Fragment key={`${i}-${s.path}`}>
            {i > 0 && <Chevron />}
            <BreadcrumbSegment
              label={s.label}
              path={s.path}
              first={i === 0}
              current={i === lastIdx}
              onClick={navigate}
            />
          </Fragment>
        ))}

      {collapse && (
        <>
          <BreadcrumbSegment
            label={segments[0]!.label}
            path={segments[0]!.path}
            first
            onClick={navigate}
          />
          <Chevron />
          <BreadcrumbEllipsis hidden={segments.slice(1, -2)} onPick={navigate} />
          <Chevron />
          <BreadcrumbSegment
            label={segments[lastIdx - 1]!.label}
            path={segments[lastIdx - 1]!.path}
            onClick={navigate}
          />
          <Chevron />
          <BreadcrumbSegment
            label={segments[lastIdx]!.label}
            path={segments[lastIdx]!.path}
            current
            onClick={navigate}
          />
        </>
      )}
    </div>
  );
}

/** Narrow chevron separator between breadcrumb segments. Drawn lighter than
 *  the inter-pill dot so segments read as one continuous trail. */
function Chevron() {
  return (
    <ChevronRight
      size={10}
      strokeWidth={2}
      className="shrink-0 text-fg-subtle/55"
      aria-hidden
    />
  );
}

function BreadcrumbSegment({
  label,
  path,
  first,
  current,
  onClick,
}: {
  label: string;
  path: string;
  first?: boolean;
  current?: boolean;
  onClick: (path: string) => void;
}) {
  // The current (rightmost) segment is rendered as a static span: clicking
  // it would be a no-op anyway, and the visual weight signals "you are here".
  if (current) {
    return (
      <span
        className={cn(
          'inline-flex h-[20px] max-w-[160px] items-center gap-1 rounded-md px-2',
          'font-display text-[10.5px] tracking-tight text-fg-base/95',
          'shadow-[inset_0_0_0_1px_rgba(220,224,232,0.07)]',
        )}
        title={path}
      >
        {first && (
          <Folder
            size={10}
            strokeWidth={2}
            className="shrink-0 text-fg-muted"
            aria-hidden
          />
        )}
        <span className="truncate">{label}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onClick(path)}
      title={path}
      className={cn(
        'group inline-flex h-[20px] max-w-[140px] items-center gap-1 rounded-md px-2',
        'font-display text-[10.5px] tracking-tight text-fg-muted',
        'transition-colors hover:bg-white/[0.06] hover:text-fg-base/95',
        'focus-visible:bg-white/[0.06] focus:outline-none',
      )}
    >
      {first && (
        <Folder
          size={10}
          strokeWidth={2}
          className="shrink-0 text-fg-subtle transition-colors group-hover:text-fg-muted"
          aria-hidden
        />
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * Ellipsis button shown in place of the middle segments when the path is
 * deeper than the visible limit. Opens a portaled, upward-facing dropdown
 * listing the hidden ancestors — same affordance grammar as the AI CLI and
 * shell pickers, so the bar reads as one consistent surface.
 */
function BreadcrumbEllipsis({
  hidden,
  onPick,
}: {
  hidden: PathSegment[];
  onPick: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const vh = window.innerHeight;
      setPos({
        bottom: vh - r.top + 4,
        left: Math.max(8, r.left - 6),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (menuRef.current?.contains(t)) return;
      if (btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Show ${hidden.length} hidden ${hidden.length === 1 ? 'folder' : 'folders'}`}
        title={`${hidden.length} hidden ${hidden.length === 1 ? 'folder' : 'folders'}`}
        className={cn(
          'inline-flex h-[20px] min-w-[22px] items-center justify-center rounded-md px-1.5',
          'font-display text-[11px] leading-none tracking-tight transition-colors',
          'focus:outline-none',
          open
            ? 'bg-accent-soft text-accent-bright shadow-[inset_0_0_0_1px_rgba(220,224,232,0.18)]'
            : 'text-fg-subtle hover:bg-white/[0.06] hover:text-fg-base/95 focus-visible:bg-white/[0.06]',
        )}
      >
        <span className="-mt-px tracking-[1px]">…</span>
      </button>

      {open && pos && typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ position: 'fixed', bottom: pos.bottom, left: pos.left }}
            className="material-sheet z-50 min-w-[200px] max-w-[320px] animate-popover-in overflow-hidden rounded-md shadow-sheet ring-1 ring-white/10"
          >
            <div className="border-b border-white/[0.06] px-3 py-1.5 font-mono text-[9.5px] uppercase tracking-widest text-fg-subtle">
              jump to ancestor
            </div>
            {hidden.map((seg) => (
              <button
                key={seg.path}
                role="menuitem"
                onClick={() => {
                  onPick(seg.path);
                  setOpen(false);
                }}
                title={seg.path}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-display text-[12px] text-fg-base/90 transition-colors hover:bg-white/[0.06]"
              >
                <Folder size={11} strokeWidth={2} className="shrink-0 text-fg-subtle" />
                <span className="flex-1 truncate">{seg.label}</span>
                <ChevronRight
                  size={10}
                  strokeWidth={2}
                  className="shrink-0 text-fg-subtle/60"
                  aria-hidden
                />
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
