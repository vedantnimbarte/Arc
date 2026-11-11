import { useState } from 'react';
import { Variable } from 'lucide-react';
import { cn } from '../../lib/cn';
import { inputCls, primaryBtn, textBtn } from './chrome';

/**
 * Ask for the values of a query's `:name` parameters before it runs. A
 * number goes in as a number, blank or `null` as NULL, anything else as a
 * quoted string — the same rules the preview line shows.
 */
export function QueryParamsDialog({
  names,
  initial,
  onRun,
  onClose,
}: {
  names: string[];
  /** Values used last time, by name. */
  initial: Record<string, string>;
  onRun: (values: Record<string, string>) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(names.map((n) => [n, initial[n] ?? ''])),
  );
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-scrim-2 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        className="material-sheet mt-[14vh] flex w-[420px] max-w-[94vw] animate-sheet-in flex-col overflow-hidden rounded-window shadow-sheet ring-1 ring-edge-2"
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        onSubmit={(e) => {
          e.preventDefault();
          onRun(values);
        }}
      >
        <div className="flex h-9 items-center gap-2 border-b border-edge-1 bg-surface-1 px-3">
          <Variable size={13} className="text-accent-bright" />
          <span className="font-display text-xs font-semibold text-fg-base">Query parameters</span>
        </div>
        <div className="flex flex-col gap-2.5 px-4 py-3">
          {names.map((n, i) => (
            <label key={n} className="flex items-center gap-3">
              <span className="w-28 shrink-0 truncate font-mono text-xs text-fg-muted">:{n}</span>
              <input
                value={values[n] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))}
                autoFocus={i === 0}
                placeholder="NULL"
                spellCheck={false}
                className={cn(inputCls, 'min-w-0 flex-1')}
              />
            </label>
          ))}
          <p className="font-display text-2xs text-fg-subtle">
            Numbers go in as numbers, blank or <code className="font-mono">null</code> as NULL, anything else as quoted text.
          </p>
        </div>
        <div className="flex justify-end gap-1.5 border-t border-edge-1 px-3 py-2">
          <button
            type="button"
            onClick={onClose}
            className={textBtn}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={primaryBtn}
          >
            Run
          </button>
        </div>
      </form>
    </div>
  );
}
