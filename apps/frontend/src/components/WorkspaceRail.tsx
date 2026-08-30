import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Settings as SettingsIcon } from 'lucide-react';
import { useWorkspace } from '../state/workspace';
import { groupColorDef, rgba } from '../lib/tabGroups';
import { cn } from '../lib/cn';
import { WorkspaceEditPanel, DEFAULT_WORKSPACE_COLOR as DEFAULT_COLOR } from './WorkspaceEditPanel';
import { askConfirm } from '../state/confirm';

/**
 * Discord/Slack-style vertical workspace rail — the app's leftmost column.
 * Each workspace is an icon (emoji or name initials on a coloured squircle);
 * clicking switches, right-clicking opens rename/icon/delete, the bottom `+`
 * creates a new one, and a settings button anchors the foot of the rail.
 */

/** Two-letter monogram from a workspace name: first letters of the first and
 *  last words, or the first two chars of a single word ("Workspace 1" → "W1"). */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

type Anchor = { id: string; x: number; y: number };

export function WorkspaceRail({ onOpenSettings }: { onOpenSettings: () => void }) {
  const workspaces = useWorkspace((s) => s.workspaces);
  const activeWorkspaceId = useWorkspace((s) => s.activeWorkspaceId);
  const tabs = useWorkspace((s) => s.tabs);
  const switchWorkspace = useWorkspace((s) => s.switchWorkspace);
  const createWorkspace = useWorkspace((s) => s.createWorkspace);
  const deleteWorkspace = useWorkspace((s) => s.deleteWorkspace);

  const [menu, setMenu] = useState<Anchor | null>(null);
  const [edit, setEdit] = useState<Anchor | null>(null);

  const countFor = (id: string) => tabs.reduce((n, t) => (t.workspaceId === id ? n + 1 : n), 0);

  // One outside-click / Escape handler for whichever popover is open.
  useEffect(() => {
    if (!menu && !edit) return;
    const close = () => {
      setMenu(null);
      setEdit(null);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('[data-rail-popover]')) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu, edit]);

  const openMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setEdit(null);
    setMenu({ id, x: r.right + 8, y: r.top });
  };

  const requestDelete = (id: string, name: string) => {
    const count = countFor(id);
    void askConfirm({
      title: `Delete "${name}"?`,
      body:
        count > 0
          ? `Its ${count} open tab${count === 1 ? '' : 's'} close with it.`
          : undefined,
      confirmLabel: 'delete',
      destructive: true,
    }).then((ok) => ok && deleteWorkspace(id));
  };

  const menuWorkspace = menu && workspaces.find((w) => w.id === menu.id);

  return (
    <div className="material-sidebar flex h-full w-12 shrink-0 flex-col items-center border-r border-border-hairline">
      {/* Drag region aligned to the top bar so the window still moves up here. */}
      <div data-tauri-drag-region="deep" className="h-9 w-full shrink-0" />

      <div className="flex min-h-0 flex-1 flex-col items-center gap-3.5 overflow-y-auto py-2">
        {workspaces.map((w) => {
          const isActive = w.id === activeWorkspaceId;
          const hex = groupColorDef(w.color ?? DEFAULT_COLOR).hex;
          const count = countFor(w.id);
          return (
            <div key={w.id} className="group/rail relative flex items-center justify-center">
              {/* Active/hover indicator pill on the rail edge — tinted to the
                  workspace colour when active, neutral dot on hover. */}
              <span
                className={cn(
                  'absolute -left-[7px] w-[3px] rounded-r-full transition-all duration-200 ease-apple',
                  isActive
                    ? 'h-4 opacity-100'
                    : 'h-1 bg-fg-base opacity-0 group-hover/rail:opacity-60',
                )}
                style={isActive ? { backgroundColor: hex } : undefined}
                aria-hidden
              />
              <button
                onClick={() => switchWorkspace(w.id)}
                onContextMenu={(e) => openMenu(e, w.id)}
                title={`${w.name} · ${count} tab${count === 1 ? '' : 's'}`}
                aria-label={`Switch to ${w.name}`}
                aria-current={isActive}
                className={cn(
                  'ws-icon flex h-9 w-9 items-center justify-center overflow-hidden',
                  'font-display text-sm font-semibold leading-none tracking-tight',
                  isActive
                    ? 'rounded-[13px] text-fg-base'
                    : 'rounded-[16px] text-fg-muted hover:rounded-[13px] hover:text-fg-base',
                )}
                style={{
                  ['--ws-bg' as string]: rgba(hex, isActive ? 0.24 : 0.11),
                  ['--ws-bg-hover' as string]: rgba(hex, isActive ? 0.24 : 0.2),
                  ['--ws-bd' as string]: isActive ? rgba(hex, 0.5) : 'transparent',
                }}
              >
                {w.icon ? <span className="text-lg">{w.icon}</span> : initials(w.name)}
              </button>
              {count > 0 && (
                <span className="pointer-events-none absolute -bottom-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-bg-base bg-bg-panel px-1 font-mono text-2xs leading-none text-fg-muted">
                  {count}
                </span>
              )}
            </div>
          );
        })}

        <button
          onClick={() => createWorkspace()}
          title="New workspace"
          aria-label="New workspace"
          className="ws-icon flex h-9 w-9 items-center justify-center rounded-[16px] text-fg-subtle hover:rounded-[13px] hover:text-accent-bright"
        >
          <Plus size={16} strokeWidth={2} />
        </button>
      </div>

      {/* Foot: settings/profile anchor. */}
      <div className="flex shrink-0 flex-col items-center gap-1 pb-2 pt-1">
        <div className="mb-0.5 h-px w-5 bg-surface-2" aria-hidden />
        <button
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Open settings"
          className="ws-icon flex h-8 w-8 items-center justify-center rounded-full text-fg-muted hover:text-fg-base"
        >
          <SettingsIcon size={15} strokeWidth={1.8} />
        </button>
      </div>

      {/* ─── Context menu ─────────────────────────────────────────────── */}
      {menu &&
        menuWorkspace &&
        createPortal(
          <div
            data-rail-popover
            role="menu"
            style={{ position: 'fixed', top: menu.y, left: menu.x }}
            className="material-sheet z-50 w-44 animate-popover-in overflow-hidden rounded-md bg-bg-panel py-1 shadow-sheet ring-1 ring-edge-2"
          >
            <div className="truncate px-3 pb-1 pt-0.5 font-display text-2xs uppercase tracking-wider text-fg-subtle/80">
              {menuWorkspace.name}
            </div>
            <MenuItem
              label="Edit workspace…"
              onClick={() => {
                setEdit({ id: menu.id, x: menu.x, y: menu.y });
                setMenu(null);
              }}
            />
            <div className="my-1 border-t border-edge-1" />
            <MenuItem
              label="Delete"
              danger
              disabled={workspaces.length <= 1}
              onClick={() => {
                requestDelete(menu.id, menuWorkspace.name);
                setMenu(null);
              }}
            />
          </div>,
          document.body,
        )}

      {/* ─── Edit popover — name + icon + colour ──────────────────────── */}
      {edit &&
        (() => {
          const w = workspaces.find((x) => x.id === edit.id);
          if (!w) return null;
          return createPortal(
            <div
              data-rail-popover
              style={{ position: 'fixed', top: edit.y, left: edit.x }}
              className="material-sheet z-50 w-[248px] animate-popover-in rounded-md bg-bg-panel p-3 shadow-sheet ring-1 ring-edge-2"
            >
              <WorkspaceEditPanel key={w.id} workspaceId={w.id} onDone={() => setEdit(null)} />
            </div>,
            document.body,
          );
        })()}
    </div>
  );
}

function MenuItem({
  label,
  onClick,
  danger,
  disabled,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-center px-3 py-1.5 text-left font-display text-sm tracking-tight transition-colors disabled:pointer-events-none disabled:opacity-40',
        danger
          ? 'text-rose-300/90 hover:bg-rose-500/15 hover:text-rose-200'
          : 'text-fg-base/90 hover:bg-surface-2',
      )}
    >
      {label}
    </button>
  );
}
