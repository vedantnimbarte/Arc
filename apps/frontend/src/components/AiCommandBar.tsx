import { useEffect, useRef, useState } from 'react';
import { CircleAlert, CornerDownLeft, Loader2, Sparkles, X } from 'lucide-react';
import { AiError, explainFailure, suggestCommand, type FailureExplanation } from '../lib/ai';
import { useAi } from '../state/ai';

interface Props {
  /** Tab whose shell the command lands in. */
  sessionKey: string;
  shell: string | null;
  cwd: string | null;
  /** Puts `command` on the shell's input line. Never runs it. */
  onInsert: (command: string) => void;
}

/**
 * ⌘K natural-language command bar for a terminal tab.
 *
 * Suggests, never executes: the command is shown for review and, on accept,
 * typed onto the shell's input line without a trailing newline. Pressing Enter
 * is the user's own decision — which is also why this deliberately skips the
 * risky-paste gate (`detectRiskyPaste`), whose job is to interpose review that
 * this bar already performs.
 */
export function AiCommandBar({ sessionKey, shell, cwd, onInsert }: Props) {
  const close = useAi((s) => s.close);
  const inputRef = useRef<HTMLInputElement>(null);
  const [request, setRequest] = useState('');
  const [command, setCommand] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failure = useAi((s) => s.failures[sessionKey] ?? null);
  const clearFailure = useAi((s) => s.clearFailure);
  const [explanation, setExplanation] = useState<FailureExplanation | null>(null);

  useEffect(() => inputRef.current?.focus(), []);

  // Reset when the bar is reopened on a different tab.
  useEffect(() => {
    setRequest('');
    setCommand(null);
    setError(null);
    setExplanation(null);
  }, [sessionKey]);

  const ask = async () => {
    const trimmed = request.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setCommand(null);
    setExplanation(null);
    try {
      setCommand(await suggestCommand(trimmed, { shell, cwd }));
    } catch (err) {
      setError(
        err instanceof AiError
          ? err.message
          : `Request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const explain = async () => {
    if (!failure || busy) return;
    setBusy(true);
    setError(null);
    setCommand(null);
    try {
      setExplanation(await explainFailure(failure, { shell, cwd }));
    } catch (err) {
      setError(
        err instanceof AiError
          ? err.message
          : `Request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  /** The command to hand back: a suggestion, or an explained fix. */
  const insertable = command ?? explanation?.fix ?? null;

  const accept = () => {
    if (!insertable) return;
    onInsert(insertable);
    // The failure has been acted on; don't keep offering to explain it.
    if (explanation) clearFailure(sessionKey);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Enter asks, then Enter accepts — so a suggestion is always seen before
      // it can reach the shell.
      if (insertable) accept();
      else void ask();
    }
  };

  return (
    <div
      className="material-sheet absolute inset-x-4 top-4 z-30 animate-sheet-in overflow-hidden rounded-window shadow-sheet ring-1 ring-edge-2"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <Sparkles size={12} strokeWidth={2.1} className="shrink-0 text-accent" />
        <input
          ref={inputRef}
          value={request}
          onChange={(e) => {
            setRequest(e.target.value);
            setCommand(null);
          }}
          placeholder="Describe the command you want…"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent font-display text-sm text-fg-base placeholder:text-fg-subtle focus:outline-none"
        />
        {busy && <Loader2 size={12} strokeWidth={2.2} className="animate-spin text-fg-muted" />}
        <button
          onClick={close}
          title="Close (esc)"
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
        >
          <X size={11} strokeWidth={2.2} />
        </button>
      </div>

      {/* The last command in this tab failed, and the shell already told us
          what it was and what it printed. Offer that rather than making the
          user describe a failure they are looking at. */}
      {failure && !explanation && !command && !error && (
        <button
          onClick={() => void explain()}
          disabled={busy}
          className="flex w-full items-center gap-2 border-t border-border-hairline px-3 py-2 text-left transition-colors hover:bg-surface-2 disabled:opacity-50"
        >
          <CircleAlert size={11} strokeWidth={2.2} className="shrink-0 text-red-400" />
          <span className="min-w-0 flex-1 truncate font-display text-xs text-fg-base/90">
            Explain why{' '}
            <code className="font-mono text-fg-base">{failure.command}</code> failed
          </span>
          <span className="shrink-0 font-mono text-2xs text-fg-subtle">
            exit {failure.exitCode}
          </span>
        </button>
      )}

      {(command || error || explanation) && (
        <div className="border-t border-border-hairline px-3 py-2.5">
          {error ? (
            <p className="font-display text-xs leading-relaxed text-red-400">{error}</p>
          ) : explanation ? (
            <>
              <p className="whitespace-pre-wrap font-display text-xs leading-relaxed text-fg-base/90">
                {explanation.explanation}
              </p>
              {explanation.fix && (
                <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-bg-base/50 px-2 py-1.5 font-mono text-xs leading-relaxed text-fg-base">
                  {explanation.fix}
                </pre>
              )}
            </>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-fg-base">
              {command}
            </pre>
          )}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border-hairline bg-bg-base/30 px-3 py-1.5">
        <span className="font-display text-2xs text-fg-subtle">
          {insertable
            ? 'reviewed by you — nothing runs until you press enter in the shell'
            : explanation
              ? 'no single command fixes this one'
              : 'suggests a command, never runs it'}
        </span>
        {insertable && (
          <button
            onClick={accept}
            className="flex items-center gap-1.5 rounded bg-accent/15 px-2.5 py-1 font-display text-xs font-medium text-accent ring-1 ring-accent/40 transition-colors hover:bg-accent/25"
          >
            <CornerDownLeft size={10} strokeWidth={2.2} />
            put on prompt
          </button>
        )}
      </div>
    </div>
  );
}
