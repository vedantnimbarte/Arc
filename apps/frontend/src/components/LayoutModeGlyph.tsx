import type { LayoutMode } from '../state/workspace';

/** Name + one-line description per layout mode, shared by the top-bar picker
 *  and the Settings default-layout cards. */
export const LAYOUT_MODE_INFO: Record<LayoutMode, { label: string; hint: string }> = {
  tiling: { label: 'Tiles', hint: 'Each tab gets its own pane' },
  standard: { label: 'Tabs', hint: 'One pane, tabs in a strip' },
  floating: { label: 'Floating', hint: 'One window, the rest stacked' },
};

/** Miniature of the arrangement each mode actually produces, so the choice
 *  reads without the label. Draws in `currentColor`. */
export function LayoutModeGlyph({ mode, className }: { mode: LayoutMode; className?: string }) {
  return (
    <svg viewBox="0 0 48 30" className={className} aria-hidden>
      {mode === 'tiling' ? (
        <>
          <rect x="1" y="1" width="21.5" height="28" rx="2.5" fill="currentColor" opacity={0.5} />
          <rect x="25.5" y="1" width="21.5" height="13" rx="2.5" fill="currentColor" opacity={0.5} />
          <rect x="25.5" y="16" width="21.5" height="13" rx="2.5" fill="currentColor" opacity={0.5} />
        </>
      ) : mode === 'standard' ? (
        <>
          <rect x="1" y="1" width="15" height="6" rx="1.5" fill="currentColor" opacity={0.75} />
          <rect x="17.5" y="1" width="15" height="6" rx="1.5" fill="currentColor" opacity={0.28} />
          <rect x="34" y="1" width="13" height="6" rx="1.5" fill="currentColor" opacity={0.28} />
          <rect x="1" y="9" width="46" height="20" rx="2.5" fill="currentColor" opacity={0.5} />
        </>
      ) : (
        <>
          {/* The deck: front card whole, the ones behind tucked and narrowing. */}
          <rect x="1" y="1" width="13" height="11" rx="2" fill="currentColor" opacity={0.75} />
          <rect x="1.75" y="13.5" width="11.5" height="4.5" rx="1.5" fill="currentColor" opacity={0.4} />
          <rect x="2.5" y="19" width="10" height="4.5" rx="1.5" fill="currentColor" opacity={0.28} />
          <rect x="3.25" y="24.5" width="8.5" height="4.5" rx="1.5" fill="currentColor" opacity={0.18} />
          <rect x="16" y="1" width="31" height="28" rx="2.5" fill="currentColor" opacity={0.5} />
        </>
      )}
    </svg>
  );
}
