import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface Props {
  /** State glyph for the left gutter — the thing the eye scans down. */
  glyph: LucideIcon;
  /** Colour class for the glyph. This is the only saturated colour in a list,
   *  so it has to mean something: open, merged, failed, running. */
  glyphClass?: string;
  /** What a person wrote — display type. */
  title: ReactNode;
  /** Machine facts — numbers, refs, logins, timestamps. Set in mono by the
   *  row itself, so callers pass plain text. */
  meta?: ReactNode;
  /** Trailing content: counts, actions. Revealed on hover/focus when `hover`. */
  right?: ReactNode;
  /** Keep `right` hidden until the row is hovered or focused. For actions that
   *  would otherwise clutter every row in a long list. */
  hoverRight?: boolean;
  selected?: boolean;
  onClick?: () => void;
  title_?: string;
}

/**
 * One row in any GitHub list.
 *
 * The fixed left gutter is the point: every list in this tab puts a state
 * glyph in the same 20px column, so scanning that column alone answers "what's
 * open, what merged, what failed" without reading a word. Titles are display
 * type, metadata is mono — that split tells you at a glance which half you
 * could copy-paste.
 */
export function ListRow({
  glyph: Glyph,
  glyphClass = 'text-fg-subtle',
  title,
  meta,
  right,
  hoverRight,
  selected,
  onClick,
  title_,
}: Props) {
  return (
    <button
      onClick={onClick}
      title={title_}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left',
        'transition-colors duration-150',
        'focus-visible:outline-none focus-visible:shadow-focus',
        selected ? 'bg-surface-2' : 'hover:bg-surface-1',
      )}
    >
      <span className="mt-[3px] flex w-5 shrink-0 justify-center" aria-hidden>
        <Glyph size={13} strokeWidth={2} className={glyphClass} />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate font-display text-xs text-fg-base/90">{title}</span>
        {meta && (
          <span className="mt-0.5 block truncate font-mono text-2xs tabular-nums text-fg-subtle">
            {meta}
          </span>
        )}
      </span>

      {right && (
        <span
          className={cn(
            'mt-[1px] flex shrink-0 items-center gap-1.5',
            hoverRight &&
              'opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100',
          )}
        >
          {right}
        </span>
      )}
    </button>
  );
}
