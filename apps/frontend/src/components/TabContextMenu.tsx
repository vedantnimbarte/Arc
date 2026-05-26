import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Copy,
  Pencil,
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
  onCloseTab: () => void;
}

export function TabContextMenu({
  x,
  y,
  closable,
  onClose,
  onRename,
  onDuplicate,
  onCloseTab,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  // Clamp the root menu into the viewport.
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
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const Item = ({
    icon: Icon,
    label,
    shortcut,
    onClick,
    disabled,
    danger,
  }: {
    icon: LucideIcon;
    label: string;
    shortcut?: string;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
  }) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        onClick();
        onClose();
      }}
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
      {shortcut && (
        <span className="font-mono text-[10px] uppercase tracking-widest text-fg-subtle">
          {shortcut}
        </span>
      )}
    </button>
  );

  return createPortal(
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
      <div className="my-1 h-px bg-white/[0.06]" aria-hidden />
      <Item
        icon={X}
        label="Close tab"
        danger
        disabled={!closable}
        onClick={onCloseTab}
      />
    </div>,
    document.body,
  );
}
