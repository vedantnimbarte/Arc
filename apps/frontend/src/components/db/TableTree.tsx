import { useMemo, useState } from 'react';
import { ChevronRight, Columns3, FileUp, Plus, RefreshCw, Search, X } from 'lucide-react';
import type { DbRowCount } from '../../lib/tauri';
import { formatRowCount } from '../../lib/dbFormat';
import { cn } from '../../lib/cn';
import { ObjIcon, ToolButton } from './chrome';

interface Props {
  /** Table names as the backend lists them — `schema.table` on Postgres. */
  tables: string[];
  rowCounts: Record<string, DbRowCount>;
  /** Group name for backends whose tables carry no schema (MySQL, SQLite). */
  defaultSchema: string;
  activeTable: string | null;
  onPreview: (table: string) => void;
  onExactCount: (table: string) => void;
  /** Absent on a read-only connection. */
  onImport?: (table: string) => void;
  onSchema: (table: string) => void;
  /** Opens the table designer; absent on a read-only connection. */
  onCreateTable?: () => void;
  /** Re-read the catalog: tables and their row counts. */
  onRefresh?: () => void;
}

/** Split `schema.table` at the first dot; bare names go to the default group. */
function splitName(full: string, fallback: string): [string, string] {
  const dot = full.indexOf('.');
  return dot > 0 ? [full.slice(0, dot), full.slice(dot + 1)] : [fallback, full];
}

/**
 * The database explorer: tables grouped by schema, collapsible, with a filter.
 * Only `public` (or the sole group) starts open — databases with many schemas
 * stay scannable. Rows are IDE-dense: one line per table, its row count right
 * aligned, its actions on hover.
 */
export function TableTree({
  tables,
  rowCounts,
  defaultSchema,
  activeTable,
  onPreview,
  onExactCount,
  onImport,
  onSchema,
  onCreateTable,
  onRefresh,
}: Props) {
  const [filter, setFilter] = useState('');
  /** Explicit open/closed choices; schemas absent here use the default. */
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => {
    const map = new Map<string, { full: string; name: string }[]>();
    for (const full of tables) {
      const [schema, name] = splitName(full, defaultSchema);
      let list = map.get(schema);
      if (!list) map.set(schema, (list = []));
      list.push({ full, name });
    }
    return [...map.entries()];
  }, [tables, defaultSchema]);

  const q = filter.trim().toLowerCase();
  const visible = q
    ? groups
        .map(([s, list]) => [s, list.filter((t) => t.full.toLowerCase().includes(q))] as const)
        .filter(([, list]) => list.length > 0)
    : groups;

  const isOpen = (schema: string) =>
    q !== '' || (open[schema] ?? (schema === 'public' || groups.length === 1));

  return (
    <div className="pb-2">
      <div className="sticky top-0 z-20 flex items-center gap-1 border-b border-edge-1 bg-bg-panel px-2 py-1.5">
        <label className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded bg-surface-1 px-2 ring-1 ring-inset ring-edge-1 transition focus-within:ring-accent/50">
          <Search size={11} className="shrink-0 text-fg-subtle" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
            placeholder={`Filter ${tables.length} table${tables.length === 1 ? '' : 's'}`}
            aria-label="Filter tables"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-fg-base placeholder:font-display placeholder:text-fg-subtle/70 focus:outline-none"
          />
          {filter && (
            <button type="button" onClick={() => setFilter('')} aria-label="Clear filter" className="shrink-0 text-fg-subtle hover:text-fg-base">
              <X size={11} />
            </button>
          )}
        </label>
        {onCreateTable && <ToolButton icon={Plus} label="New table" onClick={onCreateTable} />}
        {onRefresh && <ToolButton icon={RefreshCw} label="Refresh tables and row counts" onClick={onRefresh} />}
      </div>

      {visible.length === 0 && (
        <p className="px-3 py-3 font-display text-xs text-fg-subtle">No tables match “{filter.trim()}”.</p>
      )}

      {visible.map(([schema, list]) => {
        const expanded = isOpen(schema);
        return (
          <div key={schema} role="group" aria-label={schema}>
            <button
              type="button"
              onClick={() => setOpen((o) => ({ ...o, [schema]: !expanded }))}
              aria-expanded={expanded}
              className="sticky top-[37px] z-10 flex h-6 w-full items-center gap-1.5 bg-bg-panel px-2 text-left transition hover:bg-surface-1"
            >
              <ChevronRight
                size={11}
                className={cn('shrink-0 text-fg-subtle transition-transform', expanded && 'rotate-90')}
              />
              <ObjIcon kind="schema" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-fg-muted">{schema}</span>
              <span className="shrink-0 font-mono text-2xs tabular-nums text-fg-subtle">{list.length}</span>
            </button>

            {expanded &&
              list.map(({ full, name }) => {
                const rc = rowCounts[full];
                const count = formatRowCount(rc);
                const selected = activeTable === full;
                return (
                  <div
                    key={full}
                    className={cn(
                      'group relative flex h-6 items-center gap-1.5 pl-[22px] pr-2',
                      selected ? 'bg-surface-2' : 'hover:bg-surface-1',
                    )}
                  >
                    {/* Indent guide, and the selection bar over it. */}
                    <span aria-hidden className="absolute inset-y-0 left-[14px] w-px bg-edge-1" />
                    {selected && <span aria-hidden className="absolute inset-y-1 left-0 w-[2px] rounded-full bg-accent" />}
                    <button
                      type="button"
                      onClick={() => onPreview(full)}
                      title={`Open ${full}`}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none"
                    >
                      <ObjIcon kind="table" />
                      <span className={cn('truncate font-mono text-xs', selected ? 'text-fg-base' : 'text-fg-base/85')}>
                        {name}
                      </span>
                    </button>
                    {count && (
                      <button
                        type="button"
                        onClick={() => rc?.estimated && onExactCount(full)}
                        title={rc?.estimated ? 'Estimated row count. Click for the exact number' : 'Rows'}
                        className={cn(
                          'shrink-0 font-mono text-2xs tabular-nums group-hover:hidden',
                          rc?.estimated ? 'text-fg-subtle/70 underline decoration-dotted underline-offset-2 hover:text-fg-base' : 'text-fg-subtle',
                        )}
                      >
                        {count}
                      </button>
                    )}
                    <span className="hidden shrink-0 items-center group-hover:flex">
                      {onImport && (
                        <button
                          type="button"
                          onClick={() => onImport(full)}
                          title="Import CSV"
                          aria-label={`Import CSV into ${full}`}
                          className="rounded p-1 text-fg-subtle transition hover:bg-surface-3 hover:text-fg-base"
                        >
                          <FileUp size={11} />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onSchema(full)}
                        title="Show columns, keys and indexes"
                        aria-label={`Show schema of ${full}`}
                        className="rounded p-1 text-fg-subtle transition hover:bg-surface-3 hover:text-fg-base"
                      >
                        <Columns3 size={11} />
                      </button>
                    </span>
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
