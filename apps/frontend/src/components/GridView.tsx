import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Boxes,
  FileCode,
  GitBranch,
  GitCompare,
  Maximize2,
  Minimize2,
  Monitor,
  Send,
  Server,
  Terminal as TerminalIcon,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useWorkspace, type Tab } from '../state/workspace';
import { gitStatus, isTauri } from '../lib/tauri';
import { cn } from '../lib/cn';

interface Props {
  /** Shared host-div registry held by App.tsx — each cell reparents its tab's
   *  host node in, so the PTY/editor React subtree never unmounts. */
  hostsRef: React.MutableRefObject<Map<string, HTMLDivElement>>;
  stageRef: React.RefObject<HTMLDivElement>;
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
 * Auto-balanced grid of every open tab. Each tab is one cell — there is no tab
 * bar. Cells arrange into a near-square grid (cols = ⌈√n⌉) and shrink as more
 * open. A cell can be maximized to fill the whole area. Clicking a cell focuses
 * it (drives the global `activeTabId` that FileTree / StatusBar read).
 */
export function GridView({ hostsRef, stageRef }: Props) {
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const activeWorkspaceId = useWorkspace((s) => s.activeWorkspaceId);
  const workspaces = useWorkspace((s) => s.workspaces);
  const setActive = useWorkspace((s) => s.setActive);
  const closeTab = useWorkspace((s) => s.closeTab);
  const moveTabToWorkspace = useWorkspace((s) => s.moveTabToWorkspace);
  const newTerminal = useWorkspace((s) => s.newTerminal);
  const tabDirty = useWorkspace((s) => s.tabDirty);
  const [maximizedId, setMaximizedId] = useState<string | null>(null);

  // Only this workspace's tabs are cells; the rest stay mounted offscreen.
  const wsTabs = tabs.filter((t) => t.workspaceId === activeWorkspaceId);
  // Drop a stale maximize target if that tab was closed or moved away.
  const maxId = maximizedId && wsTabs.some((t) => t.id === maximizedId) ? maximizedId : null;
  const visible = maxId ? wsTabs.filter((t) => t.id === maxId) : wsTabs;

  const n = Math.max(1, visible.length);
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);

  const requestClose = (tab: Tab) => {
    if (tabs.length <= 1) return; // keep at least one tab in the whole app
    if (tabDirty[tab.id] && !window.confirm(`"${tab.title}" has unsaved changes. Discard them?`)) {
      return;
    }
    if (maximizedId === tab.id) setMaximizedId(null);
    closeTab(tab.id);
  };

  const otherWorkspaces = workspaces.filter((w) => w.id !== activeWorkspaceId);

  if (visible.length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-center">
        <TerminalIcon size={26} strokeWidth={1.5} className="text-fg-subtle" />
        <div className="font-display text-[13px] text-fg-muted">This workspace is empty</div>
        <button
          onClick={() => void newTerminal()}
          className="rounded-md bg-accent/90 px-3 py-1.5 font-display text-[11.5px] font-medium text-bg-base transition-colors hover:bg-accent"
        >
          New terminal
        </button>
      </div>
    );
  }

  return (
    <div
      className="grid h-full w-full gap-1.5 p-1.5"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      }}
    >
      {visible.map((tab) => (
        <GridCell
          key={tab.id}
          tab={tab}
          hostsRef={hostsRef}
          stageRef={stageRef}
          active={tab.id === activeTabId}
          dirty={!!tabDirty[tab.id]}
          closable={tabs.length > 1}
          maximized={!!maxId}
          moveTargets={otherWorkspaces}
          onFocus={() => setActive(tab.id)}
          onClose={() => requestClose(tab)}
          onToggleMax={() => setMaximizedId((m) => (m === tab.id ? null : tab.id))}
          onMoveTo={(wsId) => moveTabToWorkspace(tab.id, wsId)}
        />
      ))}
    </div>
  );
}

function GridCell({
  tab,
  hostsRef,
  stageRef,
  active,
  dirty,
  closable,
  maximized,
  moveTargets,
  onFocus,
  onClose,
  onToggleMax,
  onMoveTo,
}: {
  tab: Tab;
  hostsRef: React.MutableRefObject<Map<string, HTMLDivElement>>;
  stageRef: React.RefObject<HTMLDivElement>;
  active: boolean;
  dirty: boolean;
  closable: boolean;
  maximized: boolean;
  moveTargets: { id: string; name: string }[];
  onFocus: () => void;
  onClose: () => void;
  onToggleMax: () => void;
  onMoveTo: (workspaceId: string) => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Resolve the host during render so the reparent effect re-runs once it
  // exists (App.tsx creates host divs lazily in its render body).
  const host = hostsRef.current.get(tab.id) ?? null;
  const branch = useBranch(tab.kind === 'terminal' ? tab.cwd : undefined);
  const Icon = iconForKind(tab.kind);

  useLayoutEffect(() => {
    const container = contentRef.current;
    const node = host ?? hostsRef.current.get(tab.id);
    if (!container || !node) return;
    if (node.parentElement === container) return;
    container.appendChild(node);
    // xterm can miss the hidden→visible transition — nudge it to re-fit.
    node.dispatchEvent(new CustomEvent('arc:host-shown'));
    return () => {
      // Cell unmounting (closed / maximize hid it): park the host back on the
      // hidden stage so React's portal keeps rendering into it and the PTY
      // survives.
      const stage = stageRef.current;
      if (stage && node.parentElement === container) stage.appendChild(node);
    };
  }, [tab.id, host, hostsRef, stageRef]);

  return (
    <div
      onMouseDown={onFocus}
      className={cn(
        'relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg',
        'bg-bg-base ring-1 transition-shadow duration-150',
        active
          ? 'ring-accent/50 shadow-[0_0_0_1px_rgba(var(--accent),0.25)]'
          : 'ring-border-subtle',
      )}
    >
      {/* Per-cell header — title, git branch, maximize, close. Right-click to
          move the cell to another workspace. */}
      <div
        onContextMenu={(e) => {
          e.preventDefault();
          onFocus();
          if (moveTargets.length > 0) setMenu({ x: e.clientX, y: e.clientY });
        }}
        className={cn(
          'flex h-8 shrink-0 items-center gap-2 border-b px-2.5',
          active ? 'border-border-hairline bg-bg-chrome/40' : 'border-border-hairline/60',
        )}
      >
        <Icon
          size={13}
          strokeWidth={2}
          className={cn('shrink-0', active ? 'text-accent-bright' : 'text-fg-subtle')}
        />
        <span className="min-w-0 flex-1 truncate font-display text-[12px] font-medium tracking-tight text-fg-base/90">
          {tab.title}
        </span>
        {branch && (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-fg-muted"
            title={`On branch ${branch}`}
          >
            <GitBranch size={9} strokeWidth={2.2} className="shrink-0" />
            <span className="max-w-[90px] truncate">{branch}</span>
          </span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleMax();
          }}
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-white/10 hover:text-fg-base"
          aria-label={maximized ? 'Restore cell' : 'Maximize cell'}
          title={maximized ? 'Restore' : 'Maximize'}
        >
          {maximized ? <Minimize2 size={11} strokeWidth={2} /> : <Maximize2 size={11} strokeWidth={2} />}
        </button>
        {closable && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className={cn(
              'relative flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full transition-colors hover:bg-white/15 hover:text-fg-base',
              dirty ? 'text-accent' : 'text-fg-subtle',
            )}
            aria-label={dirty ? 'Close cell (unsaved changes)' : 'Close cell'}
            title="Close"
          >
            {dirty ? (
              <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-glow-sm group-hover:hidden" />
            ) : (
              <X size={11} strokeWidth={2.5} />
            )}
          </button>
        )}
      </div>

      {/* Content slot — the tab's host div is DOM-reparented in here. */}
      <div ref={contentRef} className="relative min-h-0 flex-1" />

      {menu && (
        <MoveMenu
          x={menu.x}
          y={menu.y}
          targets={moveTargets}
          onPick={(wsId) => {
            onMoveTo(wsId);
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/** Right-click popover listing the other workspaces a cell can move into.
 *  Portaled to the body so it escapes the cell's `overflow-hidden`. */
function MoveMenu({
  x,
  y,
  targets,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  targets: { id: string; name: string }[];
  onPick: (workspaceId: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onDown = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // Defer so the opening right-click doesn't immediately dismiss it.
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

  return createPortal(
    <div
      role="menu"
      style={{ position: 'fixed', top: y, left: x }}
      className="material-sheet z-50 w-52 animate-popover-in overflow-hidden rounded-md bg-bg-panel py-1 shadow-sheet ring-1 ring-white/10"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 pb-1 pt-0.5 font-display text-[9.5px] uppercase tracking-wider text-fg-subtle/80">
        Move to workspace
      </div>
      {targets.map((w) => (
        <button
          key={w.id}
          role="menuitem"
          onClick={() => onPick(w.id)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-display text-[12px] text-fg-base/90 transition-colors hover:bg-white/[0.06]"
        >
          <Boxes size={12} strokeWidth={2} className="text-fg-subtle" />
          <span className="flex-1 truncate">{w.name}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

// cwd → branch, cached across cells so panes sharing a repo don't each re-query.
const branchCache = new Map<string, string | null>();

/** Resolve the git branch for a cwd, best-effort. Refetches when cwd changes
 *  (i.e. on `cd`). Null outside Tauri, for non-repo dirs, or before the first
 *  result lands. */
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
