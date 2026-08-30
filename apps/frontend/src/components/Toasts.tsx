import { Check, X, AlertCircle } from 'lucide-react';
import { useToasts } from '../state/toast';
import { cn } from '../lib/cn';

/**
 * The corner stack for `toast()` / `toastError()`. Newest at the bottom, so
 * the row nearest the cursor is the one that just fired.
 *
 * ponytail: shares the bottom-right corner with UpdateToast, which sits one
 * layer below. A toast can cover the update card for its 2.4s life. Give the
 * stack an offset if that ever reads as a bug rather than as a queue.
 */
export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[56] flex flex-col items-end gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'material-sheet pointer-events-auto flex w-[300px] max-w-[70vw] animate-sheet-in items-start gap-2 rounded-squircle py-2 pl-2.5 pr-1.5 shadow-panel ring-1',
            t.tone === 'error' ? 'ring-status-err/40' : 'ring-edge-2',
          )}
        >
          {t.tone === 'error' ? (
            <AlertCircle size={12} strokeWidth={2.2} className="mt-px shrink-0 text-status-err" aria-hidden />
          ) : (
            <Check size={12} strokeWidth={2.4} className="mt-px shrink-0 text-status-ok" aria-hidden />
          )}
          <span className="min-w-0 flex-1 font-display text-xs leading-snug text-fg-base">{t.text}</span>
          <button
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
            className="-mt-0.5 shrink-0 rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
          >
            <X size={10} strokeWidth={2.2} />
          </button>
        </div>
      ))}
    </div>
  );
}
