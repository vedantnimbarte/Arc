import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, GitBranch, Keyboard, Sparkles } from 'lucide-react';
import {
  gitStatus,
  isTauri,
  ptyListAiClis,
  type AiCliInfo,
  type GitInfo,
} from '../lib/tauri';
import { useWorkspace } from '../state/workspace';
import { useFiles } from '../state/files';
import { cn } from '../lib/cn';
import { formatBinding, getBinding } from '../state/shortcuts';
import { BranchPicker } from './BranchPicker';

interface Props {
  chatOpen: boolean;
  onToggleChat: () => void;
  onOpenShortcuts: () => void;
}

export function StatusBar({ chatOpen, onToggleChat, onOpenShortcuts }: Props) {
  const tabs = useWorkspace((s) => s.tabs);
  const active = useWorkspace((s) => s.activeTabId);
  const launchAiCli = useWorkspace((s) => s.launchAiCli);
  const root = useFiles((s) => s.root);

  const [git, setGit] = useState<GitInfo | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const refreshGit = useCallback(() => {
    if (!isTauri || !root) {
      setGit(null);
      return () => {};
    }
    let cancelled = false;
    void gitStatus(root)
      .then((info) => {
        if (!cancelled) setGit(info);
      })
      .catch(() => {
        if (!cancelled) setGit(null);
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  useEffect(() => refreshGit(), [refreshGit]);

  return (
    <>
      <footer
        className={cn(
          'flex h-6 shrink-0 items-center justify-between px-3.5',
          'border-t border-border-hairline bg-bg-chrome/60 backdrop-blur-md',
          'font-display text-[10.5px] tracking-tight text-fg-muted',
        )}
      >
        <div className="flex items-center gap-3.5">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                'h-[6px] w-[6px] rounded-full',
                isTauri
                  ? 'bg-status-ok shadow-[0_0_8px_rgba(58,210,138,0.7)]'
                  : 'bg-status-warn shadow-[0_0_8px_rgba(240,169,88,0.6)]',
              )}
            />
            <span className={isTauri ? 'text-fg-base/85' : 'text-status-warn'}>
              {isTauri ? 'connected' : 'web preview'}
            </span>
          </div>
          <span className="text-fg-subtle">·</span>
          <span className="font-mono text-[10px] text-fg-subtle">arc 0.0.1</span>
        </div>

        <div className="flex items-center gap-3.5">
          {git?.branch && (
            <BranchIndicator
              info={git}
              onClick={() => setPickerOpen(true)}
            />
          )}
          {git?.branch && <span className="text-fg-subtle">·</span>}
          <span className="tabular-nums">
            {tabs.length} {tabs.length === 1 ? 'tab' : 'tabs'}
          </span>
          <span className="text-fg-subtle">·</span>
          <span className="max-w-[220px] truncate font-mono text-[10px] text-fg-subtle">
            {active ?? '—'}
          </span>
          <span className="text-fg-subtle">·</span>

          {/* Trailing control cluster — all three pills share the same
              -my-1 trick so they hug the status bar's 24px chrome without
              overflowing it, and the same accent-soft "active" tint. */}
          <div className="flex items-center gap-0.5">
            <StatusIconButton
              onClick={onOpenShortcuts}
              ariaLabel="Keyboard shortcuts"
              title={`Keyboard shortcuts (${formatBinding(getBinding('open-shortcuts'))})`}
            >
              <Keyboard size={11} strokeWidth={2} />
            </StatusIconButton>

            <AiCliButton onLaunch={launchAiCli} />

            <button
              type="button"
              onClick={onToggleChat}
              aria-label={chatOpen ? 'Close assistant' : 'Open assistant'}
              aria-pressed={chatOpen}
              title="Assistant"
              className={cn(
                'group relative -my-1 flex h-5 items-center gap-1.5 rounded-md px-1.5 transition-colors',
                chatOpen
                  ? 'bg-accent-soft text-accent-bright shadow-[inset_0_0_0_1px_rgba(220,224,232,0.18)]'
                  : 'text-fg-muted hover:bg-white/[0.06] hover:text-fg-base/95 focus-visible:bg-white/[0.06] focus:outline-none',
              )}
            >
              <Sparkles
                size={11}
                strokeWidth={2}
                className={cn(
                  'transition-transform duration-300 ease-apple',
                  chatOpen && 'scale-110 drop-shadow-[0_0_6px_rgba(220,224,232,0.6)]',
                )}
              />
              <span className="font-display text-[10px] tracking-tight">assistant</span>
              {chatOpen && (
                <span
                  className="pointer-events-none absolute -bottom-[3px] left-1/2 h-[2px] w-3 -translate-x-1/2 rounded-full bg-accent-bright/85 shadow-glow-sm"
                  aria-hidden
                />
              )}
            </button>
          </div>
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

/** Square icon button sized to fit inside the 24px status bar chrome. */
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
        'group relative -my-1 flex h-5 w-5 items-center justify-center rounded-md transition-colors focus:outline-none',
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
        'group flex items-center gap-1.5 rounded-md font-mono text-[10px]',
        '-mx-1 px-1 py-[1px] transition-colors',
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
