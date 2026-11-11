import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface Props {
  /** State glyph — drawn as the node on the lane. */
  glyph: LucideIcon;
  /** Colour class for the glyph. This is the only saturated colour in a list,
   *  so it has to mean something: open, merged, failed, running. */
  glyphClass?: string;
  /** What a person wrote — display type. */
  title: ReactNode;
  /** `#123`, run number, tag — set after the title in mono. */
  number?: ReactNode;
  /** Second line: chips and facts. */
  meta?: ReactNode;
  /** Trailing content: counts, actions. Revealed on hover/focus when `hoverRight`. */
  right?: ReactNode;
  hoverRight?: boolean;
  /** Draw the vertical lane through the node. Off for rows that aren't a
   *  sequence (a file list), where a connecting line would claim one. */
  lane?: boolean;
  selected?: boolean;
  onClick?: () => void;
  title_?: string;
}

/**
 * One row in any GitHub list, drawn like a commit graph.
 *
 * Every list in this tab is a timeline — newest first — so the rows hang off
 * one continuous lane in the left gutter, and each row's state glyph is its
 * node. Scanning that column answers "what's open, what merged, what failed"
 * without reading a word. The list container trims the lane's loose ends with
 * `laneEnds` so it starts and stops on a node.
 */
export function ListRow({
  glyph: Glyph,
  glyphClass = 'text-fg-subtle',
  title,
  number,
  meta,
  right,
  hoverRight,
  lane = true,
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
        'group relative flex w-full items-stretch gap-2.5 rounded-md pr-2 text-left',
        'transition-colors duration-150',
        'focus-visible:outline-none focus-visible:shadow-focus',
        selected ? 'bg-surface-2' : 'hover:bg-surface-1',
      )}
    >
      {/* Selection marker: a bar on the row's leading edge, the way a git
          client marks the checked-out branch. */}
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-accent transition-opacity',
          selected ? 'opacity-100' : 'opacity-0',
        )}
      />

      <span className="flex w-7 shrink-0 flex-col items-center" aria-hidden>
        <span className={cn('lane-top h-[9px] w-[1.5px]', lane ? 'bg-fg-subtle opacity-60' : 'bg-transparent')} />
        <span className="flex h-4 w-4 items-center justify-center">
          <Glyph size={13} strokeWidth={2.2} className={glyphClass} />
        </span>
        <span className={cn('lane-bot w-[1.5px] flex-1', lane ? 'bg-fg-subtle opacity-60' : 'bg-transparent')} />
      </span>

      <span className="min-w-0 flex-1 py-[7px]">
        <span className="flex items-baseline gap-1.5">
          <span className="min-w-0 truncate font-display text-xs font-medium text-fg-base/90">
            {title}
          </span>
          {number != null && (
            <span className="shrink-0 font-mono text-2xs tabular-nums text-fg-subtle">{number}</span>
          )}
        </span>
        {meta && (
          <span className="mt-1 flex min-w-0 items-center gap-x-2.5 overflow-hidden whitespace-nowrap">
            {meta}
          </span>
        )}
      </span>

      {right && (
        <span
          className={cn(
            'flex shrink-0 items-center gap-1.5 py-[7px]',
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

/** For the element wrapping a run of `ListRow`s: hides the lane above the
 *  first node and below the last, so the line doesn't trail off the list. */
export const laneEnds =
  '[&>:first-child_.lane-top]:invisible [&>:last-child_.lane-bot]:invisible';
