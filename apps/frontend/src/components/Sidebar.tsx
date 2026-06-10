import { useEffect } from 'react';
import { FileTree } from './FileTree';
import { SourceControl } from './SourceControl';
import { SshPanel } from './ssh/SshPanel';
import { fsWatchStart, fsWatchStop, isTauri } from '../lib/tauri';
import { useFiles, type SidebarView } from '../state/files';
import { useGit } from '../state/git';
import { SIDEBAR_VIEWS } from '../lib/sidebarViews';
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
      />
      {/* Body — cross-fades on switch. `key` re-mounts the active view so the
          view-in animation replays each time, while absolute positioning keeps
          the swap from reflowing the rail above. */}
      <div className="relative min-h-0 flex-1">
        <div key={view} className="absolute inset-0 flex min-h-0 flex-col animate-view-in">
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

function SidebarRail({
  view,
  onSelect,
  gitCount,
  gitConflicts,
}: {
  view: SidebarView;
  onSelect: (view: SidebarView) => void;
  gitCount: number;
  gitConflicts: number;
}) {
  return (
    <div
      role="tablist"
      aria-label="Sidebar views"
      className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border-hairline px-1.5"
    >
      {SIDEBAR_VIEWS.map(({ id, label, Icon }) => {
        const active = view === id;
        const showBadge = id === 'git' && gitCount > 0;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={label}
            title={label}
            onClick={() => onSelect(id)}
            className={cn(
              'group relative flex h-[22px] items-center overflow-hidden rounded-md outline-none',
              'transition-all duration-[260ms] ease-out-soft active:scale-[0.97]',
              'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/40',
              active
                ? 'bg-white/[0.06] px-1.5 text-accent-bright ring-1 ring-inset ring-accent/15 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]'
                : 'w-[22px] justify-center text-fg-muted hover:bg-white/[0.045] hover:text-fg-base',
            )}
          >
            {/* Top highlight on the active pill — same lift the toolbars use. */}
            {active && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-1.5 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.16] to-transparent"
              />
            )}
            <span className="relative flex h-3 w-3 shrink-0 items-center justify-center">
              <Icon
                size={11}
                strokeWidth={2}
                className={cn(
                  'transition-transform duration-[260ms] ease-out-soft',
                  active && 'scale-[1.05]',
                )}
              />
              {showBadge && (
                <span
                  aria-hidden
                  className={cn(
                    'pointer-events-none absolute -right-0.5 -top-0.5 h-[5px] w-[5px] rounded-full ring-1 ring-bg-chrome',
                    gitConflicts > 0
                      ? 'bg-status-err animate-pulse-soft'
                      : 'bg-accent-bright',
                  )}
                />
              )}
            </span>
            {/* Label reveal — grid-cols 0fr→1fr tweens the width so the pill
                grows smoothly; the inner span clips the text while it animates. */}
            <span
              className={cn(
                'grid transition-all duration-[260ms] ease-out-soft',
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
