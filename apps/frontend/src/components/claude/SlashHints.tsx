import { slashMatches } from '../../lib/slashCommands';

/**
 * The slash commands matching a composer's text while it is still just
 * `/name`, shown above the input. Picking one fills in `/name ` for the
 * argument; Tab does the same for the first match (`completeSlash`).
 */
export function SlashHints({
  text,
  onPick,
  className = '',
}: {
  text: string;
  onPick: (text: string) => void;
  className?: string;
}) {
  const matches = slashMatches(text);
  if (matches.length === 0) return null;
  return (
    <ul
      role="listbox"
      aria-label="Commands"
      className={`absolute bottom-full left-0 right-0 z-10 mb-1.5 overflow-hidden rounded-squircle bg-bg-panel py-1 shadow-sheet ring-1 ring-edge-2 animate-popover-in ${className}`}
    >
      {matches.map((c) => (
        <li key={c.name} role="option" aria-selected={false}>
          <button
            type="button"
            // Keep focus in the composer.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(`/${c.name} `)}
            className="flex w-full flex-col px-3 py-1.5 text-left hover:bg-surface-2"
          >
            <span className="font-mono text-xs text-fg-base">
              /{c.name} <span className="text-fg-subtle">{c.arg}</span>
            </span>
            <span className="font-display text-2xs text-fg-subtle">{c.hint}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Tab in a composer: complete the first matching command, if any. Returns the
 *  completed text, or null when Tab should behave normally. */
export function completeSlash(text: string): string | null {
  const first = slashMatches(text)[0];
  return first ? `/${first.name} ` : null;
}
