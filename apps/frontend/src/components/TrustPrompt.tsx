import { useEffect } from 'react';
import { ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { useTrust } from '../state/trust';

/**
 * Workspace-trust gate. When an opened folder's `.arc/config.toml` wants to
 * inject shell env, we park the decision in `useTrust` and prompt here before
 * anything applies it. Trusting remembers the root; declining leaves it inert.
 * Mirrors the paste warning: Esc declines, ⌘/Ctrl+Enter trusts, Enter alone is
 * inert.
 */
export function TrustPrompt() {
  const pending = useTrust((s) => s.pending);
  const respond = useTrust((s) => s.respond);

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

  const { root, cfg } = pending;
  const items: string[] = [];
  const envCount = Object.keys(cfg.env ?? {}).length;
  if (envCount) items.push(`${envCount} environment variable${envCount > 1 ? 's' : ''}`);

  const onTrust = () => {
    respond(true);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-scrim-2 backdrop-blur-sm"
      onClick={() => respond(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="material-sheet mt-[12vh] flex w-[560px] max-w-[92vw] animate-sheet-in flex-col overflow-hidden rounded-window shadow-sheet ring-1 ring-edge-2"
      >
        <div className="flex items-center justify-between border-b border-border-hairline px-4 py-2.5">
          <div className="flex items-center gap-2 font-display text-sm font-semibold tracking-tight text-fg-base">
            <ShieldAlert size={12} strokeWidth={2.1} className="text-amber-400" />
            Trust this folder?
          </div>
          <button
            onClick={() => respond(false)}
            title="Don't trust (esc)"
            className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
          >
            <X size={11} strokeWidth={2.2} />
          </button>
        </div>

        <div className="border-b border-border-hairline px-4 py-3">
          <p className="font-display text-xs leading-relaxed text-fg-muted">
            This folder ships an <code className="rounded bg-scrim-1 px-1 font-mono text-2xs text-amber-200/90">.arc/config.toml</code> that
            would run code on your machine. Only trust folders you got from a source you trust.
          </p>
          <code className="mt-2 block truncate rounded bg-bg-base/50 px-2 py-1 font-mono text-2xs text-fg-subtle" title={root}>
            {root}
          </code>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {items.map((it, i) => (
              <span
                key={i}
                className="inline-flex items-center rounded-md bg-amber-400/[0.12] px-2 py-1 font-display text-2xs font-medium text-amber-300 ring-1 ring-amber-400/25"
              >
                {it}
              </span>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between bg-bg-base/30 px-4 py-2">
          <div className="font-display text-2xs text-fg-subtle">
            declining leaves the config inert — the terminal still works
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => respond(false)}
              className="rounded px-2.5 py-1 font-display text-xs text-fg-muted hover:bg-surface-1 hover:text-fg-base"
            >
              don&rsquo;t trust
            </button>
            <button
              onClick={onTrust}
              className="flex items-center gap-1.5 rounded bg-amber-400/15 px-3 py-1 font-display text-xs font-medium text-amber-200 ring-1 ring-amber-400/40 transition-colors hover:bg-amber-400/25"
              title="Trust folder (⌘↵)"
            >
              <ShieldCheck size={10} strokeWidth={2.2} />
              trust folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
