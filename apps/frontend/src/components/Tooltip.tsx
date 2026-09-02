import { cn } from '../lib/cn';

type Side = 'top' | 'bottom' | 'left' | 'right';

const PLACEMENT: Record<Side, string> = {
  top: 'bottom-full left-1/2 mb-1.5 -translate-x-1/2',
  bottom: 'top-full left-1/2 mt-1.5 -translate-x-1/2',
  left: 'right-full top-1/2 mr-1.5 -translate-y-1/2',
  right: 'left-full top-1/2 ml-1.5 -translate-y-1/2',
};

/** `align="end"` variants for the vertical sides: the bubble's right edge
 *  lines up with the control's instead of centring on it. For a control near
 *  the window's right edge, centring is what pushes the bubble off-screen. */
const PLACEMENT_END: Partial<Record<Side, string>> = {
  top: 'bottom-full right-0 mb-1.5',
  bottom: 'top-full right-0 mt-1.5',
};

interface Props {
  /** What the wrapped control does. Keep it to a couple of words. */
  label: string;
  /** Pre-formatted key combo shown after the label (e.g. "⌘B"). */
  kbd?: string;
  /** Which way the bubble opens. Pick one that stays inside the window. */
  side?: Side;
  /** Cross-axis alignment for `top`/`bottom`. Use `end` on controls close to
   *  the window's right edge, where a centred bubble would overflow. */
  align?: 'center' | 'end';
  children: React.ReactNode;
  className?: string;
}

/**
 * Instant, styled tooltip for icon-only chrome.
 *
 * Native `title=` is what this replaces: it waits ~1s before appearing, can't
 * be styled, and never fires on keyboard focus — so a strip of unlabelled
 * icons stays silent to anyone tabbing through it. This shows after 150ms on
 * hover and immediately on focus.
 *
 * CSS-only (`group-hover` / `group-focus-within`), so it costs no state and no
 * dependency. The bubble is `aria-hidden` decoration — the wrapped control
 * keeps its own `aria-label`, which is what a screen reader actually announces.
 *
 * ponytail: no portal, so the bubble is clipped by any scrolling or
 * `overflow-hidden` ancestor. Fine for the chrome it's used on; anything
 * inside a scroll container needs positioning logic this deliberately skips.
 */
export function Tooltip({
  label,
  kbd,
  side = 'bottom',
  align = 'center',
  children,
  className,
}: Props) {
  const placement = (align === 'end' && PLACEMENT_END[side]) || PLACEMENT[side];
  return (
    <span className={cn('group/tip relative inline-flex', className)}>
      {children}
      <span
        role="tooltip"
        aria-hidden
        className={cn(
          'pointer-events-none absolute z-[70] flex items-center gap-1.5 whitespace-nowrap',
          'rounded-md border border-edge-2 bg-bg-panel px-2 py-1 shadow-sheet',
          'font-display text-2xs tracking-tight text-fg-base',
          'opacity-0 delay-150 duration-100 transition-opacity',
          'group-hover/tip:opacity-100',
          'group-focus-within/tip:opacity-100 group-focus-within/tip:delay-0',
          'motion-reduce:transition-none',
          placement,
        )}
      >
        {label}
        {kbd && <kbd className="font-mono text-fg-subtle">{kbd}</kbd>}
      </span>
    </span>
  );
}
