import { useEffect, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Loader2, Pencil, Plug, PlugZap, Plus, Trash2 } from 'lucide-react';
import type { DbConnection } from '../../lib/tauri';
import { cn } from '../../lib/cn';
import { EnvBadge, EnvDot, envOf } from './chrome';

const BACKEND_LABEL = { postgres: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite' } as const;

/** `host/db` for a server URL, the file name for SQLite — what tells two
 *  connections with similar names apart. */
export function shortUrl(url: string): string {
  const sqlite = /^sqlite:\/*(.*)$/i.exec(url);
  if (sqlite) return sqlite[1]!.split(/[\\/]/).pop() || url;
  try {
    const u = new URL(url);
    const db = u.pathname.replace(/^\//, '');
    return db ? `${u.hostname}/${db}` : u.hostname;
  } catch {
    return url;
  }
}

/**
 * The active connection, as the top of the explorer: its environment, name,
 * engine and where it points, with connect/disconnect beside it. Every other
 * saved connection is one click away in the dropdown.
 */
export function ConnectionSwitcher({
  connections,
  active,
  connected,
  connecting,
  onSelect,
  onAdd,
  onEdit,
  onDelete,
  onToggleConnection,
}: {
  connections: DbConnection[];
  active: DbConnection | null;
  connected: boolean;
  connecting: boolean;
  onSelect: (c: DbConnection) => void;
  onAdd: () => void;
  onEdit: (c: DbConnection) => void;
  onDelete: (c: DbConnection) => void;
  onToggleConnection: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const env = envOf(active?.safety);

  return (
    <div ref={root} className="relative shrink-0 border-b border-edge-1 p-2">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => (connections.length ? setOpen((o) => !o) : onAdd())}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left ring-1 ring-inset transition-colors',
            'focus-visible:outline-none focus-visible:shadow-focus',
            open ? 'bg-surface-2 ring-edge-2' : 'bg-surface-1 ring-edge-1 hover:bg-surface-2',
          )}
          style={env ? { boxShadow: `inset 3px 0 0 ${env.color}` } : undefined}
        >
          {active ? (
            <>
              <EnvDot env={env} on={connected} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-display text-xs font-semibold text-fg-base">
                  {active.name}
                </span>
                <span className="block truncate font-mono text-2xs text-fg-subtle">
                  {BACKEND_LABEL[active.backend]} · {shortUrl(active.url)}
                </span>
              </span>
            </>
          ) : (
            <span className="min-w-0 flex-1 font-display text-xs text-fg-muted">
              {connections.length ? 'Choose a connection' : 'Add a connection'}
            </span>
          )}
          {connections.length ? (
            <ChevronsUpDown size={12} className="shrink-0 text-fg-subtle" />
          ) : (
            <Plus size={12} className="shrink-0 text-fg-subtle" />
          )}
        </button>

        {active && (
          <button
            type="button"
            onClick={onToggleConnection}
            disabled={connecting}
            title={connected ? 'Disconnect' : 'Connect'}
            aria-label={connected ? 'Disconnect' : 'Connect'}
            className={cn(
              'flex h-9 w-8 shrink-0 items-center justify-center rounded-md transition-colors',
              'focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-40',
              connected
                ? 'text-status-ok hover:bg-surface-2'
                : 'bg-accent/15 text-fg-base ring-1 ring-inset ring-accent/40 hover:bg-accent/25',
            )}
          >
            {connecting ? (
              <Loader2 size={13} className="animate-spin" />
            ) : connected ? (
              <PlugZap size={13} />
            ) : (
              <Plug size={13} />
            )}
          </button>
        )}
      </div>

      {open && (
        <div
          role="listbox"
          aria-label="Connections"
          className="absolute inset-x-2 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-lg bg-bg-panel p-1 shadow-sheet ring-1 ring-edge-2"
        >
          {connections.map((c) => {
            const e = envOf(c.safety);
            const isActive = c.id === active?.id;
            return (
              <div
                key={c.id}
                role="option"
                aria-selected={isActive}
                className={cn(
                  'group flex items-center gap-2 rounded-md px-2 py-1.5',
                  isActive ? 'bg-surface-2' : 'hover:bg-surface-1',
                )}
              >
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    if (!isActive) onSelect(c);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
                >
                  <EnvDot env={e} on={isActive && connected} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-display text-xs text-fg-base">{c.name}</span>
                      {e && <EnvBadge env={e} />}
                      {c.ssh && (
                        <span
                          className="shrink-0 rounded bg-surface-2 px-1 font-display text-[10px] leading-4 text-fg-subtle"
                          title={`Through SSH ${c.ssh.user}@${c.ssh.host}`}
                        >
                          SSH
                        </span>
                      )}
                    </span>
                    <span className="block truncate font-mono text-2xs text-fg-subtle">
                      {BACKEND_LABEL[c.backend]} · {shortUrl(c.url)}
                    </span>
                  </span>
                  {isActive && <Check size={12} className="shrink-0 text-accent-bright" />}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onEdit(c);
                  }}
                  title="Edit connection"
                  aria-label={`Edit ${c.name}`}
                  className="shrink-0 rounded p-1 text-fg-subtle opacity-0 transition hover:bg-surface-2 hover:text-fg-base focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Pencil size={11} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onDelete(c);
                  }}
                  title="Delete connection"
                  aria-label={`Delete ${c.name}`}
                  className="shrink-0 rounded p-1 text-fg-subtle opacity-0 transition hover:bg-surface-2 hover:text-status-err focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            );
          })}
          <div className="my-1 h-px bg-edge-1" />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onAdd();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 font-display text-xs text-fg-muted transition-colors hover:bg-surface-1 hover:text-fg-base"
          >
            <Plus size={12} />
            New connection
          </button>
        </div>
      )}
    </div>
  );
}
