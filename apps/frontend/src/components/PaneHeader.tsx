import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  FileCode,
  GitBranch,
  GitCompare,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Monitor,
  PanelBottom,
  PanelRight,
  Send,
  Server,
  Terminal as TerminalIcon,
  X,
  type LucideIcon,
} from 'lucide-react';
import { findLeaf, useWorkspace, type Tab } from '../state/workspace';
import { gitStatus, isTauri } from '../lib/tauri';
import { Tooltip } from './Tooltip';
import { cn } from '../lib/cn';

// Below this header width, the split/maximize buttons collapse into a "⋯"
// overflow menu so they never overlap the title.
const COMPACT_BELOW = 300;

interface OverflowAction {
  key: string;
  label: string;
  Icon: LucideIcon;
  run: () => void;
}

interface Props {
  paneId: string;
}

function iconForKind(kind: Tab['kind']): LucideIcon {
  switch (kind) {
    case 'terminal':
      return TerminalIcon;
    case 'preview':
      return Monitor;
    case 'apiclient':
      return Send;
    case 'ssh':
      return Server;
    case 'diff':
      return GitCompare;
    default:
      return FileCode;
  }
}

/**
 * Single-terminal pane header (tiling model — one terminal per pane). Shows a
 * running/idle status dot, a `name · folder` title, the cwd's git branch, and
 * split / maximize / close controls. Replaces the old multi-tab strip.
 */
export function PaneHeader({ paneId }: Props) {
  const leaf = useWorkspace((s) => findLeaf(s.layout, paneId));
  const tabs = useWorkspace((s) => s.tabs);
  const focusedPaneId = useWorkspace((s) => s.focusedPaneId);
  const maximizedPaneId = useWorkspace((s) => s.maximizedPaneId);
  const running = useWorkspace((s) => (leaf?.activeTabId ? !!s.tabRunning[leaf.activeTabId] : false));
  const setFocusedPane = useWorkspace((s) => s.setFocusedPane);
  const setActive = useWorkspace((s) => s.setActive);
  const closeTab = useWorkspace((s) => s.closeTab);
  const splitPane = useWorkspace((s) => s.splitPane);
  const toggleMaximizePane = useWorkspace((s) => s.toggleMaximizePane);

  const tab = leaf?.activeTabId ? tabs.find((t) => t.id === leaf.activeTabId) ?? null : null;
  const branch = useBranch(tab?.kind === 'terminal' ? tab.cwd : undefined);

  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => {
      const wide = el.getBoundingClientRect().width >= COMPACT_BELOW;
      setCompact(!wide);
      if (wide) setMenuAnchor(null); // close the popover once controls fit again
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  if (!leaf || !tab) return null;

  const isFocused = paneId === focusedPaneId;
  const isMaximized = maximizedPaneId === paneId;
  const closable = tabs.length > 1;
  const folder = tab.cwd ? basename(tab.cwd) : null;
  const Icon = iconForKind(tab.kind);

  const overflow: OverflowAction[] = [
    {
      key: 'split-right',
      label: 'Split right',
      Icon: PanelRight,
      run: () => {
        setFocusedPane(paneId);
        void splitPane(tab.id, 'horizontal');
      },
    },
    {
      key: 'split-down',
      label: 'Split down',
      Icon: PanelBottom,
      run: () => {
        setFocusedPane(paneId);
        void splitPane(tab.id, 'vertical');
      },
    },
    {
      key: 'maximize',
      label: isMaximized ? 'Restore pane' : 'Maximize pane',
      Icon: isMaximized ? Minimize2 : Maximize2,
      run: () => toggleMaximizePane(paneId),
    },
  ];

  return (
    <div
      ref={rootRef}
      data-tauri-drag-region="false"
      onMouseDown={() => {
        setFocusedPane(paneId);
        setActive(tab.id);
      }}
      className={cn(
        'flex h-9 shrink-0 items-center gap-2 border-b px-2.5',
        isFocused
          ? 'border-border-hairline bg-bg-chrome/40'
          : 'border-border-hairline/60 bg-transparent',
      )}
    >
      {/* Running/idle status dot. */}
      <span
        aria-hidden
        title={running ? 'Running' : 'Idle'}
        className={cn(
          'h-[7px] w-[7px] shrink-0 rounded-full transition-colors duration-200',
          running
            ? 'animate-pulse-soft bg-emerald-400 shadow-[0_0_6px_theme(colors.emerald.400)]'
            : isFocused
              ? 'bg-fg-muted'
              : 'bg-fg-subtle',
        )}
      />

      <Icon
        size={12}
        strokeWidth={2}
        className={cn('shrink-0', isFocused ? 'text-accent-bright' : 'text-fg-subtle')}
      />

      {/* name · folder */}
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate font-display text-sm font-medium tracking-tight text-fg-base/90">
          {tab.title}
        </span>
        {folder && (
          <span className="shrink-0 truncate font-display text-xs text-fg-subtle">
            · {folder}
          </span>
        )}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1 pl-1">
        {/* Branch pill only when there's room — it's the first thing to yield. */}
        {branch && !compact && (
          <span
            className="flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-fg-muted"
            title={`On branch ${branch}`}
          >
            <GitBranch size={9} strokeWidth={2.2} className="shrink-0" />
            <span className="max-w-[96px] truncate">{branch}</span>
          </span>
        )}

        {/* Wide: split-right, split-down, maximize inline. Narrow: collapse them
            into a "⋯" overflow popover so they never overlap the title. */}
        {compact ? (
          <button
            type="button"
            aria-label="More actions"
            title="Split, maximize and close this pane"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              setMenuAnchor((m) => (m ? null : { x: r.right, y: r.bottom + 4 }));
            }}
            className={cn(
              'flex h-[22px] w-[22px] items-center justify-center rounded transition-colors hover:bg-surface-3 hover:text-fg-base',
              menuAnchor ? 'bg-surface-3 text-fg-base' : 'text-fg-subtle',
            )}
          >
            <MoreHorizontal size={14} strokeWidth={2} />
          </button>
        ) : (
          overflow.map((a) => (
            <HeaderButton key={a.key} label={a.label} onClick={a.run}>
              <a.Icon size={13} strokeWidth={2} />
            </HeaderButton>
          ))
        )}

        {closable && (
          <HeaderButton label="Close pane" onClick={() => closeTab(tab.id)}>
            <X size={13} strokeWidth={2.2} />
          </HeaderButton>
        )}
      </div>

      {menuAnchor && (
        <OverflowMenu
          x={menuAnchor.x}
          y={menuAnchor.y}
          branch={branch}
          actions={overflow}
          onClose={() => setMenuAnchor(null)}
        />
      )}
    </div>
  );
}

/** Popover of the collapsed header actions. Portaled to the body so it escapes
 *  the pane's `overflow-hidden`, right-aligned to the "⋯" button. */
function OverflowMenu({
  x,
  y,
  branch,
  actions,
  onClose,
}: {
  x: number;
  y: number;
  branch: string | null;
  actions: OverflowAction[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onDown = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const t = setTimeout(() => {
      window.addEventListener('mousedown', onDown);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const WIDTH = 184;
  const left = Math.max(8, x - WIDTH);
  return createPortal(
    <div
      role="menu"
      style={{ position: 'fixed', top: y, left, width: WIDTH }}
      className="material-sheet z-[60] animate-popover-in overflow-hidden rounded-md bg-bg-panel py-1 shadow-sheet ring-1 ring-edge-2"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {branch && (
        <div className="flex items-center gap-1.5 px-3 pb-1 pt-0.5 font-mono text-2xs text-fg-subtle">
          <GitBranch size={9} strokeWidth={2.2} className="shrink-0" />
          <span className="truncate">{branch}</span>
        </div>
      )}
      {actions.map((a) => (
        <button
          key={a.key}
          role="menuitem"
          onClick={() => {
            a.run();
            onClose();
          }}
          className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left font-display text-sm text-fg-base/90 transition-colors hover:bg-surface-2"
        >
          <a.Icon size={13} strokeWidth={2} className="shrink-0 text-fg-subtle" />
          <span className="flex-1 truncate">{a.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

function HeaderButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className="flex h-[22px] w-[22px] items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg-base"
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** Last path segment, forward or back slashes. */
function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

// cwd → branch, cached so panes sharing a repo don't each re-query.
const branchCache = new Map<string, string | null>();

function useBranch(cwd: string | undefined): string | null {
  const [branch, setBranch] = useState<string | null>(cwd ? branchCache.get(cwd) ?? null : null);
  useEffect(() => {
    if (!isTauri || !cwd) {
      setBranch(null);
      return;
    }
    const cached = branchCache.get(cwd);
    if (cached !== undefined) setBranch(cached);
    let cancelled = false;
    void gitStatus(cwd)
      .then((info) => {
        if (cancelled) return;
        const b = info?.branch ?? null;
        branchCache.set(cwd, b);
        setBranch(b);
      })
      .catch(() => {
        if (!cancelled) setBranch(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);
  return branch;
}
