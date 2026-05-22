import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronRight,
  Copy,
  Pencil,
  SplitSquareHorizontal,
  SplitSquareVertical,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/cn';

interface Props {
  /** Anchor coords — typically `e.clientX/Y` from the contextmenu event. */
  x: number;
  y: number;
  /** Whether this tab can be closed. The store also guards this, but we
   *  visually dim the close item when the rule would block it. */
  closable: boolean;
  onClose: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onSplit: (direction: 'horizontal' | 'vertical') => void;
  onCloseTab: () => void;
}

/**
 * Right-click menu for a tab. Mirrors FileTree's portal/escape/outside-click
 * pattern and adds a hover-submenu for **Split tab → Horizontal/Vertical**.
 *
 * The submenu is inlined here (there's no need for a generic primitive yet);
 * timings (80ms open / 180ms close) match macOS/VS Code feel.
 */
export function TabContextMenu({
  x,
  y,
  closable,
  onClose,
  onRename,
  onDuplicate,
  onSplit,
  onCloseTab,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const splitItemRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });
  const [subOpen, setSubOpen] = useState(false);
  const [subPos, setSubPos] = useState<{ left: number; top: number; flipped: boolean }>({
    left: 0,
    top: 0,
    flipped: false,
  });
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  // Clamp the root menu into the viewport. We measure after mount so
  // overflow on the right/bottom edge of the screen flips the menu the
  // other way.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (nx + r.width > window.innerWidth - 8) nx = Math.max(8, window.innerWidth - r.width - 8);
    if (ny + r.height > window.innerHeight - 8) ny = Math.max(8, window.innerHeight - r.height - 8);
    setPos({ left: nx, top: ny });
  }, [x, y]);

  // Dismiss on outside-click and Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (subOpen) {
          setSubOpen(false);
          return;
        }
        onClose();
      } else if (e.key === 'ArrowLeft' && subOpen) {
        setSubOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, subOpen]);

  const cancelTimers = () => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleOpenSub = () => {
    cancelTimers();
    openTimer.current = window.setTimeout(() => {
      const trigger = splitItemRef.current;
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      const SUB_WIDTH = 180;
      const SUB_HEIGHT = 80;
      // Flip left if the submenu would go off the right edge.
      const flipped = r.right + 4 + SUB_WIDTH > window.innerWidth - 8;
      const left = flipped ? r.left - SUB_WIDTH - 4 : r.right + 4;
      let top = r.top;
      if (top + SUB_HEIGHT > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - SUB_HEIGHT - 8);
      }
      setSubPos({ left, top, flipped });
      setSubOpen(true);
    }, 80);
  };

  const scheduleCloseSub = () => {
    cancelTimers();
    closeTimer.current = window.setTimeout(() => {
      setSubOpen(false);
    }, 180);
  };

  const Item = ({
    icon: Icon,
    label,
    shortcut,
    onClick,
    disabled,
    danger,
    chevron,
    onMouseEnter,
    onMouseLeave,
    refProp,
  }: {
    icon: LucideIcon;
    label: string;
    shortcut?: string;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
    chevron?: boolean;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
    refProp?: React.RefObject<HTMLButtonElement>;
  }) => (
    <button
      ref={refProp}
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        onClick();
        onClose();
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors',
        'font-display text-[12px] tracking-tight',
        disabled
          ? 'cursor-not-allowed text-fg-subtle/60'
          : danger
            ? 'text-fg-base hover:bg-status-err/15 hover:text-status-err'
            : 'text-fg-base hover:bg-white/[0.06]',
        'focus-visible:bg-white/[0.06] focus:outline-none',
      )}
    >
      <Icon
        size={12}
        strokeWidth={2.1}
        className={cn(
          'shrink-0',
          disabled ? 'text-fg-subtle/50' : danger ? 'text-fg-muted' : 'text-fg-muted',
        )}
      />
      <span className="flex-1 truncate">{label}</span>
      {chevron ? (
        <ChevronRight size={11} strokeWidth={2.1} className="text-fg-subtle" />
      ) : shortcut ? (
        <span className="font-mono text-[10px] uppercase tracking-widest text-fg-subtle">
          {shortcut}
        </span>
      ) : null}
    </button>
  );

  return createPortal(
    <>
      <div
        ref={rootRef}
        role="menu"
        style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 9999 }}
        className={cn(
          'material-sheet w-[200px] rounded-lg p-1 shadow-2xl',
          'ring-1 ring-white/[0.10]',
          'animate-popover-in',
        )}
      >
        <Item icon={Pencil} label="Rename tab" onClick={onRename} />
        <Item icon={Copy} label="Duplicate tab" onClick={onDuplicate} />
        {/* Split tab — non-closing (chevron). Manage hover timers manually so
            keyboard ArrowRight can also open via the same path. */}
        <button
          ref={splitItemRef}
          type="button"
          role="menuitem"
          onClick={(e) => {
            e.preventDefault();
            // Toggle on click for keyboard / touch users.
            if (subOpen) setSubOpen(false);
            else scheduleOpenSub();
          }}
          onMouseEnter={scheduleOpenSub}
          onMouseLeave={scheduleCloseSub}
          aria-haspopup="menu"
          aria-expanded={subOpen}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors',
            'font-display text-[12px] tracking-tight text-fg-base',
            subOpen ? 'bg-white/[0.06]' : 'hover:bg-white/[0.06]',
            'focus-visible:bg-white/[0.06] focus:outline-none',
          )}
        >
          <SplitSquareHorizontal size={12} strokeWidth={2.1} className="shrink-0 text-fg-muted" />
          <span className="flex-1 truncate">Split tab</span>
          <ChevronRight size={11} strokeWidth={2.1} className="text-fg-subtle" />
        </button>
        <div className="my-1 h-px bg-white/[0.06]" aria-hidden />
        <Item
          icon={X}
          label="Close tab"
          danger
          disabled={!closable}
          onClick={onCloseTab}
        />
      </div>

      {subOpen && (
        <div
          role="menu"
          style={{ position: 'fixed', left: subPos.left, top: subPos.top, zIndex: 9999 }}
          onMouseEnter={cancelTimers}
          onMouseLeave={scheduleCloseSub}
          className={cn(
            'material-sheet w-[180px] rounded-lg p-1 shadow-2xl',
            'ring-1 ring-white/[0.10]',
            'animate-popover-in',
          )}
        >
          <Item
            icon={SplitSquareHorizontal}
            label="Horizontal"
            onClick={() => onSplit('horizontal')}
          />
          <Item
            icon={SplitSquareVertical}
            label="Vertical"
            onClick={() => onSplit('vertical')}
          />
        </div>
      )}
    </>,
    document.body,
  );
}
