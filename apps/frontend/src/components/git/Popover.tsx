import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';

/**
 * A trigger button plus a small menu that opens under it. Portaled with fixed
 * positioning so scrolling lists and clipped panes don't cut it off. Content
 * only mounts while open, so any state inside it starts fresh each time.
 */
export function Popover({
  label,
  trigger,
  triggerClassName,
  disabled,
  width = 220,
  children,
}: {
  /** Accessible name and tooltip for the trigger. */
  label: string;
  trigger: ReactNode;
  triggerClassName?: string;
  disabled?: boolean;
  width?: number;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number }>({ left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    const menuH = menuRef.current?.offsetHeight ?? 200;
    setPos(
      r.bottom + 4 + menuH > window.innerHeight
        ? { bottom: window.innerHeight - r.top + 4, left }
        : { top: r.bottom + 4, left },
    );
  }, [open, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown, { capture: true });
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, { capture: true });
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ ...pos, width }}
            className="fixed z-[9999] rounded-lg bg-bg-panel p-1 shadow-sheet ring-1 ring-edge-2 animate-fade-in"
          >
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </>
  );
}

export function MenuItem({
  onClick,
  danger,
  disabled,
  hint,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Second, quieter line under the label. */
  hint?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left font-display text-xs transition-colors',
        'disabled:pointer-events-none disabled:opacity-40',
        danger ? 'text-status-err hover:bg-status-err/10' : 'text-fg-base hover:bg-bg-hover',
      )}
    >
      <span>{children}</span>
      {hint && <span className="mt-0.5 text-2xs text-fg-subtle">{hint}</span>}
    </button>
  );
}
