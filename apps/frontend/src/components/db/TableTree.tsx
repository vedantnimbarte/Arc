import { useMemo, useState } from 'react';
import { ChevronRight, Columns3, FileUp, Search, Table2, X } from 'lucide-react';
import type { DbRowCount } from '../../lib/tauri';
import { formatRowCount } from '../../lib/dbFormat';
import { cn } from '../../lib/cn';

interface Props {
  /** Table names as the backend lists them — `schema.table` on Postgres. */
  tables: string[];
  rowCounts: Record<string, DbRowCount>;
  /** Group name for backends whose tables carry no schema (MySQL, SQLite). */
  defaultSchema: string;
  activeTable: string | null;
  onPreview: (table: string) => void;
  onExactCount: (table: string) => void;
  onImport: (table: string) => void;
  onSchema: (table: string) => void;
}

/** Split `schema.table` at the first dot; bare names go to the default group. */
function splitName(full: string, fallback: string): [string, string] {
  const dot = full.indexOf('.');
  return dot > 0 ? [full.slice(0, dot), full.slice(dot + 1)] : [fallback, full];
}

/** Tables grouped by schema, collapsible, with a filter. Only `public` (or the
 *  sole group) starts open — databases with many schemas stay scannable. */
export function TableTree({
  tables,
  rowCounts,
  defaultSchema,
  activeTable,
  onPreview,
  onExactCount,
  onImport,
  onSchema,
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
    <div className="mt-2 border-t border-border-hairline pt-2">
      <label className="mx-2 mb-1.5 flex items-center gap-1.5 rounded-md bg-surface-1 px-2 py-1 ring-1 ring-transparent transition focus-within:ring-accent/45">
        <Search size={11} className="shrink-0 text-fg-subtle" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
          placeholder={`Filter ${tables.length} table${tables.length === 1 ? '' : 's'}`}
          className="min-w-0 flex-1 bg-transparent font-sans text-xs text-fg-base placeholder:text-fg-subtle/70 focus:outline-none"
        />
        {filter && (
          <button
            type="button"
            onClick={() => setFilter('')}
            title="Clear filter"
            className="shrink-0 text-fg-subtle hover:text-fg-base"
          >
            <X size={11} />
          </button>
        )}
      </label>

      {visible.length === 0 && (
        <p className="px-3 py-2 font-sans text-xs text-fg-subtle">
          No tables match “{filter.trim()}”.
        </p>
      )}

      {visible.map(([schema, list]) => {
        const expanded = isOpen(schema);
        return (
          <div key={schema}>
            <button
              type="button"
              onClick={() => setOpen((o) => ({ ...o, [schema]: !expanded }))}
              aria-expanded={expanded}
              className="sticky top-0 z-10 flex w-full items-center gap-1.5 bg-bg-panel px-2 py-1 text-left transition hover:bg-surface-1"
            >
              <ChevronRight
                size={11}
                className={cn(
                  'shrink-0 text-fg-subtle transition-transform',
                  expanded && 'rotate-90',
                )}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">
                {schema}
              </span>
              <span className="shrink-0 rounded-full bg-surface-2 px-1.5 font-sans text-[10px] leading-4 tabular-nums text-fg-subtle">
                {list.length}
              </span>
            </button>

            {expanded && (
              <div className="ml-[13px] border-l border-border-hairline pb-1">
                {list.map(({ full, name }) => {
                  const rc = rowCounts[full];
                  const count = formatRowCount(rc);
                  const selected = activeTable === full;
                  return (
                    <div
                      key={full}
                      className={cn(
                        'group relative -ml-px flex items-center gap-2 border-l py-1 pl-2.5 pr-2',
                        selected
                          ? 'border-accent bg-surface-2'
                          : 'border-transparent hover:bg-surface-1',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => onPreview(full)}
                        title={full}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <Table2
                          size={11}
                          className={cn('shrink-0', selected ? 'text-accent' : 'text-fg-subtle')}
                        />
                        <span
                          className={cn(
                            'truncate font-mono text-xs',
                            selected ? 'text-fg-base' : 'text-fg-base/80',
                          )}
                        >
                          {name}
                        </span>
                      </button>
                      {count && (
                        <button
                          type="button"
                          onClick={() => rc?.estimated && onExactCount(full)}
                          title={
                            rc?.estimated
                              ? 'Estimated row count — click for the exact number'
                              : 'Rows'
                          }
                          className={cn(
                            'shrink-0 rounded-full px-1.5 font-sans text-[10px] leading-4 tabular-nums text-fg-subtle group-hover:hidden',
                            rc?.estimated
                              ? 'border border-dashed border-border-hairline hover:border-fg-subtle hover:text-fg-base'
                              : 'bg-surface-2',
                          )}
                        >
                          {count}
                        </button>
                      )}
                      <span className="hidden shrink-0 items-center gap-1.5 group-hover:flex">
                        <button
                          type="button"
                          onClick={() => onImport(full)}
                          title="Import CSV"
                          className="text-fg-subtle transition hover:text-fg-base"
                        >
                          <FileUp size={11} />
                        </button>
                        <button
                          type="button"
                          onClick={() => onSchema(full)}
                          title="Show schema"
                          className="text-fg-subtle transition hover:text-fg-base"
                        >
                          <Columns3 size={11} />
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
