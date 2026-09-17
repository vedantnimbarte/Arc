import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ListOrdered, Pause, Play, SendHorizontal, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { useAgentQueue } from '../state/agentQueue';
import type { Tab } from '../state/workspace';

/**
 * The prompt-queue control for one agent tab: an icon that carries the queue
 * length, and a popover to add, reorder, remove, pause and send. Renders
 * nothing for tabs that are not agents — a shell has no turn to wait for.
 */
export function AgentQueueButton({
  tab,
  className,
  size = 11,
}: {
  tab: Tab;
  className?: string;
  size?: number;
}) {
  const count = useAgentQueue((s) => s.queues[tab.id]?.items.length ?? 0);
  const paused = useAgentQueue((s) => !!s.queues[tab.id]?.paused);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  if (tab.kind !== 'terminal' || !tab.shellOverride) return null;

  const label = count > 0 ? `${count} queued prompt${count === 1 ? '' : 's'}${paused ? ' (paused)' : ''}` : 'Queue a prompt';
  return (
    <>
      <span
        role="button"
        tabIndex={0}
        aria-label={label}
        title={label}
        aria-expanded={!!anchor}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setAnchor((a) => (a ? null : r));
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          (e.currentTarget as HTMLElement).click();
        }}
        className={cn(
          'flex h-[18px] shrink-0 items-center justify-center gap-0.5 rounded-full px-1 transition-colors hover:bg-white/15 hover:text-fg-base',
          count > 0 ? (paused ? 'text-status-warn' : 'text-accent-bright') : 'text-fg-subtle',
          className,
        )}
      >
        <ListOrdered size={size} strokeWidth={2.2} />
        {count > 0 && <span className="font-mono text-2xs tabular-nums">{count}</span>}
      </span>
      {anchor && <QueuePopover tab={tab} anchor={anchor} onClose={() => setAnchor(null)} />}
    </>
  );
}

const WIDTH = 300;

function QueuePopover({ tab, anchor, onClose }: { tab: Tab; anchor: DOMRect; onClose: () => void }) {
  const queue = useAgentQueue((s) => s.queues[tab.id]);
  const { add, remove, move, setPaused, sendNext } = useAgentQueue.getState();
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const items = queue?.items ?? [];
  const paused = !!queue?.paused;
  const submit = () => {
    if (add(tab.id, draft.trim())) setDraft('');
  };

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={`Prompt queue for ${tab.title}`}
      style={{
        position: 'fixed',
        top: anchor.bottom + 4,
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - WIDTH - 8)),
        width: WIDTH,
      }}
      className="material-sheet z-[60] animate-popover-in overflow-hidden rounded-md bg-bg-panel shadow-sheet ring-1 ring-edge-2"
      // React bubbles portal events through the component tree, which here
      // runs through the tab pill's own click and mousedown handlers.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      // Keys typed here belong to the popover, not the terminal behind it.
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1 border-b border-border-hairline px-2.5 py-1.5">
        <span className="min-w-0 flex-1 truncate font-display text-xs font-medium tracking-tight text-fg-base">
          Queue for {tab.title}
        </span>
        <PopButton
          label={paused ? 'Resume — send when the agent next waits' : 'Pause'}
          onClick={() => setPaused(tab.id, !paused)}
          className={paused ? 'text-status-warn' : undefined}
        >
          {paused ? <Play size={12} strokeWidth={2} /> : <Pause size={12} strokeWidth={2} />}
        </PopButton>
        <PopButton label="Send next now" disabled={items.length === 0} onClick={() => sendNext(tab.id)}>
          <SendHorizontal size={12} strokeWidth={2} />
        </PopButton>
      </div>

      <p className="px-2.5 pt-1.5 font-display text-2xs leading-relaxed text-fg-subtle">
        {paused
          ? 'Paused. Nothing is sent until you resume.'
          : 'Each time the agent stops and waits, the next prompt is sent. Typing into the agent pauses the queue.'}
      </p>

      {items.length > 0 && (
        <ol className="max-h-56 overflow-y-auto py-1">
          {items.map((item, i) => (
            <li key={item.id} className="group/q flex items-start gap-1.5 px-2.5 py-1">
              <span className="w-3 shrink-0 pt-px font-mono text-2xs tabular-nums text-fg-subtle">{i + 1}</span>
              <span className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-2xs text-fg-base/90">
                {item.text}
              </span>
              <span className="flex shrink-0 items-center opacity-50 group-hover/q:opacity-100">
                <PopButton label="Move up" disabled={i === 0} onClick={() => move(tab.id, item.id, -1)}>
                  <ArrowUp size={11} strokeWidth={2} />
                </PopButton>
                <PopButton label="Move down" disabled={i === items.length - 1} onClick={() => move(tab.id, item.id, 1)}>
                  <ArrowDown size={11} strokeWidth={2} />
                </PopButton>
                <PopButton label="Remove" onClick={() => remove(tab.id, item.id)}>
                  <X size={11} strokeWidth={2} />
                </PopButton>
              </span>
            </li>
          ))}
        </ol>
      )}

      <div className="p-2.5 pt-1.5">
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder="Follow-up prompt — Enter to queue, Shift+Enter for a new line"
          aria-label="Prompt to queue"
          className={cn(
            'w-full resize-none rounded-md border border-border-hairline bg-bg-base/50 px-2 py-1.5',
            'font-mono text-xs text-fg-base placeholder:text-fg-subtle/60',
            'focus:border-accent/45 focus:outline-none focus:shadow-focus',
          )}
        />
      </div>
    </div>,
    document.body,
  );
}

function PopButton({
  label,
  onClick,
  disabled,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-5 w-5 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base disabled:pointer-events-none disabled:opacity-30',
        className,
      )}
    >
      {children}
    </button>
  );
}
