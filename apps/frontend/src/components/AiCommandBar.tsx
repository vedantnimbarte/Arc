import { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, Loader2, Sparkles, X } from 'lucide-react';
import { AiError, suggestCommand } from '../lib/ai';
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

  useEffect(() => inputRef.current?.focus(), []);

  // Reset when the bar is reopened on a different tab.
  useEffect(() => {
    setRequest('');
    setCommand(null);
    setError(null);
  }, [sessionKey]);

  const ask = async () => {
    const trimmed = request.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setCommand(null);
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

  const accept = () => {
    if (!command) return;
    onInsert(command);
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
      if (command) accept();
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

      {(command || error) && (
        <div className="border-t border-border-hairline px-3 py-2.5">
          {error ? (
            <p className="font-display text-xs leading-relaxed text-red-400">{error}</p>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-fg-base">
              {command}
            </pre>
          )}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border-hairline bg-bg-base/30 px-3 py-1.5">
        <span className="font-display text-2xs text-fg-subtle">
          {command ? 'reviewed by you — nothing runs until you press enter in the shell' : 'suggests a command, never runs it'}
        </span>
        {command && (
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
