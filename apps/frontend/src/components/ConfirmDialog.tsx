import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useConfirm } from '../state/confirm';
import { cn } from '../lib/cn';

/**
 * The single dialog behind `askConfirm` / `askText`. Renders in ARC's own
 * sheet material instead of dropping to the OS dialog the way
 * `window.confirm` did, so a destructive git action looks like part of the
 * app rather than an escape hatch out of it.
 */
export function ConfirmDialog() {
  const pending = useConfirm((s) => s.pending);
  const settle = useConfirm((s) => s.settle);

  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!pending) return;
    setText(pending.input?.value ?? '');
    // Land on the field when there is one, otherwise the affirmative button
    // — the same spot the native dialog focused, so Enter still commits.
    const t = setTimeout(() => {
      if (pending.input) {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else {
        okRef.current?.focus();
      }
    }, 0);
    return () => clearTimeout(t);
  }, [pending]);

  if (!pending) return null;

  const { title, body, confirmLabel, destructive, input } = pending;
  const cancel = () => settle(null);
  const accept = () => {
    if (input && !text.trim()) return;
    settle(input ? text.trim() : '');
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-scrim-2 backdrop-blur-sm"
      onClick={cancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Swallow both keys: an Escape that reached the pane behind this
          // would close that too, and Enter would re-trigger the caller.
          if (e.key === 'Escape') {
            e.stopPropagation();
            cancel();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            accept();
          }
        }}
        className="material-sheet mt-[20vh] flex w-[420px] max-w-[92vw] animate-sheet-in flex-col overflow-hidden rounded-window shadow-sheet ring-1 ring-edge-2"
      >
        <div className="flex gap-3 px-4 pb-3 pt-4">
          {destructive && (
            <AlertTriangle
              size={15}
              strokeWidth={2}
              className="mt-px shrink-0 text-status-err"
              aria-hidden
            />
          )}
          <div className="flex min-w-0 flex-col gap-1">
            <div className="font-display text-sm font-medium tracking-tight text-fg-base">
              {title}
            </div>
            {body && (
              <p className="m-0 font-display text-xs leading-relaxed text-fg-muted">{body}</p>
            )}
          </div>
        </div>

        {input && (
          <label className="flex flex-col gap-1 px-4 pb-4">
            <span className="font-display text-2xs uppercase tracking-wider text-fg-subtle">
              {input.label}
            </span>
            <input
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={input.placeholder}
              spellCheck={false}
              className="min-w-0 rounded-md border border-edge-1 bg-scrim-1 px-2.5 py-1.5 font-display text-sm text-fg-base placeholder:text-fg-subtle focus:border-accent/40 focus:bg-scrim-2 focus:shadow-focus focus:outline-none"
            />
          </label>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-border-hairline bg-bg-base/30 px-4 py-2">
          <button
            onClick={cancel}
            className="rounded px-2.5 py-1 font-display text-xs text-fg-muted hover:bg-surface-1 hover:text-fg-base"
          >
            cancel
          </button>
          <button
            ref={okRef}
            onClick={accept}
            disabled={!!input && !text.trim()}
            className={cn(
              'rounded px-3 py-1 font-display text-xs font-medium ring-1 transition-colors disabled:opacity-50',
              destructive
                ? 'bg-status-err/15 text-status-err ring-status-err/45 hover:bg-status-err/25'
                : 'bg-accent-soft text-fg-base ring-accent/45 hover:bg-accent/20',
            )}
          >
            {confirmLabel ?? 'confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
