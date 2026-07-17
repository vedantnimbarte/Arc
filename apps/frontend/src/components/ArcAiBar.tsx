import { useEffect, useState } from 'react';
import { ArrowUp, Mic } from 'lucide-react';
import { cn } from '../lib/cn';

/** Rotating placeholder hints — a taste of what Arc AI can do. */
const PLACEHOLDERS = [
  'Message Arc AI…',
  'Explain this error…',
  'Write a commit message…',
  'Refactor the selected code…',
  'Summarize this diff…',
  'Fix the failing test…',
  'Scaffold a REST request…',
  'What does this command do?',
];

/**
 * Bottom dock beneath the pane area: a centered "Message Arc AI" composer
 * (input + mic + send) with the version tucked bottom-right.
 *
 * ponytail: UI only — there's no Arc AI backend yet. `send()` just clears the
 * field; wire it to the real assistant here when it exists.
 */
export function ArcAiBar() {
  const [value, setValue] = useState('');
  const [phIndex, setPhIndex] = useState(0);
  const [focused, setFocused] = useState(false);
  const canSend = value.trim().length > 0;

  // Cycle the placeholder to hint at Arc AI's capabilities. Paused while the
  // field is focused so the hint doesn't shuffle mid-thought.
  useEffect(() => {
    if (focused) return;
    const id = setInterval(() => setPhIndex((i) => (i + 1) % PLACEHOLDERS.length), 3200);
    return () => clearInterval(id);
  }, [focused]);

  const send = () => {
    if (!canSend) return;
    // TODO(arc-ai): dispatch `value` to the assistant once it exists.
    setValue('');
  };

  return (
    <div className="relative flex shrink-0 items-center justify-center px-3 pb-2.5 pt-0.5">
      <div className="flex w-full max-w-sm items-center gap-1 rounded-squircle border border-border-subtle bg-bg-subtle px-1.5 py-1 shadow-control transition-colors focus-within:border-border-strong">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={PLACEHOLDERS[phIndex]}
          spellCheck={false}
          autoComplete="off"
          className="flex-1 bg-transparent px-1 font-display text-[11.5px] text-fg-base placeholder:text-fg-subtle focus:outline-none"
        />

        <button
          type="button"
          aria-label="Voice input"
          title="Voice input"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-white/[0.08] hover:text-fg-base focus-visible:bg-white/[0.08] focus:outline-none"
        >
          <Mic size={12.5} strokeWidth={1.9} />
        </button>

        <button
          type="button"
          onClick={send}
          disabled={!canSend}
          aria-label="Send message"
          title="Send (Enter)"
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-all active:scale-95 focus:outline-none',
            canSend ? 'surface-silver' : 'bg-white/[0.05] text-fg-subtle',
          )}
        >
          <ArrowUp size={13} strokeWidth={2.3} />
        </button>
      </div>

      {/* Version — bottom-right of the dock, non-interactive. */}
      <span className="pointer-events-none absolute bottom-1 right-3.5 select-none font-mono text-[10px] tracking-tight tabular-nums text-fg-subtle/55">
        arc 0.0.1
      </span>
    </div>
  );
}
