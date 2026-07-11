import { useEffect } from 'react';
import { ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { useTrust } from '../state/trust';
import { applyProjectConfig } from '../state/projectConfig';

/**
 * Workspace-trust gate. When an opened folder's `.arc/config.toml` wants to
 * spawn MCP servers, register agents, or inject shell env, we park the decision
 * in `useTrust` and prompt here before anything runs. Trusting applies the
 * config and remembers the root; declining leaves it inert. Mirrors the paste
 * warning: Esc declines, ⌘/Ctrl+Enter trusts, Enter alone is inert.
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
        const p = useTrust.getState().pending;
        respond(true);
        if (p) applyProjectConfig(p.cfg);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pending, respond]);

  if (!pending) return null;

  const { root, cfg } = pending;
  const items: string[] = [];
  if (cfg.mcp_servers?.length)
    items.push(`${cfg.mcp_servers.length} MCP server${cfg.mcp_servers.length > 1 ? 's' : ''} (runs commands)`);
  if (cfg.agents?.length)
    items.push(`${cfg.agents.length} agent persona${cfg.agents.length > 1 ? 's' : ''}`);
  const envCount = Object.keys(cfg.env ?? {}).length;
  if (envCount) items.push(`${envCount} environment variable${envCount > 1 ? 's' : ''}`);

  const onTrust = () => {
    const p = useTrust.getState().pending;
    respond(true);
    if (p) applyProjectConfig(p.cfg);
  };

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
            <ShieldAlert size={12} strokeWidth={2.1} className="text-amber-400" />
            Trust this folder?
          </div>
          <button
            onClick={() => respond(false)}
            title="Don't trust (esc)"
            className="rounded p-1 text-fg-subtle transition-colors hover:bg-white/[0.06] hover:text-fg-base"
          >
            <X size={11} strokeWidth={2.2} />
          </button>
        </div>

        <div className="border-b border-border-hairline px-4 py-3">
          <p className="font-display text-[11.5px] leading-relaxed text-fg-muted">
            This folder ships an <code className="rounded bg-black/25 px-1 font-mono text-[10.5px] text-amber-200/90">.arc/config.toml</code> that
            would run code on your machine. Only trust folders you got from a source you trust.
          </p>
          <code className="mt-2 block truncate rounded bg-bg-base/50 px-2 py-1 font-mono text-[10.5px] text-fg-subtle" title={root}>
            {root}
          </code>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {items.map((it, i) => (
              <span
                key={i}
                className="inline-flex items-center rounded-md bg-amber-400/[0.12] px-2 py-1 font-display text-[10.5px] font-medium text-amber-300 ring-1 ring-amber-400/25"
              >
                {it}
              </span>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between bg-bg-base/30 px-4 py-2">
          <div className="font-display text-[10.5px] text-fg-subtle">
            declining leaves the config inert — the terminal still works
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => respond(false)}
              className="rounded px-2.5 py-1 font-display text-[11px] text-fg-muted hover:bg-white/[0.05] hover:text-fg-base"
            >
              don&rsquo;t trust
            </button>
            <button
              onClick={onTrust}
              className="flex items-center gap-1.5 rounded bg-amber-400/15 px-3 py-1 font-display text-[11px] font-medium text-amber-200 ring-1 ring-amber-400/40 transition-colors hover:bg-amber-400/25"
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
