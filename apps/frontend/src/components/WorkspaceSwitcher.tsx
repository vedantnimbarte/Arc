import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react';
import { useWorkspace } from '../state/workspace';
import { cn } from '../lib/cn';

/**
 * Toolbar workspace switcher. A pill shows the active workspace + its tab
 * count; clicking opens a dropdown to switch, rename, delete, or create a
 * workspace. Each row shows how many tabs live in that workspace.
 */
export function WorkspaceSwitcher() {
  const workspaces = useWorkspace((s) => s.workspaces);
  const activeWorkspaceId = useWorkspace((s) => s.activeWorkspaceId);
  const tabs = useWorkspace((s) => s.tabs);
  const switchWorkspace = useWorkspace((s) => s.switchWorkspace);
  const createWorkspace = useWorkspace((s) => s.createWorkspace);
  const renameWorkspace = useWorkspace((s) => s.renameWorkspace);
  const deleteWorkspace = useWorkspace((s) => s.deleteWorkspace);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const active = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];
  const countFor = (id: string) => tabs.reduce((n, t) => (t.workspaceId === id ? n + 1 : n), 0);
  const activeCount = active ? countFor(active.id) : 0;

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 4, left: r.left });
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
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const requestDelete = (id: string, name: string) => {
    const count = countFor(id);
    const msg =
      count > 0
        ? `Delete "${name}" and close its ${count} tab${count === 1 ? '' : 's'}?`
        : `Delete "${name}"?`;
    if (window.confirm(msg)) deleteWorkspace(id);
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'group flex h-[28px] max-w-[220px] shrink-0 items-center gap-1.5 rounded-[7px] px-2',
          'border border-white/[0.05] bg-white/[0.03] text-fg-muted',
          'transition-all duration-150 ease-apple hover:border-white/[0.09] hover:bg-white/[0.06] hover:text-fg-base',
        )}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch workspace"
      >
        <span className="min-w-0 flex-1 truncate font-display text-[12px] font-medium tracking-tight">
          {active?.name ?? 'Workspace'}
        </span>
        <span className="shrink-0 rounded-full bg-white/[0.07] px-1.5 font-mono text-[10px] text-fg-subtle">
          {activeCount}
        </span>
        <ChevronDown
          size={12}
          strokeWidth={2.2}
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
            ref={menuRef}
            role="menu"
            style={{ position: 'fixed', top: pos.top, left: pos.left }}
            className="material-sheet z-50 w-64 animate-popover-in overflow-hidden rounded-md bg-bg-panel py-1 shadow-sheet ring-1 ring-white/10"
          >
            <div className="px-3 pb-1 pt-0.5 font-display text-[9.5px] uppercase tracking-wider text-fg-subtle/80">
              Workspaces
            </div>
            {workspaces.map((w) => {
              const isActive = w.id === activeWorkspaceId;
              const count = countFor(w.id);
              if (renamingId === w.id) {
                return (
                  <RenameRow
                    key={w.id}
                    initial={w.name}
                    onCommit={(name) => {
                      renameWorkspace(w.id, name);
                      setRenamingId(null);
                    }}
                    onCancel={() => setRenamingId(null)}
                  />
                );
              }
              return (
                <div
                  key={w.id}
                  className="group/row flex items-center gap-2 px-2 py-1.5 transition-colors hover:bg-white/[0.05]"
                >
                  <button
                    role="menuitem"
                    onClick={() => {
                      switchWorkspace(w.id);
                      setOpen(false);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                      {isActive && <Check size={13} strokeWidth={2.5} className="text-accent-bright" />}
                    </span>
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate font-display text-[12px] tracking-tight',
                        isActive ? 'text-fg-base' : 'text-fg-base/85',
                      )}
                    >
                      {w.name}
                    </span>
                    <span className="shrink-0 rounded-full bg-white/[0.06] px-1.5 font-mono text-[10px] text-fg-subtle">
                      {count}
                    </span>
                  </button>
                  <button
                    onClick={() => setRenamingId(w.id)}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-subtle opacity-0 transition-opacity hover:bg-white/10 hover:text-fg-base group-hover/row:opacity-100"
                    aria-label="Rename workspace"
                    title="Rename"
                  >
                    <Pencil size={11} strokeWidth={2} />
                  </button>
                  <button
                    onClick={() => requestDelete(w.id, w.name)}
                    disabled={workspaces.length <= 1}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-subtle opacity-0 transition-opacity hover:bg-rose-500/20 hover:text-rose-300 disabled:pointer-events-none disabled:opacity-0 group-hover/row:opacity-100"
                    aria-label="Delete workspace"
                    title={workspaces.length <= 1 ? 'Keep at least one workspace' : 'Delete'}
                  >
                    <Trash2 size={11} strokeWidth={2} />
                  </button>
                </div>
              );
            })}
            <div className="my-1 border-t border-white/[0.05]" />
            <button
              role="menuitem"
              onClick={() => {
                createWorkspace();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-display text-[12px] text-fg-base/90 transition-colors hover:bg-white/[0.06]"
            >
              <Plus size={12} strokeWidth={2.2} className="text-fg-subtle" />
              <span>New workspace</span>
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

function RenameRow({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div className="px-2 py-1">
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => onCommit(value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onCommit(value);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        className="w-full rounded border border-accent/45 bg-bg-base/80 px-2 py-1 font-display text-[12px] tracking-tight text-fg-base focus:outline-none focus:shadow-focus"
      />
    </div>
  );
}
