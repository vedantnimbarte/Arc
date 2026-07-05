import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  Search,
  Sparkles,
  SquareTerminal,
} from 'lucide-react';
import {
  isTauri,
  llmStream,
  ptyWrite,
  sessionCommandsRecent,
  type CommandRecord,
} from '../lib/tauri';
import { buildExplainMessages } from '../lib/explainError';
import { useActivePreset, useActiveProviderConfig } from '../state/settings';
import { useWorkspace } from '../state/workspace';
import { cn } from '../lib/cn';

interface Props {
  open: boolean;
  onClose: () => void;
}

type ExplainState = {
  text: string;
  phase: 'streaming' | 'done' | 'error';
  error?: string;
};

/**
 * Warp-style "command blocks" panel (feature #2). Lists recent commands with
 * their exit status and captured output, each as a block. Failed commands get
 * an AI "explain" action (feature #1) that streams an explanation + likely fix
 * from the active chat provider — reusing the same `llmStream` path as inline
 * edit. Data comes from `command_history` (OSC 133 shell integration).
 */
export function CommandBlocks({ open, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<CommandRecord[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [explain, setExplain] = useState<Record<number, ExplainState>>({});
  const cancelRef = useRef<null | (() => Promise<void>)>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const preset = useActivePreset();
  const cfg = useActiveProviderConfig();

  useEffect(() => {
    if (!open || !isTauri) {
      if (!open) setRows([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void sessionCommandsRecent(80, query.trim() || null)
        .then((r) => !cancelled && setRows(r))
        .catch(() => !cancelled && setRows([]));
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, query]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery('');
      setExpanded(new Set());
      setExplain({});
      void cancelRef.current?.();
      cancelRef.current = null;
    }
  }, [open]);

  const toggle = (id: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const pasteInto = useCallback(async (cmd: string) => {
    const { tabs, activeTabId } = useWorkspace.getState();
    const active = tabs.find((t) => t.id === activeTabId);
    if (!active?.ptyId) return;
    try {
      await ptyWrite(active.ptyId, cmd);
    } catch {
      /* terminal closing */
    }
    onClose();
  }, [onClose]);

  const runExplain = useCallback(
    async (row: CommandRecord) => {
      if (preset.needsApiKey && !cfg.apiKey) {
        setExplain((e) => ({
          ...e,
          [row.id]: { text: '', phase: 'error', error: `Set an API key for ${preset.label} in Settings.` },
        }));
        return;
      }
      if (!cfg.model) {
        setExplain((e) => ({
          ...e,
          [row.id]: { text: '', phase: 'error', error: `Pick a model for ${preset.label} in Settings.` },
        }));
        return;
      }
      // One explanation at a time — cancel any in flight.
      await cancelRef.current?.();
      setExpanded((s) => new Set(s).add(row.id));
      setExplain((e) => ({ ...e, [row.id]: { text: '', phase: 'streaming' } }));

      const { system, messages } = buildExplainMessages({
        command: row.command,
        exitCode: row.exit_code,
        output: row.output_excerpt,
        cwd: row.cwd,
      });
      let acc = '';
      try {
        cancelRef.current = await llmStream(
          {
            id: crypto.randomUUID(),
            provider: preset.kind,
            model: cfg.model,
            messages,
            system,
            api_key: cfg.apiKey || undefined,
            // Fall back to the preset default so non-OpenAI gateways resolve.
            base_url: cfg.baseUrl || preset.defaultBaseUrl || undefined,
            temperature: 0.2,
          },
          (chunk) => {
            if (chunk.text) {
              acc += chunk.text;
              setExplain((e) => ({ ...e, [row.id]: { text: acc, phase: 'streaming' } }));
            }
          },
          (ev) => {
            cancelRef.current = null;
            if (ev.error) {
              setExplain((e) => ({ ...e, [row.id]: { text: acc, phase: 'error', error: ev.error } }));
              return;
            }
            if (ev.cancelled) return;
            setExplain((e) => ({ ...e, [row.id]: { text: acc, phase: 'done' } }));
          },
        );
      } catch (err) {
        cancelRef.current = null;
        setExplain((e) => ({ ...e, [row.id]: { text: acc, phase: 'error', error: String(err) } }));
      }
    },
    [preset, cfg],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="material-sheet mt-[10vh] flex max-h-[80vh] w-[720px] max-w-[94vw] animate-sheet-in flex-col overflow-hidden rounded-window shadow-sheet ring-1 ring-white/10"
      >
        <div className="flex items-center gap-2 border-b border-border-hairline px-3.5 py-2.5">
          <SquareTerminal size={13} strokeWidth={2.1} className="text-fg-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && onClose()}
            placeholder="filter command blocks…"
            className="flex-1 bg-transparent font-display text-[13px] text-fg-base placeholder:text-fg-subtle focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="font-mono text-[10px] text-fg-subtle">esc</kbd>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {rows.length === 0 && (
            <div className="flex items-center justify-center gap-1.5 px-4 py-8 font-display text-[11.5px] italic text-fg-subtle">
              {isTauri ? (
                <>
                  <Search size={11} strokeWidth={2} />
                  no commands {query ? `match “${query}”` : 'yet'}
                </>
              ) : (
                'history is empty in web preview'
              )}
            </div>
          )}
          {rows.map((row) => {
            const failed = row.exit_code != null && row.exit_code !== 0;
            const ok = row.exit_code === 0;
            const isOpen = expanded.has(row.id);
            const ex = explain[row.id];
            const hasOutput = Boolean(row.output_excerpt);
            return (
              <div
                key={row.id}
                className={cn(
                  'mb-1.5 overflow-hidden rounded-lg border bg-bg-base/40',
                  failed ? 'border-status-err/30' : 'border-border-subtle',
                )}
              >
                <div className="flex items-center gap-2 px-2.5 py-1.5">
                  <button
                    onClick={() => (hasOutput || ex ? toggle(row.id) : undefined)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    title={hasOutput ? 'Toggle output' : undefined}
                  >
                    {hasOutput || ex ? (
                      isOpen ? (
                        <ChevronDown size={12} className="shrink-0 text-fg-subtle" />
                      ) : (
                        <ChevronRight size={12} className="shrink-0 text-fg-subtle" />
                      )
                    ) : (
                      <span className="w-3 shrink-0" />
                    )}
                    <StatusBadge ok={ok} failed={failed} code={row.exit_code} />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-base/90">
                      {row.command}
                    </span>
                  </button>
                  <span className="shrink-0 font-mono text-[10px] text-fg-subtle">
                    {formatAge(row.started_at)}
                  </span>
                  {failed && (
                    <button
                      onClick={() => void runExplain(row)}
                      disabled={ex?.phase === 'streaming'}
                      className={cn(
                        'inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 font-display text-[10.5px] transition-colors',
                        ex?.phase === 'streaming'
                          ? 'cursor-wait border-border-subtle text-fg-subtle'
                          : 'border-accent/40 text-accent-bright hover:bg-accent-soft',
                      )}
                      title="Explain this failure with AI"
                    >
                      <Sparkles size={10} strokeWidth={2.2} />
                      {ex?.phase === 'streaming' ? 'Explaining…' : 'Explain'}
                    </button>
                  )}
                  <button
                    onClick={() => void pasteInto(row.command)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border-subtle px-1.5 py-0.5 font-display text-[10.5px] text-fg-muted transition-colors hover:border-border-strong hover:text-fg-base"
                    title="Paste into the active terminal"
                  >
                    <CornerDownLeft size={10} strokeWidth={2.2} />
                    Paste
                  </button>
                </div>

                {isOpen && (hasOutput || ex) && (
                  <div className="border-t border-border-hairline px-2.5 py-2">
                    {hasOutput && (
                      <pre className="mb-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-fg-muted">
                        {row.output_excerpt}
                      </pre>
                    )}
                    {ex && (
                      <div className="rounded-md border border-accent/25 bg-accent-soft/40 px-2.5 py-2">
                        <div className="mb-1 flex items-center gap-1 font-display text-[9.5px] font-semibold uppercase tracking-widest2 text-accent-bright">
                          <Sparkles size={9} strokeWidth={2.3} /> AI explanation
                        </div>
                        {ex.phase === 'error' ? (
                          <p className="font-display text-[11.5px] text-status-err">{ex.error}</p>
                        ) : (
                          <p className="whitespace-pre-wrap break-words font-display text-[12px] leading-relaxed text-fg-base/90">
                            {ex.text}
                            {ex.phase === 'streaming' && <span className="animate-pulse">▍</span>}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between border-t border-border-hairline px-3.5 py-1.5 font-display text-[10px] text-fg-subtle">
          <span>
            <kbd className="font-mono">esc</kbd> close · click a block to expand output · Explain needs shell integration (OSC 133)
          </span>
          <span className="tabular-nums">{rows.length} blocks</span>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ ok, failed, code }: { ok: boolean; failed: boolean; code: number | null }) {
  if (ok)
    return (
      <span className="shrink-0 rounded px-1 font-mono text-[10px] text-status-ok" title="exit 0">
        ✓
      </span>
    );
  if (failed)
    return (
      <span
        className="shrink-0 rounded bg-status-err/15 px-1 font-mono text-[10px] text-status-err"
        title={`exit ${code}`}
      >
        {code}
      </span>
    );
  return (
    <span className="shrink-0 rounded px-1 font-mono text-[10px] text-fg-subtle" title="no exit code (no shell integration)">
      ·
    </span>
  );
}

/** "5s", "12m", "3h", "2d" — short relative time markers. */
function formatAge(unixMs: number): string {
  const delta = Math.max(0, Date.now() - unixMs);
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
