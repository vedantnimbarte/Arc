// Live pixel dimensions of each rendered pane, kept outside the store so the
// synchronous layout actions (addTab/split) can read them without a re-render.
// PaneLeafView registers/updates its rect via a ResizeObserver.

const rects = new Map<string, { w: number; h: number }>();

export function setPaneRect(paneId: string, w: number, h: number): void {
  rects.set(paneId, { w, h });
}

export function dropPaneRect(paneId: string): void {
  rects.delete(paneId);
}

/**
 * Dwindle direction for splitting `paneId`: split along its longer side, like
 * Hyprland's dwindle layout. Wide pane → new pane on the right; tall pane →
 * new pane below. Defaults to 'right' when the rect isn't known yet.
 */
export function dwindleSide(paneId: string): 'right' | 'bottom' {
  const r = rects.get(paneId);
  if (!r) return 'right';
  return r.w >= r.h ? 'right' : 'bottom';
}
