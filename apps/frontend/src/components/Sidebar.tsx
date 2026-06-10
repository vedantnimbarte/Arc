import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { FileTree } from './FileTree';
import { SourceControl } from './SourceControl';
import { SshPanel } from './ssh/SshPanel';
import { fsWatchStart, fsWatchStop, isTauri } from '../lib/tauri';
import { useFiles, type SidebarView } from '../state/files';
import { useGit } from '../state/git';
import { useSsh } from '../state/ssh';
import { SIDEBAR_VIEWS } from '../lib/sidebarViews';
import { formatBinding, getBinding } from '../state/shortcuts';
import { cn } from '../lib/cn';

/**
 * Left-rail container. A compact activity bar across the top switches the
 * body between the Explorer (file tree), Source Control, and SSH — all three
 * now live in this one sidebar rather than a second panel on the right.
 * Inactive items collapse to an icon; the active one expands to icon + label
 * with a soft width/opacity tween, and the body cross-fades on switch.
 *
 * We keep the git poller here so all three views share one cache.
 */
export function Sidebar() {
  const view = useFiles((s) => s.sidebarView);
  const setSidebarView = useFiles((s) => s.setSidebarView);
  const root = useFiles((s) => s.root);
  const refresh = useGit((s) => s.refresh);
  const reset = useGit((s) => s.reset);

  const gitChangeCount = useGit((s) => s.entries.length);
  const gitConflictCount = useGit((s) =>
    s.entries.reduce((n, e) => (e.kind === 'conflict' ? n + 1 : n), 0),
  );
  const sshLiveCount = useSsh((s) => Object.keys(s.liveByHost).length);

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

  return (
    <div className="flex h-full min-w-0 flex-col">
      <SidebarRail
        view={view}
        onSelect={setSidebarView}
        gitCount={gitChangeCount}
        gitConflicts={gitConflictCount}
        sshLive={sshLiveCount}
      />
      {/* Body — cross-fades on switch. `key` re-mounts the active view so the
          view-in animation replays each time, while absolute positioning keeps
          the swap from reflowing the rail above. */}
      <div className="relative min-h-0 flex-1">
        <div
          key={view}
          id={SIDEBAR_PANEL_ID}
          role="tabpanel"
          aria-labelledby={tabId(view)}
          className="absolute inset-0 flex min-h-0 flex-col animate-view-in motion-reduce:animate-none"
        >
          {view === 'files' ? (
            <FileTree />
          ) : view === 'git' ? (
            <SourceControl />
          ) : (
            <SshPanel onClose={() => setSidebarView('files')} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Activity rail ──────────────────────────────────────────────────────────

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

function SidebarRail({
  view,
  onSelect,
  gitCount,
  gitConflicts,
  sshLive,
}: {
  view: SidebarView;
  onSelect: (view: SidebarView) => void;
  gitCount: number;
  gitConflicts: number;
  sshLive: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef(new Map<SidebarView, HTMLButtonElement | null>());
  const [indicator, setIndicator] = useState({ left: 0, width: 0, ready: false });

  const measure = useCallback(() => {
    const cont = containerRef.current;
    const el = btnRefs.current.get(view);
    if (!cont || !el) return;
    const cr = cont.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    setIndicator({ left: er.left - cr.left, width: er.width, ready: true });
  }, [view]);

  // Track the active item's rect while its pill expands/collapses so the
  // single indicator glides + resizes with it. A short rAF loop samples the
  // in-flight CSS transition frame by frame; a ResizeObserver backstops late
  // reflows (font load, sidebar resize). Under reduced motion the items snap,
  // so the first frame lands the indicator at its final spot.
  useLayoutEffect(() => {
    let raf = 0;
    let start = 0;
    const tick = (t: number) => {
      if (!start) start = t;
      measure();
      if (t - start < 340) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const ro = new ResizeObserver(() => measure());
    if (containerRef.current) ro.observe(containerRef.current);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [measure]);

  // Arrow-key navigation with automatic activation — the standard ARIA tabs
  // pattern. Left/Up and Right/Down wrap; Home/End jump to the ends.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const len = SIDEBAR_VIEWS.length;
    const idx = SIDEBAR_VIEWS.findIndex((v) => v.id === view);
    let next = idx;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (idx + 1) % len;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (idx - 1 + len) % len;
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
    const nextView = SIDEBAR_VIEWS[next];
    if (!nextView) return;
    e.preventDefault();
    onSelect(nextView.id);
    btnRefs.current.get(nextView.id)?.focus();
  };

  return (
    <div
      ref={containerRef}
      role="tablist"
      aria-label="Sidebar views"
      onKeyDown={onKeyDown}
      className="relative flex h-8 shrink-0 items-center gap-0.5 border-b border-border-hairline px-1.5"
    >
      {/* Single sliding indicator — the only active background. Its left/width
          are driven live (see measure/rAF) so it glides and resizes to wrap
          whichever item is active. */}
      <span
        aria-hidden
        style={{ left: indicator.left, width: indicator.width }}
        className={cn(
          'pointer-events-none absolute top-1/2 z-0 h-[22px] -translate-y-1/2 rounded-md',
          'bg-white/[0.06] ring-1 ring-inset ring-accent/15 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]',
          'transition-opacity duration-200 motion-reduce:transition-none',
          indicator.ready ? 'opacity-100' : 'opacity-0',
        )}
      >
        <span
          aria-hidden
          className="absolute inset-x-1.5 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.16] to-transparent"
        />
      </span>
      {SIDEBAR_VIEWS.map(({ id, label, Icon }) => {
        const active = view === id;
        const badge = railBadge(id, gitCount, gitConflicts, sshLive);
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
            title={label}
            onClick={() => onSelect(id)}
            className={cn(
              'group relative z-10 flex h-[22px] items-center overflow-hidden rounded-md outline-none',
              'transition-all duration-[260ms] ease-out-soft active:scale-[0.97]',
              'motion-reduce:transition-none',
              'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/40',
              active
                ? 'px-1.5 text-accent-bright'
                : 'w-[22px] justify-center text-fg-muted hover:bg-white/[0.045] hover:text-fg-base',
            )}
          >
            <span className="relative flex h-3 w-3 shrink-0 items-center justify-center">
              <Icon
                size={11}
                strokeWidth={2}
                className={cn(
                  'transition-transform duration-[260ms] ease-out-soft motion-reduce:transition-none',
                  active && 'scale-[1.05]',
                )}
              />
              {badge && (
                <span
                  aria-hidden
                  title={badge.title}
                  className={cn(
                    'pointer-events-none absolute -right-0.5 -top-0.5 h-[5px] w-[5px] rounded-full ring-1 ring-bg-chrome',
                    badge.color,
                    badge.pulse && 'animate-pulse-soft motion-reduce:animate-none',
                  )}
                />
              )}
            </span>
            {/* Label reveal — grid-cols 0fr→1fr tweens the width so the pill
                grows smoothly; the inner span clips the text while it animates. */}
            <span
              className={cn(
                'grid transition-all duration-[260ms] ease-out-soft motion-reduce:transition-none',
                active ? 'ml-1 grid-cols-[1fr] opacity-100' : 'ml-0 grid-cols-[0fr] opacity-0',
              )}
            >
              <span className="overflow-hidden whitespace-nowrap font-display text-[10px] font-medium tracking-tight">
                {label}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── Collapsed mini-rail ──────────────────────────────────────────────────────

/**
 * Vertical icon strip shown when the sidebar is collapsed (⌘B). Clicking an
 * icon expands the sidebar and switches to that view — VS Code-style. Reads
 * its own state so App can mount it standalone in the collapsed slot.
 */
export function SidebarMiniRail() {
  const view = useFiles((s) => s.sidebarView);
  const collapsed = useFiles((s) => s.collapsed);
  const show = useFiles((s) => s.showSidebarView);
  const gitCount = useGit((s) => s.entries.length);
  const gitConflicts = useGit((s) =>
    s.entries.reduce((n, e) => (e.kind === 'conflict' ? n + 1 : n), 0),
  );
  const sshLive = useSsh((s) => Object.keys(s.liveByHost).length);

  return (
    <div
      role="tablist"
      aria-orientation="vertical"
      aria-label="Sidebar views"
      className="flex h-full w-full flex-col items-center gap-1 py-2"
    >
      {SIDEBAR_VIEWS.map(({ id, label, Icon, shortcut }) => {
        const active = view === id;
        const badge = railBadge(id, gitCount, gitConflicts, sshLive);
        const binding = getBinding(shortcut);
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={label}
            // The strip is only interactive while collapsed; once expanded the
            // horizontal rail owns the roving focus.
            tabIndex={collapsed && active ? 0 : -1}
            title={binding ? `${label} · ${formatBinding(binding)}` : label}
            onClick={() => show(id)}
            className={cn(
              'group relative flex h-7 w-7 items-center justify-center rounded-md outline-none',
              'transition-all duration-200 ease-out-soft active:scale-95 motion-reduce:transition-none',
              'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/40',
              active
                ? 'bg-white/[0.06] text-accent-bright ring-1 ring-inset ring-accent/15 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]'
                : 'text-fg-muted hover:bg-white/[0.045] hover:text-fg-base',
            )}
          >
            {/* Left ribbon marks the active view — the vertical analogue of the
                horizontal rail's sliding indicator. */}
            {active && (
              <span
                aria-hidden
                className="pointer-events-none absolute -left-2 top-1/2 h-3.5 w-[2px] -translate-y-1/2 rounded-r-full bg-accent-bright/70"
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
    </div>
  );
}
