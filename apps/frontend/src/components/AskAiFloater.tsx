import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles } from 'lucide-react';
import { useSelection } from '../state/selection';
import { formatBinding, getBinding } from '../state/shortcuts';

interface Props {
  /** Called when the user clicks the pill (or presses Enter while it's
   *  focused). Receives the live selection; the host (App.tsx) decides
   *  what to do with it. */
  onAsk: () => void;
}

const MARGIN = 8;
const OFFSET_ABOVE = 10;

/**
 * Floating "Ask ARC AI" pill, anchored above any non-empty text selection
 * in the Terminal or Editor. Renders into `document.body` so it floats
 * above pane stacking contexts.
 *
 * Hides while the user is actively dragging (mousedown → mouseup) — we
 * only want it to materialize once the selection has settled.
 */
export function AskAiFloater({ onAsk }: Props) {
  const selection = useSelection((s) => s.current);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Suppressed while a primary-button drag is in flight; xterm and
  // CodeMirror both fire selection-change events mid-drag and the pill
  // would otherwise jitter under the cursor.
  const [dragging, setDragging] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);

  // Track global mousedown/mouseup so we can hide while dragging.
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (e.button !== 0) return;
      // If the user is clicking the pill itself, don't treat it as a drag.
      const t = e.target as Node | null;
      if (t && pillRef.current?.contains(t)) return;
      setDragging(true);
    };
    const up = () => setDragging(false);
    window.addEventListener('mousedown', down, true);
    window.addEventListener('mouseup', up, true);
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('mouseup', up, true);
    };
  }, []);

  // Recompute position from the selection rect. We re-measure on the
  // pill's own size as well, so the horizontal centering stays correct
  // once the kbd label renders.
  useLayoutEffect(() => {
    if (!selection?.rect) {
      setPos(null);
      return;
    }
    const rect = selection.rect;
    const pillEl = pillRef.current;
    // First paint: estimate width so the initial frame isn't off-center.
    const w = pillEl?.offsetWidth ?? 160;
    const h = pillEl?.offsetHeight ?? 32;
    const cx = rect.left + rect.width / 2;
    let left = cx - w / 2;
    let top = rect.top - h - OFFSET_ABOVE;
    // If there isn't room above, flip below the selection.
    if (top < MARGIN) top = rect.top + rect.height + OFFSET_ABOVE;
    left = Math.max(MARGIN, Math.min(window.innerWidth - w - MARGIN, left));
    top = Math.max(MARGIN, Math.min(window.innerHeight - h - MARGIN, top));
    setPos({ left, top });
  }, [selection]);

  // Re-clamp on viewport changes so the pill doesn't slide off-screen
  // when the user resizes the window mid-selection.
  useEffect(() => {
    if (!selection) return;
    const onResize = () => {
      if (!selection.rect) return;
      const pillEl = pillRef.current;
      const w = pillEl?.offsetWidth ?? 160;
      const h = pillEl?.offsetHeight ?? 32;
      const r = selection.rect;
      const cx = r.left + r.width / 2;
      let left = cx - w / 2;
      let top = r.top - h - OFFSET_ABOVE;
      if (top < MARGIN) top = r.top + r.height + OFFSET_ABOVE;
      left = Math.max(MARGIN, Math.min(window.innerWidth - w - MARGIN, left));
      top = Math.max(MARGIN, Math.min(window.innerHeight - h - MARGIN, top));
      setPos({ left, top });
    };
    window.addEventListener('resize', onResize);
    // Capture-phase scroll: any scroll container in the tree (terminal
    // viewport, editor scroller, etc.) bubbles through here. Selection
    // rects don't follow scroll for xterm, so the safest thing is to
    // simply drop the pill; a fresh selection-change event will rebuild
    // it at the new position.
    const onScroll = () => useSelection.getState().clear();
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [selection]);

  if (!selection || !pos || dragging) return null;

  const shortcut = formatBinding(getBinding('ask-arc-ai'));

  return createPortal(
    <button
      ref={pillRef}
      type="button"
      onMouseDown={(e) => {
        // Prevent the selection from being collapsed when the pill is
        // pressed (mousedown on the pill would otherwise refocus and
        // clear the editor/terminal selection before our click fires).
        e.preventDefault();
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onAsk();
      }}
      style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 60 }}
      className={[
        'animate-popover-in motion-reduce:animate-none',
        'group flex h-8 items-center gap-2 rounded-full px-3',
        'bg-bg-base/85 backdrop-blur-xl backdrop-saturate-180',
        'border border-border-subtle ring-1 ring-white/[0.06]',
        'shadow-control transition-all duration-150 ease-apple',
        'hover:border-accent/45 hover:bg-bg-base/95 hover:shadow-glow-sm',
        'active:scale-[0.97]',
      ].join(' ')}
      aria-label="Ask ARC AI about the current selection"
    >
      <span className="flex h-[18px] w-[18px] items-center justify-center rounded-md bg-accent-soft text-accent transition-colors group-hover:text-accent-bright">
        <Sparkles size={11} strokeWidth={2.3} />
      </span>
      <span className="font-display text-[11.5px] font-medium tracking-tight text-fg-base">
        Ask ARC AI
      </span>
      <span className="rounded bg-white/[0.06] px-1.5 py-[2px] font-mono text-[9.5px] tracking-tight text-fg-subtle">
        {shortcut}
      </span>
    </button>,
    document.body,
  );
}
