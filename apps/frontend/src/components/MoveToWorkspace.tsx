import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRightLeft, ChevronRight, Plus } from 'lucide-react';
import { useWorkspace } from '../state/workspace';
import { groupColorDef, rgba } from '../lib/tabGroups';
import { initials } from './WorkspaceRail';
import { DEFAULT_WORKSPACE_COLOR } from './WorkspaceEditPanel';
import { cn } from '../lib/cn';

/** Parent menus skip their outside-click dismiss for targets inside this, so
 *  picking a workspace in the portaled flyout doesn't close the menu first. */
const FLYOUT_ATTR = 'data-menu-flyout';
export const isInFlyout = (t: EventTarget | null) =>
  !!(t as Element | null)?.closest?.(`[${FLYOUT_ATTR}]`);

const FLYOUT_W = 216;

/** The icon every "Move to workspace" control uses. */
export const MoveIcon = ArrowRightLeft;

/**
 * "Move to workspace ›" row for a menu (the tab right-click menu). Opens the
 * workspace list beside the menu.
 *
 * Activates on `pointerdown` like `TabContextMenu`'s rows: in the Tauri
 * webview a menu portaled in mid-gesture can miss the follow-up `click`.
 */
export function MoveToWorkspaceItem({
  tabId,
  onDone,
  className,
}: {
  tabId: string;
  /** Close the parent menu — called after a move. */
  onDone: () => void;
  /** Row styling, so the item matches the menu it sits in. */
  className?: string;
}) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<{ viaKeyboard: boolean } | null>(null);

  return (
    <>
      <button
        ref={rowRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={!!open}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => (o ? null : { viaKeyboard: false }));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
            e.preventDefault();
            setOpen({ viaKeyboard: true });
          }
        }}
        className={cn(
          'flex w-full items-center gap-2 text-left font-display text-sm tracking-tight text-fg-base transition-colors hover:bg-surface-2 focus:outline-none focus-visible:bg-surface-2',
          open && 'bg-surface-2',
          className,
        )}
      >
        <MoveIcon size={12} strokeWidth={2.1} className="shrink-0 text-fg-muted" />
        <span className="flex-1 truncate">Move to workspace</span>
        <ChevronRight size={12} strokeWidth={2.1} className="shrink-0 text-fg-subtle" />
      </button>
      {open && rowRef.current && (
        <WorkspaceFlyout
          anchorEl={rowRef.current}
          placement="side"
          tabId={tabId}
          focusFirst={open.viaKeyboard}
          onDismiss={(refocus) => {
            setOpen(null);
            if (refocus) rowRef.current?.focus();
          }}
          onDone={onDone}
        />
      )}
    </>
  );
}

/**
 * The workspace list: every workspace but the tab's own (icon, name, tab
 * count), then "New workspace". Picking one moves the tab there and follows it.
 *
 * `side` opens beside a menu row (flipping left when out of room); `below`
 * hangs under a standalone icon button. Dismisses itself on an outside press
 * or Escape — presses on `anchorEl` are left to the trigger, so it can toggle.
 */
export function WorkspaceFlyout({
  anchorEl,
  placement,
  tabId,
  focusFirst = false,
  onDismiss,
  onDone,
}: {
  anchorEl: HTMLElement;
  placement: 'side' | 'below';
  tabId: string;
  focusFirst?: boolean;
  /** Close the flyout; `refocus` is true for keyboard dismissals. */
  onDismiss: (refocus: boolean) => void;
  /** Called after a move. Defaults to dismissing. */
  onDone?: () => void;
}) {
  const workspaces = useWorkspace((s) => s.workspaces);
  const tabs = useWorkspace((s) => s.tabs);
  const moveTabToWorkspace = useWorkspace((s) => s.moveTabToWorkspace);
  const createWorkspace = useWorkspace((s) => s.createWorkspace);
  const rootRef = useRef<HTMLDivElement>(null);

  const from = tabs.find((t) => t.id === tabId)?.workspaceId;
  const others = workspaces.filter((w) => w.id !== from);

  const anchor = anchorEl.getBoundingClientRect();
  const clampX = (x: number) => Math.max(8, Math.min(x, window.innerWidth - FLYOUT_W - 8));
  const flipped = placement === 'side' && anchor.right + 4 + FLYOUT_W > window.innerWidth - 8;
  const left =
    placement === 'below'
      ? clampX(anchor.left)
      : flipped
        ? Math.max(8, anchor.left - FLYOUT_W - 4)
        : anchor.right + 4;
  const wantTop = placement === 'below' ? anchor.bottom + 4 : anchor.top - 4;
  // Top clamped once the real height is known.
  const [top, setTop] = useState(wantTop);
  useLayoutEffect(() => {
    const h = rootRef.current?.offsetHeight ?? 0;
    setTop(Math.max(8, Math.min(wantTop, window.innerHeight - h - 8)));
    if (focusFirst) rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [wantTop, focusFirst]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (rootRef.current?.contains(t) || anchorEl.contains(t))) return;
      onDismiss(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onDismiss(true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchorEl, onDismiss]);

  const pick = (run: () => void) => (e: React.PointerEvent | React.KeyboardEvent) => {
    if ('button' in e && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    run();
    (onDone ?? (() => onDismiss(false)))();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (placement === 'side' && e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      onDismiss(true);
      return;
    }
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const items = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + step + items.length) % items.length]?.focus();
  };

  const row =
    'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left font-display text-sm tracking-tight transition-colors hover:bg-surface-2 focus:outline-none focus-visible:bg-surface-2';
  const moveToNew = () => moveTabToWorkspace(tabId, createWorkspace());

  return createPortal(
    <div
      ref={rootRef}
      role="menu"
      aria-label="Move to workspace"
      {...{ [FLYOUT_ATTR]: '' }}
      data-tauri-drag-region="false"
      onKeyDown={onKeyDown}
      // Portaled, but React still bubbles to the trigger's ancestors (a pane
      // header focuses its pane on mousedown) — keep presses in here.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{ position: 'fixed', left, top, width: FLYOUT_W, zIndex: 10000 }}
      className={cn(
        'material-sheet animate-popover-in rounded-lg bg-bg-panel p-1 shadow-sheet ring-1 ring-edge-2 motion-reduce:animate-none',
        flipped ? 'origin-top-right' : 'origin-top-left',
      )}
    >
      {others.map((w) => {
        const hex = groupColorDef(w.color ?? DEFAULT_WORKSPACE_COLOR).hex;
        const count = tabs.reduce((n, t) => (t.workspaceId === w.id ? n + 1 : n), 0);
        const run = () => moveTabToWorkspace(tabId, w.id);
        return (
          <button
            key={w.id}
            type="button"
            role="menuitem"
            onPointerDown={pick(run)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && pick(run)(e)}
            className={cn(row, 'text-fg-base')}
          >
            {/* Same squircle as the workspace rail, at menu scale. */}
            <span
              aria-hidden
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] text-[9px] font-semibold leading-none text-fg-base"
              style={{ background: rgba(hex, 0.22), boxShadow: `inset 0 0 0 1px ${rgba(hex, 0.45)}` }}
            >
              {w.icon ? <span className="text-xs">{w.icon}</span> : initials(w.name)}
            </span>
            <span className="flex-1 truncate">{w.name}</span>
            <span
              className="shrink-0 font-display text-2xs tabular-nums text-fg-subtle"
              aria-label={`${count} ${count === 1 ? 'tab' : 'tabs'}`}
            >
              {count}
            </span>
          </button>
        );
      })}
      {others.length > 0 && <div className="my-1 h-px bg-surface-2" aria-hidden />}
      <button
        type="button"
        role="menuitem"
        onPointerDown={pick(moveToNew)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && pick(moveToNew)(e)}
        className={cn(row, 'text-fg-muted hover:text-fg-base')}
      >
        <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] ring-1 ring-inset ring-edge-2">
          <Plus size={11} strokeWidth={2.2} />
        </span>
        <span className="flex-1 truncate">New workspace</span>
      </button>
    </div>,
    document.body,
  );
}
