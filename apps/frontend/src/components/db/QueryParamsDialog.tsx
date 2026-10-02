import { useState } from 'react';
import { Variable } from 'lucide-react';

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
        <div className="flex items-center gap-2 border-b border-border-hairline px-4 py-2.5">
          <Variable size={13} className="text-fg-subtle" />
          <span className="font-display text-sm text-fg-base">Query parameters</span>
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
                className="min-w-0 flex-1 rounded-md border border-border-subtle bg-bg-base/60 px-2 py-1 font-mono text-xs text-fg-base placeholder:text-fg-subtle/50 focus:border-accent/45 focus:outline-none"
              />
            </label>
          ))}
          <p className="font-sans text-2xs text-fg-subtle">
            Numbers go in as numbers, blank or <code>null</code> as NULL, anything else as quoted text.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-border-hairline px-4 py-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2.5 py-1 font-sans text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-lg bg-accent-soft px-2.5 py-1 font-sans text-xs text-fg-base ring-1 ring-accent/45 transition-colors hover:bg-accent/20"
          >
            Run
          </button>
        </div>
      </form>
    </div>
  );
}
