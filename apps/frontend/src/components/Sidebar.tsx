import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { FileTree } from './FileTree';
import { RemoteWorkspaceBar } from './RemoteWorkspaceBar';
import { SourceControl } from './SourceControl';
import { SearchView } from './SearchView';
import { OutlineView } from './OutlineView';
import { WingmanPanel } from './wingman/WingmanPanel';
import { ClaudePanel } from './claude/ClaudePanel';
import { SshPanel } from './ssh/SshPanel';
import { fsReveal, fsWatchStart, fsWatchStop, isTauri, settingsWindowOpen } from '../lib/tauri';
import { useFiles, type SidebarView } from '../state/files';
import { useGit } from '../state/git';
import { useGitUi } from '../state/gitUi';
import { useSsh } from '../state/ssh';
import { useSidebarLayout } from '../state/sidebarLayout';
import {
  PINNED_VIEW,
  resolveRailViews,
  SIDEBAR_VIEW_BY_ID,
} from '../lib/sidebarViews';
import { formatBinding, getBinding } from '../state/shortcuts';
import { cn } from '../lib/cn';

/**
 * The sidebar panel body — whichever view `SidebarRail` (the vertical strip
 * on the window's right edge) has selected. The body cross-fades on switch.
 *
 * We keep the git poller here so every view shares one cache.
 */
export function Sidebar() {
  const view = useFiles((s) => s.sidebarView);
  const setSidebarView = useFiles((s) => s.setSidebarView);
  const root = useFiles((s) => s.root);
  const refresh = useGit((s) => s.refresh);
  const reset = useGit((s) => s.reset);

  // Single git refresh driver for the whole sidebar — both `SourceControl`
  // and the FileTree header badge subscribe to the same store, so the work
  // happens once. A recursive fs watcher (which also sees `.git/` churn —
  // staging, commits, checkouts) refreshes near-instantly; a slow interval
  // backstops changes the OS watcher can miss (network drives, atomic-rename
  // saves).
  useEffect(() => {
    if (!isTauri || !root) {
      reset();
      return;
    }
    let active = true;
    let unlisten: (() => void) | null = null;
    let watchId: string | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    void refresh(root);

    // Coalesce a burst of fs events (git writes many `.git/*` files at once)
    // into a single refresh shortly after they settle.
    const onChange = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(root), 400);
    };
    void fsWatchStart(root, onChange)
      .then((res) => {
        if (!active) {
          res.unlisten();
          void fsWatchStop(res.watchId);
          return;
        }
        watchId = res.watchId;
        unlisten = res.unlisten;
      })
      .catch(() => {
        /* Watcher unavailable; the backstop poll still keeps status fresh. */
      });

    const pollId = window.setInterval(() => void refresh(root), 20_000);

    return () => {
      active = false;
      if (debounce) clearTimeout(debounce);
      window.clearInterval(pollId);
      unlisten?.();
      if (watchId) void fsWatchStop(watchId);
    };
  }, [refresh, reset, root]);

  // Body — cross-fades on switch. `key` re-mounts the active view so the
  // view-in animation replays each time.
  return (
    <div
      key={view}
      id={SIDEBAR_PANEL_ID}
      role="tabpanel"
      aria-labelledby={tabId(view)}
      className="flex h-full min-h-0 min-w-0 flex-col animate-view-in motion-reduce:animate-none"
    >
      {/* Which machine the tree is showing, above every view that can act on
          it. Saving to the wrong host is not a recoverable mistake, so this
          is not tucked into a menu. Renders nothing when local. */}
      <RemoteWorkspaceBar />
      {view === 'files' ? (
        <FileTree />
      ) : view === 'git' ? (
        <SourceControl />
      ) : view === 'search' ? (
        <SearchView />
      ) : view === 'outline' ? (
        <OutlineView />
      ) : view === 'wingman' ? (
        <WingmanPanel />
      ) : view === 'claude' ? (
        <ClaudePanel />
      ) : (
        <SshPanel onClose={() => setSidebarView('files')} />
      )}
    </div>
  );
}

// ── Rail helpers ────────────────────────────────────────────────────────────

const SIDEBAR_PANEL_ID = 'sidebar-view-panel';
const tabId = (view: SidebarView) => `sidebar-tab-${view}`;

/** Status dot shown on a rail item, or null when the view is quiet. */
function railBadge(
  id: SidebarView,
  gitCount: number,
  gitConflicts: number,
  sshLive: number,
): { color: string; pulse: boolean; title: string } | null {
  if (id === 'git' && gitCount > 0) {
    return gitConflicts > 0
      ? { color: 'bg-status-err', pulse: true, title: `${gitConflicts} conflict${gitConflicts === 1 ? '' : 's'}` }
      : { color: 'bg-accent-bright', pulse: false, title: `${gitCount} change${gitCount === 1 ? '' : 's'}` };
  }
  if (id === 'ssh' && sshLive > 0) {
    return { color: 'bg-status-ok', pulse: true, title: `${sshLive} live session${sshLive === 1 ? '' : 's'}` };
  }
  return null;
}

// ── Activity rail ────────────────────────────────────────────────────────────

/**
 * Vertical icon strip pinned to the window's right edge — the mirror of the
 * workspace rail on the left. Clicking an icon reveals that view in the panel
 * to its left; the rail stays put when the panel collapses (⌘B), so there is
 * always a way back. Icon-only by design: the active view is marked by a
 * ribbon and named in its tooltip.
 */
export function SidebarRail() {
  const view = useFiles((s) => s.sidebarView);
  const show = useFiles((s) => s.showSidebarView);
  const setSidebarView = useFiles((s) => s.setSidebarView);
  const gitCount = useGit((s) => s.entries.length);
  const gitConflicts = useGit((s) =>
    s.entries.reduce((n, e) => (e.kind === 'conflict' ? n + 1 : n), 0),
  );
  const sshLive = useSsh((s) => Object.keys(s.liveByHost).length);
  const order = useSidebarLayout((s) => s.order);
  const hidden = useSidebarLayout((s) => s.hidden);
  const views = useMemo(() => resolveRailViews(order, hidden), [order, hidden]);
  const menu = useRailMenu();
  const btnRefs = useRef(new Map<SidebarView, HTMLButtonElement | null>());

  // If the active view gets hidden (via Settings / context menu), fall back to
  // the Explorer so the rail always has a highlighted, reachable item. Uses
  // `setSidebarView`, not `show`, so a hidden view can't force a collapsed
  // panel back open.
  useEffect(() => {
    if (!views.some((v) => v.id === view)) setSidebarView(PINNED_VIEW);
  }, [views, view, setSidebarView]);

  // Arrow-key navigation with automatic activation — the standard ARIA tabs
  // pattern. Up/Down (and Left/Right) wrap; Home/End jump to the ends.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const len = views.length;
    if (len === 0) return;
    const idx = views.findIndex((v) => v.id === view);
    let next = idx < 0 ? 0 : idx;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        next = (next + 1) % len;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        next = (next - 1 + len) % len;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = len - 1;
        break;
      default:
        return;
    }
    const nextView = views[next];
    if (!nextView) return;
    e.preventDefault();
    show(nextView.id);
    btnRefs.current.get(nextView.id)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-orientation="vertical"
      aria-label="Sidebar views"
      onKeyDown={onKeyDown}
      className="flex h-full w-full flex-col items-center gap-1 py-2"
    >
      {views.map(({ id, label, Icon, shortcut }) => {
        const active = view === id;
        const badge = railBadge(id, gitCount, gitConflicts, sshLive);
        const binding = shortcut ? getBinding(shortcut) : null;
        return (
          <button
            key={id}
            ref={(el) => btnRefs.current.set(id, el)}
            type="button"
            role="tab"
            id={tabId(id)}
            aria-selected={active}
            aria-controls={SIDEBAR_PANEL_ID}
            aria-label={label}
            tabIndex={active ? 0 : -1}
            title={[label, binding ? formatBinding(binding) : null, badge?.title]
              .filter(Boolean)
              .join(' · ')}
            onClick={() => show(id)}
            onContextMenu={(e) => menu.open(id, e)}
            className={cn(
              'group relative flex h-7 w-7 items-center justify-center rounded-md outline-none',
              'transition-all duration-200 ease-out-soft active:scale-95 motion-reduce:transition-none',
              'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/40',
              active
                ? 'bg-surface-2 text-accent-bright ring-1 ring-inset ring-accent/15 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]'
                : 'text-fg-muted hover:bg-surface-1 hover:text-fg-base',
            )}
          >
            {/* Ribbon marks the active view — on the outer (right) edge, the
                vertical analogue of a top rail's underline. */}
            {active && (
              <span
                aria-hidden
                className="pointer-events-none absolute -right-2 top-1/2 h-3.5 w-[2px] -translate-y-1/2 rounded-l-full bg-accent-bright/70"
              />
            )}
            <Icon size={13} strokeWidth={2} />
            {badge && (
              <span
                aria-hidden
                title={badge.title}
                className={cn(
                  'pointer-events-none absolute right-1 top-1 h-[5px] w-[5px] rounded-full ring-1 ring-bg-chrome',
                  badge.color,
                  badge.pulse && 'animate-pulse-soft motion-reduce:animate-none',
                )}
              />
            )}
          </button>
        );
      })}
      {menu.node}
    </div>
  );
}

// ── Rail context menu ────────────────────────────────────────────────────────

type RailMenuItem =
  | { separator: true }
  | { separator?: false; label: string; onClick: () => void };

const revealLabel = () =>
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
    ? 'Reveal in Finder'
    : 'Reveal in Explorer';

/** Per-view quick actions — the contextual top of the menu. */
function railQuickActions(view: SidebarView): RailMenuItem[] {
  switch (view) {
    case 'files': {
      const collapsed = useFiles.getState().collapsed;
      return [
        {
          label: revealLabel(),
          onClick: () => {
            const root = useFiles.getState().root;
            if (root && isTauri) void fsReveal(root);
          },
        },
        {
          label: collapsed ? 'Expand Sidebar' : 'Collapse Sidebar',
          onClick: () => useFiles.getState().toggleCollapsed(),
        },
      ];
    }
    case 'git':
      return [
        { label: 'Pull Requests', onClick: () => useGitUi.getState().openPrList() },
        { label: 'Worktrees', onClick: () => useGitUi.getState().setWorktreePanelOpen(true) },
        { label: 'Rebase', onClick: () => useGitUi.getState().setRebasePanelOpen(true) },
      ];
    case 'ssh':
      return [
        {
          label: 'Manage Hosts',
          onClick: () => {
            useFiles.getState().showSidebarView('ssh');
            useSsh.getState().setPanelTab('hosts');
          },
        },
        {
          label: 'Manage Keys',
          onClick: () => {
            useFiles.getState().showSidebarView('ssh');
            useSsh.getState().setPanelTab('keys');
          },
        },
      ];
    default:
      return [];
  }
}

/** Full menu = per-view quick actions + shared customization (reorder / hide /
 *  customize). Handlers read stores lazily so the menu doesn't subscribe. */
function railMenuItems(view: SidebarView): RailMenuItem[] {
  const quick = railQuickActions(view);
  const items: RailMenuItem[] = [...quick];
  if (quick.length) items.push({ separator: true });
  items.push({
    label: 'Move Up',
    onClick: () => useSidebarLayout.getState().move(view, -1),
  });
  items.push({
    label: 'Move Down',
    onClick: () => useSidebarLayout.getState().move(view, 1),
  });
  if (view !== PINNED_VIEW) {
    items.push({
      label: `Hide ${SIDEBAR_VIEW_BY_ID[view].label}`,
      onClick: () => useSidebarLayout.getState().setHidden(view, true),
    });
  }
  items.push({
    label: 'Customize Sidebar…',
    onClick: () => {
      if (isTauri) void settingsWindowOpen().catch(() => {});
    },
  });
  return items;
}

/** Shared right-click menu wiring for both rails. `open(view, event)` parks a
 *  menu at the cursor; `node` renders it (a portal, so placement is moot). */
function useRailMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; view: SidebarView } | null>(null);
  const open = (view: SidebarView, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, view });
  };
  const node = menu ? (
    <RailContextMenu {...menu} onClose={() => setMenu(null)} />
  ) : null;
  return { open, node };
}

function RailContextMenu({
  x,
  y,
  view,
  onClose,
}: {
  x: number;
  y: number;
  view: SidebarView;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

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
    const onMouse = (e: globalThis.MouseEvent) => {
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

  const items = railMenuItems(view);

  return createPortal(
    <div
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      aria-label="View actions"
      className="fixed z-[9999] min-w-[172px] rounded-xl border border-edge-2 bg-[#1b1b1d] p-1.5 shadow-2xl shadow-black/70 animate-view-in motion-reduce:animate-none"
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={`sep-${i}`} className="my-1 border-t border-edge-2" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            onClick={() => {
              item.onClick();
              onClose();
            }}
            className="flex w-full items-center rounded-md px-3 py-[5px] font-display text-sm tracking-tight text-fg-base/90 transition-colors duration-100 hover:bg-surface-2 hover:text-fg-base"
          >
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
