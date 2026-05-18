import { useCallback, useRef } from 'react';

interface Props {
  /** Starting width of the pane being resized, in px. */
  getWidth: () => number;
  /** Apply the new width (already clamped by the store). */
  onResize: (next: number) => void;
  /**
   * Direction of growth when the mouse moves right.
   * - "left"  → resizing a pane that hugs the left edge (e.g., sidebar):
   *             dragging right *grows* its width.
   * - "right" → resizing a pane that hugs the right edge (e.g., chat):
   *             dragging right *shrinks* its width.
   */
  edge: 'left' | 'right';
}

/**
 * A 6px-wide invisible drag strip that reveals a 1px accent line on hover.
 * It captures pointer events on the document during drag so the cursor
 * never reverts to text-select even when the user drags across panes.
 */
export function ResizeHandle({ getWidth, onResize, edge }: Props) {
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startW: getWidth() };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (ev: PointerEvent) => {
        const start = dragRef.current;
        if (!start) return;
        const dx = ev.clientX - start.startX;
        const next = edge === 'left' ? start.startW + dx : start.startW - dx;
        onResize(next);
      };
      const onUp = () => {
        dragRef.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    },
    [edge, getWidth, onResize],
  );

  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={() => onResize(edge === 'left' ? 260 : 340)}
      className="group relative z-10 -mx-[3px] w-[6px] shrink-0 cursor-col-resize select-none"
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize · double-click to reset"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-accent/70 group-active:bg-accent"
      />
    </div>
  );
}
