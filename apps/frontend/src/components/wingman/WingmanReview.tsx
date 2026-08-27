import { useEffect, useMemo, useState } from 'react';
import {
  Ban,
  ChevronDown,
  ChevronRight,
  FileDiff,
  FolderGit2,
  Inbox,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { reviewQueue, useWingman, type ReviewItem } from '../../state/wingman';
import type { GitChangeEntry } from '../../lib/tauri';

/**
 * Review queue for agent-authored changes.
 *
 * The bottleneck at 4–8 concurrent agents is review, not generation. The board
 * is organised for *dispatching* work — by card, by column; this is the
 * opposite job, so it flattens every card and run into one list of change sets
 * ordered by what needs a decision.
 *
 * Each entry is one agent's git worktree. Expanding lists the files it touched;
 * clicking a file opens ARC's own diff viewer rooted at that worktree, so the
 * diff is against the agent's base rather than the user's checkout. That's the
 * reason this lives in ARC rather than Wingman's web panel — the diff stack is
 * already here.
 */
export function WingmanReview() {
  const status = useWingman((s) => s.status);
  const cards = useWingman((s) => s.cards);
  const loading = useWingman((s) => s.boardLoading);
  const refresh = useWingman((s) => s.refreshBoard);

  const queue = useMemo(() => reviewQueue(cards), [cards]);

  useEffect(() => {
    if (status === 'connected') void refresh();
  }, [status, refresh]);

  if (status !== 'connected') {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center">
        <p className="font-display text-xs text-fg-muted">
          Connect a Wingman daemon in Settings → Wingman to review agent changes.
        </p>
      </div>
    );
  }

  const needsDecision = queue.filter((i) =>
    ['review', 'failed'].includes(i.task.status),
  ).length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-base">
      <div className="flex shrink-0 items-baseline justify-between gap-2 border-b border-border-hairline px-3 py-1.5">
        <div className="flex items-baseline gap-2">
          <span className="font-display text-xs font-medium tracking-tight text-fg-base">
            Review queue
          </span>
          <span className="font-mono text-2xs tabular-nums text-fg-subtle">
            {needsDecision > 0
              ? `${needsDecision} awaiting a decision · ${queue.length} total`
              : `${queue.length} change set${queue.length === 1 ? '' : 's'}`}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          title="Refresh"
          aria-label="Refresh review queue"
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
        >
          <RefreshCw size={11} strokeWidth={2} className={cn(loading && 'animate-spin')} />
        </button>
      </div>

      {queue.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
          <Inbox size={18} strokeWidth={1.6} className="text-fg-subtle" />
          <p className="font-display text-xs text-fg-muted">Nothing to review</p>
          <p className="font-display text-2xs leading-relaxed text-fg-subtle">
            Agent tasks appear here once a pilot run gives them a worktree.
          </p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {queue.map((item) => (
            <ReviewRow key={`${item.cardId}:${item.task.task_id}`} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Colour by whether this entry is waiting on the reviewer. */
function statusTone(status: string): string {
  switch (status) {
    case 'review':
      return 'text-status-warn';
    case 'failed':
      return 'text-status-err';
    case 'done':
      return 'text-status-ok';
    case 'in_progress':
      return 'text-accent-bright';
    default:
      return 'text-fg-subtle';
  }
}

function ReviewRow({ item }: { item: ReviewItem }) {
  const [open, setOpen] = useState(false);
  const changes = useWingman((s) => s.worktreeChanges[item.worktree]);
  const loadChanges = useWingman((s) => s.loadWorktreeChanges);
  const openFile = useWingman((s) => s.openWorktreeFile);
  const openWorktree = useWingman((s) => s.openWorktree);
  const pilotControl = useWingman((s) => s.pilotControl);

  const { task, runId } = item;

  const toggle = () => {
    setOpen((o) => !o);
    if (!open) void loadChanges(item.worktree);
  };

  return (
    <li className="border-b border-border-hairline">
      <div className="flex items-start gap-1.5 px-2 py-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={open ? 'Hide changed files' : 'Show changed files'}
          className="mt-0.5 shrink-0 rounded p-0.5 text-fg-subtle hover:bg-surface-2 hover:text-fg-base"
        >
          {open ? (
            <ChevronDown size={11} strokeWidth={2.2} />
          ) : (
            <ChevronRight size={11} strokeWidth={2.2} />
          )}
        </button>

        <span
          className={cn('mt-1 shrink-0 font-mono text-2xs leading-none', statusTone(task.status))}
          title={task.status}
        >
          ●
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-xs text-fg-base" title={task.title}>
            {task.title}
          </p>
          <p className="truncate font-mono text-2xs text-fg-subtle">
            {[
              item.cardTitle,
              task.agent_name,
              task.model,
              task.usd > 0 ? `$${task.usd.toFixed(2)}` : null,
              task.attempts > 1 ? `${task.attempts} attempts` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {/* The worker's own account of what it did. Often the fastest way to
              decide whether the diff is worth reading line by line. */}
          {task.outcome && (
            <p className="mt-0.5 line-clamp-2 font-display text-2xs leading-relaxed text-fg-muted">
              {task.outcome}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => openWorktree(item.worktree)}
            title="Open this worktree in Source Control"
            aria-label="Open in Source Control"
            className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
          >
            <FolderGit2 size={11} strokeWidth={2} />
          </button>
          {runId && task.status === 'failed' && (
            <button
              type="button"
              onClick={() => void pilotControl(runId, 'retry', task.task_id)}
              title="Re-queue this task"
              aria-label="Retry task"
              className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
            >
              <RotateCcw size={11} strokeWidth={2} />
            </button>
          )}
          {runId && !['done', 'failed'].includes(task.status) && (
            <button
              type="button"
              onClick={() => void pilotControl(runId, 'abort', task.task_id)}
              title="Abort this task"
              aria-label="Abort task"
              className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-status-err"
            >
              <Ban size={11} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>

      {open && <ChangedFiles changes={changes} onOpen={(p) => openFile(item.worktree, p)} />}
    </li>
  );
}

/** Porcelain status letter → a colour. Same vocabulary Source Control uses. */
function changeTone(status: string): string {
  if (status === 'A' || status === '?') return 'text-status-ok';
  if (status === 'D') return 'text-status-err';
  if (status === 'U') return 'text-status-warn';
  return 'text-fg-muted';
}

function ChangedFiles({
  changes,
  onOpen,
}: {
  changes: GitChangeEntry[] | 'loading' | 'missing' | undefined;
  onOpen: (relPath: string) => void;
}) {
  if (changes === undefined || changes === 'loading') {
    return <p className="px-8 pb-2 font-mono text-2xs text-fg-subtle">reading worktree…</p>;
  }
  if (changes === 'missing') {
    // Wingman removes worktrees when a run ends, so this is the normal state
    // for older tasks — not an error, and pointedly not "no changes".
    return (
      <p className="px-8 pb-2 font-mono text-2xs text-fg-subtle">
        worktree no longer on disk — the run has been cleaned up
      </p>
    );
  }
  if (changes.length === 0) {
    // A real outcome: the agent ran and changed nothing.
    return (
      <p className="px-8 pb-2 font-mono text-2xs text-fg-subtle">
        no file changes in this worktree
      </p>
    );
  }
  return (
    <ul className="pb-1">
      {changes.map((c) => (
        <li key={c.path}>
          <button
            type="button"
            onClick={() => onOpen(c.path)}
            title={`Open diff for ${c.path}`}
            className="flex w-full items-center gap-1.5 px-8 py-0.5 text-left transition-colors hover:bg-surface-1"
          >
            <FileDiff size={10} strokeWidth={2} className="shrink-0 text-fg-subtle" />
            <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-muted">
              {c.path}
            </span>
            <span
              className={cn('shrink-0 font-mono text-2xs', changeTone(c.status))}
              title={c.kind}
            >
              {c.status}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
