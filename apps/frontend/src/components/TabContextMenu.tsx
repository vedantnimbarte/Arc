import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Copy,
  FolderMinus,
  FolderPlus,
  Pencil,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { groupColorDef, type TabGroupColorId } from '../lib/tabGroups';

/** A same-leaf group this tab could be added to. */
export interface GroupOption {
  id: string;
  name: string;
  color: TabGroupColorId;
}

interface Props {
  /** Anchor coords — typically `e.clientX/Y` from the contextmenu event. */
  x: number;
  y: number;
  /** Whether this tab can be closed. The store also guards this, but we
   *  visually dim the close item when the rule would block it. */
  closable: boolean;
  /** Whether this tab currently belongs to a group. */
  inGroup: boolean;
  /** Existing groups in the same leaf the tab could join (excludes its own). */
  groupOptions: GroupOption[];
  onClose: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onCloseTab: () => void;
  onNewGroup: () => void;
  onAddToGroup: (groupId: string) => void;
  onRemoveFromGroup: () => void;
}

/**
 * A single menu row. Hoisted to module scope so it keeps a stable component
 * identity across the parent's re-renders — otherwise React would unmount and
 * remount every row on each render, which can swallow an in-flight click.
 *
 * Activation runs on `pointerdown` rather than `click`: in the Tauri WebKit
 * webview a menu portaled in during a `contextmenu` event (so it lands under
 * the cursor) intermittently never receives the follow-up `click`, while
 * `pointerdown` is reliable. `preventDefault` keeps focus where it was so the
 * terminal/editor doesn't flash a blur.
 */
function MenuItem({
  icon: Icon,
  label,
  onSelect,
  disabled,
  danger,
}: {
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        onSelect();
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
        className={cn('shrink-0', disabled ? 'text-fg-subtle/50' : 'text-fg-muted')}
      />
      <span className="flex-1 truncate">{label}</span>
    </button>
  );
}

export function TabContextMenu({
  x,
  y,
  closable,
  inGroup,
  groupOptions,
  onClose,
  onRename,
  onDuplicate,
  onCloseTab,
  onNewGroup,
  onAddToGroup,
  onRemoveFromGroup,
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

  // Dismiss on outside-click and Escape. Listen on `pointerdown` (capture) so
  // it pairs with the item activation above — an inside press is recognised
  // before it could be mistaken for an outside dismiss.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  /** Wrap an action so it always dismisses the menu afterwards. */
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return createPortal(
    <div
      ref={rootRef}
      role="menu"
      data-tauri-drag-region="false"
      style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 9999 }}
      className={cn(
        'material-sheet w-[200px] rounded-lg p-1 shadow-2xl',
        'ring-1 ring-white/[0.10]',
        'animate-popover-in',
      )}
    >
      <MenuItem icon={Pencil} label="Rename tab" onSelect={run(onRename)} />
      <MenuItem icon={Copy} label="Duplicate tab" onSelect={run(onDuplicate)} />

      <div className="my-1 h-px bg-white/[0.06]" aria-hidden />

      <MenuItem icon={FolderPlus} label="Add to new group" onSelect={run(onNewGroup)} />
      {groupOptions.map((g) => (
        <button
          key={g.id}
          type="button"
          role="menuitem"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            onAddToGroup(g.id);
            onClose();
          }}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors',
            'font-display text-[12px] tracking-tight text-fg-base hover:bg-white/[0.06]',
            'focus-visible:bg-white/[0.06] focus:outline-none',
          )}
        >
          <span
            className="ml-0.5 mr-0.5 h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: groupColorDef(g.color).hex }}
            aria-hidden
          />
          <span className="flex-1 truncate">Add to {g.name.trim() || 'group'}</span>
        </button>
      ))}
      {inGroup && (
        <MenuItem icon={FolderMinus} label="Remove from group" onSelect={run(onRemoveFromGroup)} />
      )}

      <div className="my-1 h-px bg-white/[0.06]" aria-hidden />
      <MenuItem icon={X} label="Close tab" danger disabled={!closable} onSelect={run(onCloseTab)} />
    </div>,
    document.body,
  );
}
