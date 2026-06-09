import { useEffect } from 'react';
import { AlertTriangle, ClipboardPaste, X } from 'lucide-react';
import { usePaste } from '../state/paste';

const PREVIEW_CAP = 4000;

/**
 * Confirmation gate for risky terminal pastes (Tier 1.4). Driven by the
 * `usePaste` store: the Terminal parks a paste here when `detectRiskyPaste`
 * flags it, and this dialog resolves the awaiting promise once the user
 * decides. Shift-paste bypasses this entirely (handled in Terminal).
 */
export function PasteWarning() {
  const pending = usePaste((s) => s.pending);
  const respond = usePaste((s) => s.respond);

  // Esc cancels, ⌘/Ctrl+Enter confirms — Enter alone is deliberately inert so
  // a stray keypress can't run a flagged command.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        respond(false);
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        respond(true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pending, respond]);

  if (!pending) return null;

  const { text, flags } = pending;
  const preview = text.length > PREVIEW_CAP ? `${text.slice(0, PREVIEW_CAP)}\n…` : text;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 backdrop-blur-sm"
      onClick={() => respond(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="material-sheet mt-[12vh] flex w-[560px] max-w-[92vw] animate-sheet-in flex-col overflow-hidden rounded-window shadow-sheet ring-1 ring-white/10"
      >
        <div className="flex items-center justify-between border-b border-border-hairline px-4 py-2.5">
          <div className="flex items-center gap-2 font-display text-[12.5px] font-semibold tracking-tight text-fg-base">
            <AlertTriangle size={12} strokeWidth={2.1} className="text-amber-400" />
            Review paste before running
          </div>
          <button
            onClick={() => respond(false)}
            title="Cancel (esc)"
            className="rounded p-1 text-fg-subtle transition-colors hover:bg-white/[0.06] hover:text-fg-base"
          >
            <X size={11} strokeWidth={2.2} />
          </button>
        </div>

        {/* Flagged patterns */}
        <div className="flex flex-wrap gap-1.5 border-b border-border-hairline px-4 py-2.5">
          {flags.map((f, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 rounded-md bg-amber-400/[0.12] px-2 py-1 font-display text-[10.5px] font-medium text-amber-300 ring-1 ring-amber-400/25"
              title={f.match || undefined}
            >
              {f.label}
              {f.match && (
                <code className="rounded bg-black/25 px-1 font-mono text-[9.5px] text-amber-200/90">
                  {f.match.length > 40 ? `${f.match.slice(0, 40)}…` : f.match}
                </code>
              )}
            </span>
          ))}
        </div>

        {/* Content preview */}
        <div className="max-h-[40vh] overflow-auto bg-bg-base/40 px-4 py-3">
          <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-fg-base/90">
            {preview}
          </pre>
        </div>

        <div className="flex items-center justify-between border-t border-border-hairline bg-bg-base/30 px-4 py-2">
          <div className="font-display text-[10.5px] text-fg-subtle">
            shift-paste skips this check next time
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => respond(false)}
              className="rounded px-2.5 py-1 font-display text-[11px] text-fg-muted hover:bg-white/[0.05] hover:text-fg-base"
            >
              cancel
            </button>
            <button
              onClick={() => respond(true)}
              className="flex items-center gap-1.5 rounded bg-amber-400/15 px-3 py-1 font-display text-[11px] font-medium text-amber-200 ring-1 ring-amber-400/40 transition-colors hover:bg-amber-400/25"
              title="Paste anyway (⌘↵)"
            >
              <ClipboardPaste size={10} strokeWidth={2.2} />
              paste anyway
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
