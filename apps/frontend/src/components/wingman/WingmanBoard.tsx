import { useEffect, useMemo, useState } from 'react';
import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  Inbox,
  Play,
  RefreshCw,
  RotateCcw,
  X,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { reviewQueue, useWingman } from '../../state/wingman';
import { useWorkspace } from '../../state/workspace';

import { WINGMAN_COLUMNS, type WingmanCard, type WingmanSubRow } from '../../lib/tauri';

/**
 * Wingman's pilot board, rendered natively.
 *
 * Cards are durable goals in `~/.wingman/board.db`; columns and roll-ups are
 * derived by the daemon, never stored, so this is a pure renderer — ARC does
 * not re-derive any of it.
 *
 * The review affordance is the point of doing this in ARC rather than in
 * Wingman's own web panel: every finished task carries the worktree it worked
 * in, and ARC can open that worktree's diff in its own viewer. Reviewing agent
 * output is the bottleneck, and this is where ARC's existing git stack pays off.
 */
export function WingmanBoard() {
  const status = useWingman((s) => s.status);
  const cards = useWingman((s) => s.cards);
  const loading = useWingman((s) => s.boardLoading);
  const refresh = useWingman((s) => s.refreshBoard);
  const dispatchCard = useWingman((s) => s.dispatchCard);

  // How many change sets are waiting on a human right now.
  const pending = useMemo(
    () => reviewQueue(cards).filter((i) => ['review', 'failed'].includes(i.task.status)).length,
    [cards],
  );

  useEffect(() => {
    if (status === 'connected') void refresh();
  }, [status, refresh]);

  if (status !== 'connected') {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center">
        <p className="font-display text-xs text-fg-muted">
          Connect a Wingman daemon in Settings → Wingman to see the board.
        </p>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-bg-base">
      <div className="flex shrink-0 items-center justify-between border-b border-border-hairline px-3 py-1.5">
        <span className="font-display text-xs font-medium tracking-tight text-fg-base">
          Pilot board
        </span>
        <div className="flex items-center gap-1">
          {/* The board dispatches work; the queue reviews it. Pending count
              here because "what is waiting on me" is the question you have
              while looking at the board. */}
          <button
            type="button"
            onClick={() => useWorkspace.getState().openWingmanReview()}
            title="Review agent changes"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-2xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base"
          >
            <Inbox size={11} strokeWidth={2} />
            review
            {pending > 0 && (
              <span className="rounded bg-status-warn/15 px-1 tabular-nums text-status-warn">
                {pending}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            title="Refresh"
            aria-label="Refresh board"
            className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
          >
            <RefreshCw size={11} strokeWidth={2} className={cn(loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      <RunDetailOverlay />

      <div className="min-h-0 flex-1 overflow-x-auto">
        <div className="flex h-full min-w-max gap-px bg-border-hairline p-px">
          {WINGMAN_COLUMNS.map((col) => {
            const inCol = cards.filter((c) => c.column === col.id);
            return (
              <section key={col.id} className="flex h-full w-64 flex-col bg-bg-base">
                <header className="flex shrink-0 items-baseline gap-1.5 px-2 py-1.5">
                  <h3 className="font-mono text-2xs uppercase tracking-wider text-fg-muted">
                    {col.label}
                  </h3>
                  <span className="font-mono text-2xs tabular-nums text-fg-subtle">
                    {inCol.length}
                  </span>
                </header>
                <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pb-2">
                  {inCol.map((card) => (
                    <CardView key={card.id} card={card} onDispatch={dispatchCard} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CardView({
  card,
  onDispatch,
}: {
  card: WingmanCard;
  onDispatch: (id: string, again?: boolean) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const openRunDetail = useWingman((s) => s.openRunDetail);
  const subrows = card.rollup?.subrows ?? [];
  const hasRun = Boolean(card.run_id);

  return (
    <article className="rounded-md border border-edge-1 bg-surface-1">
      <div className="flex items-start gap-1 px-1.5 py-1.5">
        {subrows.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={open ? 'Collapse tasks' : 'Expand tasks'}
            className="mt-px shrink-0 rounded p-0.5 text-fg-subtle hover:bg-surface-2 hover:text-fg-base"
          >
            {open ? (
              <ChevronDown size={10} strokeWidth={2.2} />
            ) : (
              <ChevronRight size={10} strokeWidth={2.2} />
            )}
          </button>
        ) : (
          <span className="w-[15px] shrink-0" />
        )}

        <div className="min-w-0 flex-1">
          <p className="font-display text-xs leading-snug text-fg-base">
            {card.title || card.goal || card.short || card.id}
          </p>
          <p className="mt-0.5 flex items-center gap-1 truncate font-mono text-2xs text-fg-subtle">
            <span className="truncate">{card.project_name || card.project}</span>
            {card.run_id && (
              <button
                type="button"
                onClick={() => void openRunDetail(card.run_id!)}
                title="Inspect the full run state"
                className="shrink-0 rounded px-1 text-fg-subtle underline decoration-dotted underline-offset-2 transition-colors hover:bg-surface-2 hover:text-fg-base"
              >
                run
              </button>
            )}
          </p>

          {card.badges.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {card.badges.map((b, i) => (
                <span
                  key={i}
                  className={cn(
                    'rounded px-1 py-px font-mono text-2xs',
                    b.kind === 'cost'
                      ? 'bg-surface-2 tabular-nums text-fg-muted'
                      : b.kind === 'retry'
                        ? 'bg-status-warn/15 text-status-warn'
                        : b.kind === 'progress'
                          ? 'bg-surface-2 tabular-nums text-fg-muted'
                          : 'bg-accent-soft text-fg-muted',
                  )}
                >
                  {b.text}
                </span>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => void onDispatch(card.id, hasRun)}
          // The board's registry can name repos this daemon doesn't serve;
          // dispatching one is a 403, so disable rather than offer it.
          disabled={card.project_missing}
          title={
            card.project_missing
              ? 'This daemon does not serve that project'
              : hasRun
                ? 'Run again'
                : 'Dispatch a pilot run'
          }
          aria-label={hasRun ? 'Run again' : 'Dispatch'}
          className="mt-px shrink-0 rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base disabled:cursor-not-allowed disabled:opacity-40"
        >
          {hasRun ? <RotateCcw size={11} strokeWidth={2} /> : <Play size={11} strokeWidth={2} />}
        </button>
      </div>

      {open && subrows.length > 0 && (
        <div className="border-t border-edge-1 px-1.5 py-1">
          {subrows.map((row) => (
            <SubRowView key={row.task_id} row={row} runId={card.run_id} />
          ))}
        </div>
      )}
    </article>
  );
}

/**
 * Full `RunState` for one run, over the board.
 *
 * The board's sub-rows are a projection; this is the whole record — planner
 * output, per-task timings, attempts, worker outcomes. ARC renders it as
 * formatted JSON rather than a bespoke table on purpose: the shape is
 * Wingman's and it grows, so a hand-built view would silently omit whatever
 * was added last. Showing everything is more useful than showing a curated
 * subset that goes stale.
 */
function RunDetailOverlay() {
  const detail = useWingman((s) => s.runDetail);
  const loading = useWingman((s) => s.runDetailLoading);
  const close = useWingman((s) => s.closeRunDetail);

  useEffect(() => {
    if (!detail) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detail, close]);

  if (!detail) return null;

  return (
    <div
      className="absolute inset-0 z-40 flex items-start justify-center bg-scrim-2 p-8 backdrop-blur-sm"
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="material-sheet flex max-h-full w-[640px] max-w-full animate-sheet-in flex-col overflow-hidden rounded-window shadow-sheet ring-1 ring-edge-2"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border-hairline px-3 py-2">
          <span className="truncate font-mono text-2xs text-fg-muted">{detail.runId}</span>
          <button
            type="button"
            onClick={close}
            title="Close (esc)"
            aria-label="Close run detail"
            className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
          >
            <X size={11} strokeWidth={2.2} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {loading && !detail.state ? (
            <p className="px-3 py-4 font-mono text-2xs text-fg-subtle">loading…</p>
          ) : (
            <pre className="px-3 py-2 font-mono text-2xs leading-relaxed text-fg-muted">
              {JSON.stringify(detail.state, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

/** Status glyph colour per planner-task state. Kept in one place so the board
 *  and any future run detail agree. */
function statusTone(status: string): string {
  switch (status) {
    case 'done':
      return 'text-status-ok';
    case 'failed':
      return 'text-status-err';
    case 'review':
      return 'text-status-warn';
    case 'in_progress':
      return 'text-accent-bright';
    default:
      return 'text-fg-subtle';
  }
}

function SubRowView({ row, runId }: { row: WingmanSubRow; runId: string | null }) {
  const pilotControl = useWingman((s) => s.pilotControl);
  const openWorktree = useWingman((s) => s.openWorktree);

  return (
    <div className="flex items-start gap-1.5 py-1">
      <span className={cn('mt-1 font-mono text-2xs leading-none', statusTone(row.status))}>●</span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-display text-2xs text-fg-muted" title={row.title}>
          {row.title}
        </p>
        <p className="truncate font-mono text-2xs text-fg-subtle">
          {[
            row.agent_name,
            row.model,
            row.usd > 0 ? `$${row.usd.toFixed(2)}` : null,
            row.blocked_by.length ? `dep ${row.blocked_by.join(',')}` : null,
            row.current_tool,
          ]
            .filter(Boolean)
            .join(' · ') || row.status}
        </p>
      </div>

      {/* The review queue: a finished task's worktree opens in ARC's own diff
          viewer. This is the whole reason to render the board here. */}
      {row.worktree && (
        <button
          type="button"
          onClick={() => openWorktree(row.worktree!)}
          title={`Review changes in ${row.worktree}`}
          aria-label="Review this task's changes"
          className="shrink-0 rounded p-0.5 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
        >
          <FolderGit2 size={10} strokeWidth={2} />
        </button>
      )}

      {runId && row.status === 'review' && (
        <button
          type="button"
          onClick={() => void pilotControl(runId, 'approve')}
          title="Approve the pending plan"
          aria-label="Approve"
          className="shrink-0 rounded p-0.5 text-status-ok transition-colors hover:bg-surface-2"
        >
          <Check size={10} strokeWidth={2.4} />
        </button>
      )}

      {runId && !['done', 'failed'].includes(row.status) && (
        <button
          type="button"
          onClick={() => void pilotControl(runId, 'abort', row.task_id)}
          title="Abort this task"
          aria-label="Abort task"
          className="shrink-0 rounded p-0.5 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-status-err"
        >
          <Ban size={10} strokeWidth={2} />
        </button>
      )}

      {runId && row.status === 'failed' && (
        <button
          type="button"
          onClick={() => void pilotControl(runId, 'retry', row.task_id)}
          title="Re-queue this task"
          aria-label="Retry task"
          className="shrink-0 rounded p-0.5 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
        >
          <RotateCcw size={10} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
