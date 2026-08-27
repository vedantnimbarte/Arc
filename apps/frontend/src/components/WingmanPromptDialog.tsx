import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Bot, X } from 'lucide-react';
import { useWorkspace } from '../state/workspace';

/**
 * Collects the one argument Wingman's pilot/headless modes need before
 * launching. Opened via `useWorkspace.launchWingman('pilot' | 'headless')`,
 * which sets `wingmanPrompt`; submit hands the text to `confirmWingmanPrompt`,
 * which spawns the terminal tab (`wingman pilot run <goal>` or
 * `wingman --print <message>`).
 */
export function WingmanPromptDialog() {
  const prompt = useWorkspace((s) => s.wingmanPrompt);
  const confirm = useWorkspace((s) => s.confirmWingmanPrompt);
  const cancel = useWorkspace((s) => s.cancelWingmanPrompt);

  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!prompt) return;
    setText('');
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [prompt]);

  if (!prompt) return null;

  const isPilot = prompt.mode === 'pilot';
  const title = isPilot ? 'Wingman Pilot' : 'Wingman (headless)';
  const label = isPilot ? 'Goal' : 'Message';
  const placeholder = isPilot
    ? 'e.g. Add pagination to the users list and open a PR'
    : 'Ask Wingman a one-shot question…';

  const submit = () => void confirm(text);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-scrim-2 backdrop-blur-sm"
      onClick={cancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancel();
        }}
        className="material-sheet mt-[18vh] flex w-[520px] max-w-[92vw] animate-sheet-in flex-col overflow-hidden rounded-window shadow-sheet ring-1 ring-edge-2"
      >
        <div className="flex items-center justify-between border-b border-border-hairline px-4 py-3">
          <div className="flex items-center gap-2 font-display text-sm font-medium tracking-tight text-fg-base">
            <Bot size={13} strokeWidth={2} className="text-fg-subtle" />
            {title}
          </div>
          <button
            onClick={cancel}
            title="Close (esc)"
            className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
          >
            <X size={11} strokeWidth={2.2} />
          </button>
        </div>

        <div className="flex flex-col gap-3 px-4 py-4">
          <label className="flex flex-col gap-1">
            <span className="font-display text-2xs uppercase tracking-wider text-fg-subtle">
              {label}
            </span>
            <textarea
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Enter submits; Shift+Enter inserts a newline.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={3}
              placeholder={placeholder}
              spellCheck={false}
              className="min-w-0 flex-1 resize-none rounded-md border border-edge-1 bg-scrim-1 px-2.5 py-1.5 font-mono text-sm text-fg-base placeholder:text-fg-subtle focus:border-accent/40 focus:bg-scrim-2 focus:shadow-focus focus:outline-none"
            />
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border-hairline bg-bg-base/30 px-4 py-2">
          <button
            onClick={cancel}
            className="rounded px-2.5 py-1 font-display text-xs text-fg-muted hover:bg-surface-1 hover:text-fg-base"
          >
            cancel
          </button>
          <button
            onClick={submit}
            disabled={!text.trim()}
            className="flex items-center gap-1.5 rounded bg-accent-soft px-3 py-1 font-display text-xs font-medium text-fg-base ring-1 ring-accent/45 transition-colors hover:bg-accent/20 disabled:opacity-50"
          >
            launch
            <ArrowRight size={10} strokeWidth={2.4} />
          </button>
        </div>
      </div>
    </div>
  );
}
