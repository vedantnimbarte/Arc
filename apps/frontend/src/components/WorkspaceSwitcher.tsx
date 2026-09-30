import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react';
import { useWorkspace, type WorkspaceMeta } from '../state/workspace';
import { groupColorDef, rgba } from '../lib/tabGroups';
import { cn } from '../lib/cn';
import { WorkspaceEditPanel, DEFAULT_WORKSPACE_COLOR as DEFAULT_COLOR } from './WorkspaceEditPanel';
import { askConfirm } from '../state/confirm';

/**
 * Workspace dropdown at the far left of the top bar. The trigger shows the
 * active workspace; the popover lists every workspace (click to switch, hover
 * for edit/delete) with a "New workspace" row at the foot.
 */

/** Two-letter monogram from a workspace name: first letters of the first and
 *  last words, or the first two chars of a single word ("Workspace 1" → "W1"). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

const PANEL_W = 260;

/** Coloured squircle with the workspace's emoji or monogram. */
function WorkspaceBadge({ w, size }: { w: WorkspaceMeta; size: number }) {
  const hex = groupColorDef(w.color ?? DEFAULT_COLOR).hex;
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-[6px] font-display text-2xs font-semibold leading-none tracking-tight text-fg-base"
      style={{
        width: size,
        height: size,
        backgroundColor: rgba(hex, 0.24),
        border: `1px solid ${rgba(hex, 0.5)}`,
      }}
    >
      {w.icon ? <span className="text-xs">{w.icon}</span> : initials(w.name)}
    </span>
  );
}

export function WorkspaceSwitcher() {
  const workspaces = useWorkspace((s) => s.workspaces);
  const activeWorkspaceId = useWorkspace((s) => s.activeWorkspaceId);
  const tabs = useWorkspace((s) => s.tabs);
  const switchWorkspace = useWorkspace((s) => s.switchWorkspace);
  const createWorkspace = useWorkspace((s) => s.createWorkspace);
  const deleteWorkspace = useWorkspace((s) => s.deleteWorkspace);

  const [open, setOpen] = useState(false);
  /** Workspace being edited — swaps the popover body from list to edit panel. */
  const [editId, setEditId] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const active = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];
  const countFor = (id: string) => tabs.reduce((n, t) => (t.workspaceId === id ? n + 1 : n), 0);
  const close = () => {
    setOpen(false);
    setEditId(null);
  };

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      // Left-aligned to the trigger — it sits at the window's left edge.
      setPos({
        top: r.bottom + 6,
        left: Math.max(8, Math.min(r.left, window.innerWidth - PANEL_W - 8)),
      });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (editId) setEditId(null);
      else close();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, editId]);

  const requestDelete = (id: string, name: string) => {
    const count = countFor(id);
    void askConfirm({
      title: `Delete "${name}"?`,
      body: count > 0 ? `Its ${count} open tab${count === 1 ? '' : 's'} close with it.` : undefined,
      confirmLabel: 'delete',
      destructive: true,
    }).then((ok) => ok && deleteWorkspace(id));
  };

  if (!active) return null;

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${active.name} · switch workspace`}
        className={cn(
          'flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-md pl-1 pr-1.5',
          'transition-all duration-200 ease-apple',
          open
            ? 'bg-surface-3 text-fg-base'
            : 'text-fg-base/90 hover:bg-surface-2 hover:text-fg-base active:bg-surface-3',
        )}
      >
        <WorkspaceBadge w={active} size={20} />
        <span className="max-w-[180px] truncate font-display text-sm font-medium tracking-tight">
          {active.name}
        </span>
        <ChevronDown
          size={12}
          strokeWidth={2}
          className={cn(
            'shrink-0 text-fg-subtle transition-transform duration-200',
            open && 'rotate-180',
          )}
        />
      </button>

      {open &&
        pos &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: PANEL_W }}
            className="material-sheet z-50 animate-popover-in overflow-hidden rounded-lg bg-bg-panel shadow-sheet ring-1 ring-edge-2"
          >
            {editId ? (
              <div className="p-3">
                <WorkspaceEditPanel
                  key={editId}
                  workspaceId={editId}
                  onDone={() => setEditId(null)}
                />
              </div>
            ) : (
              <>
                <div className="px-3 pb-1 pt-2 font-display text-2xs uppercase tracking-wider text-fg-subtle/80">
                  Workspaces
                </div>
                <div role="menu" className="max-h-[60vh] overflow-y-auto px-1 pb-1">
                  {workspaces.map((w) => {
                    const isActive = w.id === active.id;
                    const count = countFor(w.id);
                    return (
                      <div
                        key={w.id}
                        className={cn(
                          'group/row flex items-center rounded-md transition-colors',
                          isActive ? 'bg-surface-2' : 'hover:bg-surface-1',
                        )}
                      >
                        <button
                          role="menuitem"
                          aria-current={isActive}
                          onClick={() => {
                            switchWorkspace(w.id);
                            close();
                          }}
                          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                        >
                          <WorkspaceBadge w={w} size={20} />
                          <span className="min-w-0 flex-1 truncate font-display text-sm tracking-tight text-fg-base/90">
                            {w.name}
                          </span>
                          <span
                            className="font-mono text-2xs tabular-nums text-fg-subtle"
                            title={`${count} tab${count === 1 ? '' : 's'}`}
                          >
                            {count}
                          </span>
                          <Check
                            size={13}
                            strokeWidth={2.2}
                            className={cn('shrink-0 text-accent-bright', !isActive && 'invisible')}
                          />
                        </button>
                        <div className="flex shrink-0 items-center gap-0.5 pr-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100">
                          <button
                            onClick={() => setEditId(w.id)}
                            aria-label={`Edit ${w.name}`}
                            title="Edit workspace"
                            className="flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-surface-3 hover:text-fg-base"
                          >
                            <Pencil size={12} strokeWidth={1.9} />
                          </button>
                          <button
                            onClick={() => {
                              close();
                              requestDelete(w.id, w.name);
                            }}
                            disabled={workspaces.length <= 1}
                            aria-label={`Delete ${w.name}`}
                            title="Delete workspace"
                            className="flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-rose-500/15 hover:text-rose-300 disabled:pointer-events-none disabled:opacity-30"
                          >
                            <Trash2 size={12} strokeWidth={1.9} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="border-t border-edge-1 p-1">
                  <button
                    onClick={() => {
                      createWorkspace();
                      close();
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-display text-sm tracking-tight text-fg-muted transition-colors hover:bg-surface-1 hover:text-fg-base"
                  >
                    <span className="flex h-5 w-5 items-center justify-center">
                      <Plus size={14} strokeWidth={2} />
                    </span>
                    New workspace
                  </button>
                </div>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
