import { useState } from 'react';
import { GitMerge, MoreHorizontal } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { GitLogEntry, GitResetMode } from '../../lib/tauri';
import { colorForAuthor } from './AuthorsSidebar';
import { MenuItem, Popover } from './Popover';

interface Props {
  commits: GitLogEntry[];
  emptyHint?: string;
  onCherryPick?: (oid: string) => void;
  /** Open the "Cherry-pick to branch…" dialog for this commit. Distinct
   *  from `onCherryPick`, which lands the commit on the current HEAD. */
  onCherryPickTo?: (commit: GitLogEntry) => void;
  onRevert?: (oid: string) => void;
  onReset?: (oid: string, mode: GitResetMode) => void;
}

export function CommitList({
  commits,
  emptyHint,
  onCherryPick,
  onCherryPickTo,
  onRevert,
  onReset,
}: Props) {
  if (commits.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
        <span className="mb-3 h-10 w-10 rounded-full bg-surface-1 ring-1 ring-edge-1" aria-hidden />
        <p className="font-display text-sm text-fg-subtle">
          {emptyHint ?? 'No commits match the current filters.'}
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-2 py-1.5">
      <ul className="flex flex-col gap-px">
        {commits.map((c) => (
          <CommitRow
            key={c.oid}
            commit={c}
            onCherryPick={onCherryPick}
            onCherryPickTo={onCherryPickTo}
            onRevert={onRevert}
            onReset={onReset}
          />
        ))}
      </ul>
    </div>
  );
}

function CommitRow({
  commit,
  onCherryPick,
  onCherryPickTo,
  onRevert,
  onReset,
}: {
  commit: GitLogEntry;
  onCherryPick?: (oid: string) => void;
  onCherryPickTo?: (commit: GitLogEntry) => void;
  onRevert?: (oid: string) => void;
  onReset?: (oid: string, mode: GitResetMode) => void;
}) {
  const isMerge = commit.parents.length > 1;
  const dotColor = colorForAuthor(commit.author, commit.email);
  const hasActions = onCherryPick || onCherryPickTo || onRevert || onReset;

  return (
    <li
      className={cn(
        'group relative flex cursor-default items-center gap-3 rounded-lg px-3 py-2',
        'transition-all duration-150 hover:bg-surface-1 hover:ring-1 hover:ring-inset hover:ring-edge-1',
      )}
      title={commit.oid}
    >
      <span className="relative flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden>
        <span
          className="absolute h-3 w-3 rounded-full opacity-30 blur-[3px] transition-opacity duration-200 group-hover:opacity-60"
          style={{ background: dotColor }}
        />
        <span
          className="relative h-2 w-2 rounded-full ring-1 ring-bg-base"
          style={{ background: dotColor }}
        />
      </span>
      <span className="shrink-0 rounded-md bg-surface-1 px-1.5 py-[1px] font-mono text-2xs text-fg-muted ring-1 ring-inset ring-edge-1 transition-colors group-hover:bg-surface-2 group-hover:text-fg-base">
        {commit.short}
      </span>
      <span className="min-w-0 flex-1 truncate font-display text-sm text-fg-base">
        {commit.subject || <span className="italic text-fg-subtle">(no subject)</span>}
      </span>
      <DiffStat additions={commit.additions} deletions={commit.deletions} />
      {isMerge && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-1 px-2 py-[1px] font-display text-2xs text-fg-subtle ring-1 ring-inset ring-edge-1">
          <GitMerge size={9} strokeWidth={2.2} />
          Merge
        </span>
      )}

      {/* One menu per row, so the actions read as words, not glyphs. */}
      {hasActions && (
        <Popover
          label="Commit actions"
          trigger={<MoreHorizontal size={13} strokeWidth={2} />}
          triggerClassName="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted opacity-0 transition hover:bg-surface-3 hover:text-fg-base group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
          width={240}
        >
          {(close) => (
            <CommitMenu
              commit={commit}
              close={close}
              onCherryPick={onCherryPick}
              onCherryPickTo={onCherryPickTo}
              onRevert={onRevert}
              onReset={onReset}
            />
          )}
        </Popover>
      )}

      <span
        className="shrink-0 truncate font-display text-xs text-fg-muted"
        title={commit.email}
        style={{ maxWidth: 140 }}
      >
        {commit.author}
      </span>
      <span className="shrink-0 font-mono text-2xs tabular-nums text-fg-subtle">
        {formatRelative(commit.time)}
      </span>
    </li>
  );
}

function CommitMenu({
  commit,
  close,
  onCherryPick,
  onCherryPickTo,
  onRevert,
  onReset,
}: {
  commit: GitLogEntry;
  close: () => void;
  onCherryPick?: (oid: string) => void;
  onCherryPickTo?: (commit: GitLogEntry) => void;
  onRevert?: (oid: string) => void;
  onReset?: (oid: string, mode: GitResetMode) => void;
}) {
  // "Move branch back" is a three-way choice, so it swaps the menu for its
  // options rather than squeezing into a yes/no dialog.
  const [resetStep, setResetStep] = useState(false);
  const run = (fn: () => void) => {
    close();
    fn();
  };

  if (resetStep && onReset) {
    return (
      <>
        <div className="px-2.5 pb-1 pt-1.5 font-display text-2xs text-fg-subtle">
          Move branch back to <span className="font-mono">{commit.short}</span>
        </div>
        <MenuItem hint="Later commits become staged changes" onClick={() => run(() => onReset(commit.oid, 'soft'))}>
          Keep my changes staged
        </MenuItem>
        <MenuItem hint="Later commits become unstaged edits" onClick={() => run(() => onReset(commit.oid, 'mixed'))}>
          Keep my changes unstaged
        </MenuItem>
        <MenuItem danger hint="Later commits and uncommitted edits are lost" onClick={() => run(() => onReset(commit.oid, 'hard'))}>
          Throw away my changes
        </MenuItem>
      </>
    );
  }

  return (
    <>
      {onCherryPick && (
        <MenuItem onClick={() => run(() => onCherryPick(commit.oid))}>Copy onto current branch</MenuItem>
      )}
      {onCherryPickTo && (
        <MenuItem onClick={() => run(() => onCherryPickTo(commit))}>Copy onto another branch…</MenuItem>
      )}
      {onRevert && (
        <MenuItem onClick={() => run(() => onRevert(commit.oid))}>Undo this commit (adds a new commit)</MenuItem>
      )}
      {onReset && <MenuItem onClick={() => setResetStep(true)}>Move branch back to here…</MenuItem>}
    </>
  );
}

function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-2xs tabular-nums">
      {additions > 0 && (
        <span className="rounded px-1 py-[1px] text-status-ok ring-1 ring-inset ring-status-ok/20 bg-status-ok/[0.07]">
          +{additions}
        </span>
      )}
      {deletions > 0 && (
        <span className="rounded px-1 py-[1px] text-status-err ring-1 ring-inset ring-status-err/20 bg-status-err/[0.07]">
          -{deletions}
        </span>
      )}
    </span>
  );
}

/** Compact age for a commit row — shared with the sidebar history panel. */
export function formatRelative(unixSeconds: number): string {
  if (!unixSeconds) return '—';
  const diff = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 30 * 86_400) return `${Math.floor(diff / 86_400)}d`;
  if (diff < 365 * 86_400) return `${Math.floor(diff / (30 * 86_400))}mo`;
  return `${Math.floor(diff / (365 * 86_400))}y`;
}
