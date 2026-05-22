import { useEffect } from 'react';
import { Files, GitBranch } from 'lucide-react';
import { FileTree } from './FileTree';
import { SourceControl } from './SourceControl';
import { isTauri } from '../lib/tauri';
import { useFiles, type SidebarView } from '../state/files';
import { useGit } from '../state/git';
import { cn } from '../lib/cn';

/**
 * Left-rail container that owns the file tree / source control switch. The
 * active panel mounts in the main slot; a compact tab strip at the bottom
 * lets the user flip between the two without leaving the rail.
 */
export function Sidebar() {
  const view = useFiles((s) => s.sidebarView);
  const setView = useFiles((s) => s.setSidebarView);
  const root = useFiles((s) => s.root);
  const refresh = useGit((s) => s.refresh);
  const reset = useGit((s) => s.reset);
  const entries = useGit((s) => s.entries);
  const changeCount = entries.length;
  const conflictCount = entries.reduce(
    (n, e) => (e.kind === 'conflict' ? n + 1 : n),
    0,
  );

  // Single git poller for the whole sidebar — both `SourceControl` and the
  // tab badge subscribe to the same store, so we never poll twice.
  useEffect(() => {
    if (!isTauri || !root) {
      reset();
      return;
    }
    void refresh(root);
    const id = window.setInterval(() => void refresh(root), 4000);
    return () => window.clearInterval(id);
  }, [refresh, reset, root]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="min-h-0 flex-1">
        {view === 'files' ? <FileTree /> : <SourceControl />}
      </div>
      <SidebarTabs
        view={view}
        onSelect={setView}
        sourceControlCount={changeCount}
        sourceControlConflicts={conflictCount}
      />
    </div>
  );
}

function SidebarTabs({
  view,
  onSelect,
  sourceControlCount,
  sourceControlConflicts,
}: {
  view: SidebarView;
  onSelect: (v: SidebarView) => void;
  sourceControlCount: number;
  sourceControlConflicts: number;
}) {
  return (
    <div
      role="tablist"
      aria-label="Sidebar panel"
      className="flex h-9 shrink-0 items-center justify-evenly gap-1 border-t border-border-hairline bg-bg-chrome/40 px-2"
    >
      <SidebarTab
        active={view === 'files'}
        onClick={() => onSelect('files')}
        label="Files"
        title="File tree"
      >
        <Files size={13} strokeWidth={2} />
      </SidebarTab>
      <SidebarTab
        active={view === 'source-control'}
        onClick={() => onSelect('source-control')}
        label="Source Control"
        title={
          sourceControlCount > 0
            ? sourceControlConflicts > 0
              ? `Source control — ${sourceControlCount} change${
                  sourceControlCount === 1 ? '' : 's'
                } · ${sourceControlConflicts} conflict${
                  sourceControlConflicts === 1 ? '' : 's'
                }`
              : `Source control — ${sourceControlCount} change${
                  sourceControlCount === 1 ? '' : 's'
                }`
            : 'Source control'
        }
        badge={sourceControlCount}
        badgeTone={
          sourceControlConflicts > 0 ? 'conflict' : 'default'
        }
      >
        <GitBranch size={13} strokeWidth={2} />
      </SidebarTab>
    </div>
  );
}

type BadgeTone = 'default' | 'conflict';

function SidebarTab({
  active,
  onClick,
  label,
  title,
  badge,
  badgeTone = 'default',
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title: string;
  badge?: number;
  badgeTone?: BadgeTone;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      type="button"
      aria-selected={active}
      onClick={onClick}
      title={title}
      className={cn(
        'group relative flex h-6 flex-1 items-center justify-center gap-1.5 rounded-md font-display text-[11px] tracking-tight transition-colors',
        active
          ? 'bg-accent-soft text-accent-bright shadow-[inset_0_0_0_1px_rgba(220,224,232,0.18)]'
          : 'text-fg-muted hover:bg-white/[0.06] hover:text-fg-base/95',
      )}
    >
      {children}
      <span>{label}</span>
      <CountBadge value={badge ?? 0} active={active} tone={badgeTone} />
      {active && (
        <span
          aria-hidden
          className="pointer-events-none absolute -top-[5px] left-1/2 h-[2px] w-3 -translate-x-1/2 rounded-full bg-accent-bright/85 shadow-glow-sm"
        />
      )}
    </button>
  );
}

/**
 * Tab count badge. A precision-shaped numeric chip — hairline ring + tabular
 * mono numerals — that takes one of three tones:
 *
 *   default  · subtle, blends with the inactive tab chrome
 *   active   · accent-tinted with a soft glow when the tab itself is selected
 *   conflict · status-err tint with a slow pulse halo, used when any change
 *              in the workspace is a merge conflict (the highest-priority
 *              signal in a source-control panel — earns the visual urgency)
 */
function CountBadge({
  value,
  active,
  tone,
}: {
  value: number;
  active: boolean;
  tone: BadgeTone;
}) {
  if (value <= 0) return null;
  const isConflict = tone === 'conflict';
  return (
    <span
      aria-label={
        isConflict ? `${value} changes including conflicts` : `${value} changes`
      }
      className={cn(
        'relative inline-flex h-[15px] min-w-[16px] items-center justify-center rounded-full px-[5px]',
        'font-mono text-[9.5px] font-semibold leading-none tabular-nums tracking-[0.01em]',
        'ring-1 ring-inset transition-[background-color,color,box-shadow] duration-200 ease-out',
        isConflict
          ? 'bg-status-err/15 text-status-err ring-status-err/35'
          : active
            ? 'bg-accent-bright/15 text-accent-bright ring-accent-bright/30 shadow-[0_0_0_1px_rgba(120,200,255,0.04),0_0_8px_-2px_rgba(120,200,255,0.4)]'
            : 'bg-white/[0.06] text-fg-base/85 ring-white/[0.06] group-hover:bg-white/[0.10] group-hover:text-fg-base group-hover:ring-white/[0.10]',
      )}
    >
      {isConflict && (
        <span
          aria-hidden
          className="pointer-events-none absolute -inset-[2px] animate-pulse-soft rounded-full bg-status-err/12"
        />
      )}
      <span className="relative">{value > 99 ? '99+' : value}</span>
    </span>
  );
}
