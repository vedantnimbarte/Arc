import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight, Trash2, Ungroup } from 'lucide-react';
import { cn } from '../lib/cn';
import { useWorkspace, type TabGroup } from '../state/workspace';
import {
  TAB_GROUP_COLORS,
  groupColorTokens,
  type TabGroupColorId,
} from '../lib/tabGroups';

interface Props {
  /** Anchor coords — typically the chip's bottom-left in viewport space. */
  x: number;
  y: number;
  group: TabGroup;
  onClose: () => void;
}

/**
 * The tab-group editor popover — Chrome's group bubble, reimagined for ARC's
 * graphite surface. Rename inline, repaint from the 8-colour palette, and run
 * the collapse / ungroup / close actions. Reads its actions straight off the
 * workspace store so the strip stays a thin trigger.
 */
export function TabGroupMenu({ x, y, group, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });
  const [name, setName] = useState(group.name);

  const renameGroup = useWorkspace((s) => s.renameGroup);
  const setGroupColor = useWorkspace((s) => s.setGroupColor);
  const toggleCollapsed = useWorkspace((s) => s.toggleGroupCollapsed);
  const ungroupGroup = useWorkspace((s) => s.ungroupGroup);
  const closeGroup = useWorkspace((s) => s.closeGroup);

  const tokens = groupColorTokens(group.color);

  // Clamp into the viewport.
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

  // Autofocus the name field so the user can start typing immediately.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  // Dismiss on outside-click / Escape, committing the name first.
  useEffect(() => {
    const commit = () => {
      if (name !== group.name) renameGroup(group.id, name);
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target || rootRef.current?.contains(target)) return;
      commit();
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        commit();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [name, group.name, group.id, renameGroup, onClose]);

  const Item = ({
    icon: Icon,
    label,
    onClick,
    danger,
  }: {
    icon: typeof Ungroup;
    label: string;
    onClick: () => void;
    danger?: boolean;
  }) => (
    <button
      type="button"
      role="menuitem"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        onClick();
        onClose();
      }}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors',
        'font-display text-[12px] tracking-tight',
        danger
          ? 'text-fg-base hover:bg-status-err/15 hover:text-status-err'
          : 'text-fg-base hover:bg-white/[0.06]',
      )}
    >
      <Icon size={13} strokeWidth={2.1} className="shrink-0 text-fg-muted" />
      <span className="flex-1 truncate">{label}</span>
    </button>
  );

  return createPortal(
    <div
      ref={rootRef}
      role="menu"
      style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 9999 }}
      className={cn(
        'material-sheet w-[244px] rounded-xl p-2.5 shadow-2xl',
        'ring-1 ring-white/[0.10]',
        'animate-popover-in',
      )}
    >
      {/* Name field — the coloured rail echoes the group's hue. */}
      <div
        className="mb-2.5 flex items-center gap-2 rounded-lg px-2 py-1.5"
        style={{ background: tokens.chipBg, boxShadow: `inset 2px 0 0 0 ${tokens.solid}` }}
      >
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (name !== group.name) renameGroup(group.id, name);
              onClose();
            }
          }}
          placeholder="Name this group"
          className={cn(
            'w-full bg-transparent font-display text-[13px] font-semibold tracking-tight',
            'text-fg-base placeholder:font-medium placeholder:text-fg-subtle',
            'focus:outline-none',
          )}
        />
      </div>

      {/* Colour palette. */}
      <div className="mb-2 grid grid-cols-8 gap-1 px-0.5">
        {TAB_GROUP_COLORS.map((c) => {
          const selected = c.id === group.color;
          return (
            <button
              key={c.id}
              type="button"
              title={c.label}
              aria-label={c.label}
              aria-pressed={selected}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                setGroupColor(group.id, c.id as TabGroupColorId);
              }}
              className={cn(
                'relative flex h-5 w-5 items-center justify-center rounded-full transition-transform',
                'hover:scale-110 focus:outline-none',
              )}
              style={{
                background: c.hex,
                boxShadow: selected
                  ? `0 0 0 2px rgb(22,22,24), 0 0 0 3.5px ${c.hex}`
                  : 'inset 0 0 0 1px rgba(0,0,0,0.25)',
              }}
            >
              {selected && <Check size={11} strokeWidth={3} className="text-black/70" />}
            </button>
          );
        })}
      </div>

      <div className="my-1.5 h-px bg-white/[0.06]" aria-hidden />

      <Item
        icon={group.collapsed ? ChevronRight : ChevronDown}
        label={group.collapsed ? 'Expand group' : 'Collapse group'}
        onClick={() => toggleCollapsed(group.id)}
      />
      <Item icon={Ungroup} label="Ungroup" onClick={() => ungroupGroup(group.id)} />
      <Item icon={Trash2} label="Close group" danger onClick={() => closeGroup(group.id)} />
    </div>,
    document.body,
  );
}
