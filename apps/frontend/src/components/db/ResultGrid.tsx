import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  Copy,
  CopyPlus,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import type { DbBackend, DbQueryResult, DbTableSchema } from '../../lib/tauri';
import { ObjIcon, ToolButton, ToolSep } from './chrome';
import type { StagedEdits } from '../../lib/dbSql';
import type { Browse } from '../../lib/dbBrowse';
import { toCsv, toInsertSql, toJson, toMarkdown } from '../../lib/dbExport';
import { toast, toastError } from '../../state/toast';
import { cn } from '../../lib/cn';

type Sort = { col: number; dir: 1 | -1 } | null;

/** Numbers sort numerically, everything else as text; NULL sorts last. */
function compare(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const na = Number(a);
  const nb = Number(b);
  if (a.trim() !== '' && b.trim() !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b, undefined, { numeric: true });
}

interface EditProps {
  edits: StagedEdits;
  onChange: (edits: StagedEdits) => void;
  /** Primary-key columns — left out when duplicating a row. */
  pk: string[];
}

/** Server-side browsing of one table: sort, per-column filters, paging. */
export interface BrowseProps {
  browse: Browse;
  /** The server had rows past this page. */
  hasNext: boolean;
  onChange: (browse: Browse) => void;
}

interface Props {
  result: DbQueryResult;
  /** Present when the rows can be edited (a single table with a primary key). */
  editing?: EditProps;
  /** Why editing is off, shown as a hint — e.g. the table has no primary key. */
  readOnlyReason?: string | null;
  /** Present when the grid shows a table preview: sorting and filtering go to the server. */
  browsing?: BrowseProps;
  /** Foreign-key columns, and what following a value does. */
  links?: Record<string, { to: string; follow: (row: Array<string | null>) => void }>;
  /** For "copy as INSERT": the dialect, and the table name to insert into. */
  copyAs: { backend: DbBackend; table: string | null };
  /** The table's columns when the grid shows one table: types and keys for
   *  the headers. Absent for an arbitrary query. */
  columnInfo?: DbTableSchema['columns'];
}

const TH = 'whitespace-nowrap border-b border-r border-edge-1 px-2.5 py-1 text-left align-bottom font-normal';
const TD = 'h-6 max-w-md truncate border-b border-r border-edge-1 px-2.5 font-mono text-xs';
const GUTTER = 'sticky left-0 z-[1] border-b border-r border-edge-2 bg-bg-chrome';
const BAR_BTN =
  'flex h-6 items-center gap-1 rounded px-1.5 font-display text-2xs text-fg-muted transition hover:bg-surface-2 hover:text-fg-base';
/** Integers and decimals read right-aligned, the way a spreadsheet sets them. */
const NUMERIC = /^-?\d+(\.\d+)?$/;

type CopyFormat = 'csv' | 'json' | 'sql' | 'markdown';

/**
 * The results grid: click a header to sort, type to filter, click row numbers
 * to select (shift for a range, ⌘/Ctrl to add) and copy or act on the
 * selection, and — for a table preview with a primary key — double-click a
 * cell to edit. Edits are only staged here; the parent turns them into SQL.
 */
export function ResultGrid({ result, editing, readOnlyReason, browsing, links, copyAs, columnInfo }: Props) {
  const info = useMemo(() => new Map((columnInfo ?? []).map((c) => [c.name, c])), [columnInfo]);
  const [sort, setSort] = useState<Sort>(null);
  const [filter, setFilter] = useState('');
  const [editingCell, setEditingCell] = useState<{ row: number | `new-${number}`; col: number } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);

  // A new result starts unsorted, unfiltered and unselected.
  useEffect(() => {
    setSort(null);
    setFilter('');
    setEditingCell(null);
    setSelected(new Set());
    anchor.current = null;
  }, [result]);

  /** Indices into result.rows, filtered then sorted (client-side only). */
  const order = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let idx = result.rows.map((_, i) => i);
    if (q) idx = idx.filter((i) => result.rows[i]!.some((c) => c !== null && c.toLowerCase().includes(q)));
    if (sort) idx.sort((a, b) => sort.dir * compare(result.rows[a]![sort.col]!, result.rows[b]![sort.col]!));
    return idx;
  }, [result, filter, sort]);

  const headerClick = (col: number) => {
    if (browsing) {
      const column = result.columns[col]!;
      const s = browsing.browse.sort;
      const next =
        !s || s.column !== column
          ? { column, dir: 'asc' as const }
          : s.dir === 'asc'
            ? { column, dir: 'desc' as const }
            : null;
      browsing.onChange({ ...browsing.browse, sort: next, page: 0 });
      return;
    }
    setSort((s) => (s?.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null));
  };
  const sortOf = (col: number): 1 | -1 | null => {
    if (browsing) {
      const s = browsing.browse.sort;
      return s && s.column === result.columns[col] ? (s.dir === 'asc' ? 1 : -1) : null;
    }
    return sort?.col === col ? sort.dir : null;
  };

  const edits = editing?.edits;
  const update = (fn: (e: StagedEdits) => void) => {
    if (!editing) return;
    const next: StagedEdits = {
      updates: new Map([...editing.edits.updates].map(([k, v]) => [k, new Map(v)])),
      deletes: new Set(editing.edits.deletes),
      inserts: editing.edits.inserts.map((m) => new Map(m)),
    };
    fn(next);
    editing.onChange(next);
  };

  const commitCell = (row: number | `new-${number}`, col: number, value: string | null) => {
    const name = result.columns[col]!;
    update((e) => {
      if (typeof row === 'number') {
        const original = result.rows[row]![col] ?? null;
        const cols = e.updates.get(row) ?? new Map<string, string | null>();
        if (value === original) cols.delete(name);
        else cols.set(name, value);
        if (cols.size) e.updates.set(row, cols);
        else e.updates.delete(row);
      } else {
        e.inserts[Number(row.slice(4))]!.set(name, value);
      }
    });
    setEditingCell(null);
  };

  const cellValue = (row: number, col: number): { value: string | null; dirty: boolean } => {
    const staged = edits?.updates.get(row)?.get(result.columns[col]!);
    if (staged !== undefined) return { value: staged, dirty: true };
    return { value: result.rows[row]![col] ?? null, dirty: false };
  };

  // ─── Selection ────────────────────────────────────────────────────────────

  const clickRowNumber = (ri: number, e: React.MouseEvent) => {
    setSelected((prev) => {
      if (e.shiftKey && anchor.current !== null) {
        const a = order.indexOf(anchor.current);
        const b = order.indexOf(ri);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        return new Set(order.slice(lo, hi + 1));
      }
      anchor.current = ri;
      if (e.metaKey || e.ctrlKey) {
        const next = new Set(prev);
        if (next.has(ri)) next.delete(ri);
        else next.add(ri);
        return next;
      }
      return prev.size === 1 && prev.has(ri) ? new Set() : new Set([ri]);
    });
  };

  /** Selected rows in display order, with staged edits applied. */
  const selectedRows = () =>
    order.filter((ri) => selected.has(ri)).map((ri) => result.columns.map((_, ci) => cellValue(ri, ci).value));

  const copySelection = async (format: CopyFormat) => {
    const rows = selectedRows();
    const text =
      format === 'csv'
        ? toCsv(result.columns, rows)
        : format === 'json'
          ? toJson(result.columns, rows)
          : format === 'markdown'
            ? toMarkdown(result.columns, rows)
            : toInsertSql(copyAs.backend, copyAs.table ?? 'table_name', result.columns, rows);
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${rows.length} row${rows.length === 1 ? '' : 's'} as ${format === 'sql' ? 'INSERT statements' : format.toUpperCase()}`);
    } catch (e) {
      toastError(String(e));
    }
  };

  const deleteSelection = () =>
    update((e) => {
      for (const ri of selected) e.deletes.add(ri);
    });

  /** Stage a copy of each selected row as a new row, minus its primary key
   *  (the database assigns a new one, or the user types it). */
  const duplicateSelection = () => {
    if (!editing) return;
    const skip = new Set(editing.pk);
    update((e) => {
      for (const ri of order.filter((r) => selected.has(r))) {
        const m = new Map<string, string | null>();
        result.columns.forEach((c, ci) => {
          if (!skip.has(c)) m.set(c, cellValue(ri, ci).value);
        });
        e.inserts.push(m);
      }
    });
    setSelected(new Set());
  };

  const pageOffset = browsing ? browsing.browse.page * browsing.browse.pageSize : 0;
  const nSel = selected.size;
  const page = browsing?.browse.page ?? 0;
  const go = (p: number) => browsing && browsing.onChange({ ...browsing.browse, page: p });

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Grid toolbar: paging and the filter, or what to do with the selection. */}
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-edge-1 px-2">
        {browsing && (
          <>
            <ToolButton icon={ChevronsLeft} label="First page" onClick={() => go(0)} disabled={page === 0} />
            <ToolButton icon={ChevronLeft} label="Previous page" onClick={() => go(page - 1)} disabled={page === 0} />
            <span className="px-1 font-mono text-2xs tabular-nums text-fg-muted" title="Rows on this page">
              {result.rows.length === 0 ? '0' : `${pageOffset + 1}–${pageOffset + result.rows.length}`}
            </span>
            <ToolButton icon={ChevronRight} label="Next page" onClick={() => go(page + 1)} disabled={!browsing.hasNext} />
            <ToolSep />
          </>
        )}
        {nSel > 0 ? (
          <>
            <span className="px-1 font-display text-2xs text-fg-base">
              {nSel} row{nSel === 1 ? '' : 's'} selected
            </span>
            <span className="px-1 font-display text-2xs text-fg-subtle">Copy as</span>
            {(['csv', 'json', 'sql', 'markdown'] as const).map((f) => (
              <button key={f} type="button" onClick={() => void copySelection(f)} className={BAR_BTN}>
                <Copy size={11} />
                {f === 'sql' ? 'INSERT' : f === 'markdown' ? 'Markdown' : f.toUpperCase()}
              </button>
            ))}
            {editing && (
              <>
                <ToolSep />
                <button type="button" onClick={duplicateSelection} className={BAR_BTN} title="Stage copies as new rows">
                  <CopyPlus size={11} /> Duplicate
                </button>
                <button
                  type="button"
                  onClick={deleteSelection}
                  className={cn(BAR_BTN, 'hover:text-status-err')}
                  title="Stage these rows for deletion"
                >
                  <Trash2 size={11} /> Delete
                </button>
              </>
            )}
            <button type="button" onClick={() => setSelected(new Set())} className={cn(BAR_BTN, 'ml-auto')}>
              <X size={11} /> Clear selection
            </button>
          </>
        ) : (
          <>
            {browsing ? (
              <span className="px-1 font-display text-2xs text-fg-subtle">
                Filter under each header: text, <code className="font-mono">=v</code>,{' '}
                <code className="font-mono">&gt;v</code>, <code className="font-mono">null</code>
              </span>
            ) : (
              <label className="flex h-6 w-56 items-center gap-1.5 rounded bg-surface-1 px-2 ring-1 ring-inset ring-edge-1 focus-within:ring-accent/50">
                <Search size={11} className="shrink-0 text-fg-subtle" />
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter rows"
                  aria-label="Filter rows"
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-transparent font-mono text-xs text-fg-base placeholder:font-display placeholder:text-fg-subtle/70 focus:outline-none"
                />
              </label>
            )}
            {!browsing && (filter || sort) && (
              <span className="px-1.5 font-mono text-2xs tabular-nums text-fg-subtle">
                {order.length} of {result.rows.length}
              </span>
            )}
            <span className="flex-1" />
            {editing ? (
              <>
                <span className="px-1 font-display text-2xs text-fg-subtle">Double-click a cell to edit</span>
                <button type="button" onClick={() => update((e) => void e.inserts.push(new Map()))} className={BAR_BTN}>
                  <Plus size={11} /> Add row
                </button>
              </>
            ) : (
              readOnlyReason && <span className="px-1 font-display text-2xs text-fg-subtle">{readOnlyReason}</span>
            )}
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {/* Columns size to their content, like an IDE grid — stretching them
            to the pane's width pushed right-aligned numbers far from the
            header they belong to. */}
        <table className="w-max border-separate border-spacing-0 text-left">
          <thead className="sticky top-0 z-[2] bg-bg-chrome">
            <tr>
              <th className={cn(TH, GUTTER, 'z-[3] w-10 px-1')} />
              {editing && <th className={cn(TH, 'w-6 px-1')} />}
              {result.columns.map((c, i) => {
                const dir = sortOf(i);
                const link = links?.[c];
                const col = info.get(c);
                return (
                  <th
                    key={`${c}-${i}`}
                    className={cn(TH, 'cursor-pointer select-none hover:bg-surface-1')}
                    onClick={() => headerClick(i)}
                    title={[link && `References ${link.to}`, col && `${col.data_type}${col.nullable ? '' : ' not null'}`].filter(Boolean).join('\n') || undefined}
                    aria-sort={dir === 1 ? 'ascending' : dir === -1 ? 'descending' : undefined}
                  >
                    <span className="flex items-center gap-1">
                      {col?.primary_key ? <ObjIcon kind="pk" size={11} /> : link ? <ObjIcon kind="fk" size={11} /> : null}
                      <span className="font-mono text-xs font-semibold text-fg-base">{c}</span>
                      {link && <ArrowUpRight size={10} className="text-accent" />}
                      {dir !== null && (
                        <span className="text-accent-bright">
                          {dir === 1 ? <ArrowUp size={10} /> : <ArrowDown size={10} />}
                        </span>
                      )}
                    </span>
                    {col && (
                      <span className="mt-px block font-mono text-[10px] lowercase leading-3 text-fg-subtle">
                        {col.data_type}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
            {browsing && (
              <tr>
                <th className={cn(GUTTER, 'z-[3] border-t-0')} />
                {editing && <th className="border-b border-r border-edge-1" />}
                {result.columns.map((c, i) => (
                  <th key={`${c}-${i}-f`} className="border-b border-r border-edge-1 p-0 font-normal">
                    <ColumnFilter
                      value={browsing.browse.filters[c] ?? ''}
                      onCommit={(v) =>
                        browsing.onChange({
                          ...browsing.browse,
                          filters: { ...browsing.browse.filters, [c]: v },
                          page: 0,
                        })
                      }
                    />
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {order.map((ri) => {
              const deleted = edits?.deletes.has(ri) ?? false;
              const isSel = selected.has(ri);
              return (
                <tr
                  key={ri}
                  className={cn(
                    'group/row hover:bg-surface-1',
                    deleted && 'bg-status-err/[0.09]',
                    isSel && 'bg-accent/[0.14] hover:bg-accent/[0.18]',
                  )}
                >
                  <td
                    onClick={(e) => clickRowNumber(ri, e)}
                    className={cn(
                      GUTTER,
                      'h-6 w-10 cursor-pointer select-none px-1.5 text-right font-mono text-2xs tabular-nums',
                      isSel ? 'text-fg-base' : 'text-fg-subtle hover:text-fg-base',
                    )}
                    title="Select row (shift: range, ⌘/Ctrl: add)"
                  >
                    {isSel && <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-accent" />}
                    {pageOffset + ri + 1}
                  </td>
                  {editing && (
                    <td className="h-6 w-6 border-b border-r border-edge-1 px-1 text-center">
                      <button
                        type="button"
                        title={deleted ? 'Keep this row' : 'Delete this row'}
                        aria-label={deleted ? 'Keep this row' : 'Delete this row'}
                        onClick={() =>
                          update((e) => {
                            if (e.deletes.has(ri)) e.deletes.delete(ri);
                            else e.deletes.add(ri);
                          })
                        }
                        className={cn(
                          'text-fg-subtle transition hover:text-status-err focus-visible:opacity-100',
                          !deleted && 'opacity-0 group-hover/row:opacity-100',
                        )}
                      >
                        {deleted ? <Undo2 size={11} /> : <Trash2 size={11} />}
                      </button>
                    </td>
                  )}
                  {result.columns.map((c, ci) => {
                    const { value, dirty } = cellValue(ri, ci);
                    const isEditing = editingCell?.row === ri && editingCell.col === ci;
                    const link = value !== null ? links?.[c] : undefined;
                    return (
                      <td
                        key={ci}
                        title={value ?? 'NULL'}
                        onDoubleClick={() => editing && !deleted && setEditingCell({ row: ri, col: ci })}
                        className={cn(
                          TD,
                          'group/cell',
                          value !== null && NUMERIC.test(value) && 'text-right tabular-nums',
                          deleted ? 'text-fg-subtle line-through' : 'text-fg-base/90',
                          dirty && 'bg-[#4f8cff]/[0.16] text-fg-base',
                          isEditing && 'p-0',
                        )}
                      >
                        {isEditing ? (
                          <CellEditor
                            initial={value}
                            onCommit={(v) => commitCell(ri, ci, v)}
                            onCancel={() => setEditingCell(null)}
                          />
                        ) : link ? (
                          <span className="inline-flex items-center gap-1">
                            <CellText value={value} />
                            <button
                              type="button"
                              onClick={() => link.follow(result.rows[ri]!)}
                              title={`Open the ${link.to} row this points to`}
                              aria-label={`Open the ${link.to} row this points to`}
                              className="text-accent/70 transition hover:text-accent"
                            >
                              <ArrowUpRight size={11} />
                            </button>
                          </span>
                        ) : (
                          <CellText value={value} />
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {edits?.inserts.map((row, ii) => (
              <tr key={`new-${ii}`} className="bg-status-ok/[0.08]">
                <td className={cn(GUTTER, 'h-6 w-10 px-1.5 text-right font-display text-2xs font-semibold text-status-ok')}>
                  new
                </td>
                <td className="h-6 w-6 border-b border-r border-edge-1 px-1 text-center">
                  <button
                    type="button"
                    title="Discard this new row"
                    aria-label="Discard this new row"
                    onClick={() => update((e) => void e.inserts.splice(ii, 1))}
                    className="text-fg-subtle transition hover:text-status-err"
                  >
                    <RotateCcw size={11} />
                  </button>
                </td>
                {result.columns.map((c, ci) => {
                  const key = `new-${ii}` as const;
                  const isEditing = editingCell?.row === key && editingCell.col === ci;
                  const has = row.has(c);
                  return (
                    <td
                      key={ci}
                      onDoubleClick={() => setEditingCell({ row: key, col: ci })}
                      className={cn(TD, 'text-fg-base/90', isEditing && 'p-0')}
                    >
                      {isEditing ? (
                        <CellEditor
                          initial={has ? (row.get(c) ?? null) : ''}
                          onCommit={(v) => commitCell(key, ci, v)}
                          onCancel={() => setEditingCell(null)}
                        />
                      ) : has ? (
                        <CellText value={row.get(c) ?? null} />
                      ) : (
                        <span className="italic text-fg-subtle/60">&lt;default&gt;</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A column's filter box: applies on Enter or when focus leaves it changed. */
function ColumnFilter({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text !== value) onCommit(text);
  };
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setText('');
          if (value) onCommit('');
        }
      }}
      onBlur={commit}
      // An input asks for ~20 characters by default, which would set every
      // column's width; let the header and the data decide instead.
      size={1}
      aria-label="Filter this column"
      placeholder="filter"
      spellCheck={false}
      className={cn(
        'h-6 w-full min-w-[5rem] bg-transparent px-2.5 font-mono text-xs font-normal normal-case tracking-normal text-fg-base placeholder:text-fg-subtle/40 focus:bg-bg-base focus:outline-none',
        value && 'bg-accent-soft',
      )}
    />
  );
}

function CellText({ value }: { value: string | null }) {
  return value === null ? <span className="italic text-fg-subtle/60">&lt;null&gt;</span> : <>{value}</>;
}

/** In-cell input. Enter commits, Escape cancels, the NULL button commits NULL. */
function CellEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string | null;
  onCommit: (value: string | null) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial ?? '');
  const ref = useRef<HTMLInputElement>(null);
  // Enter/Escape finish first; the blur that follows must not commit again.
  const done = useRef(false);
  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <span className="flex items-center">
      <input
        ref={ref}
        value={text}
        placeholder={initial === null ? 'NULL' : undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(() => onCommit(text));
          if (e.key === 'Escape') finish(onCancel);
        }}
        // Leaving an untouched NULL cell keeps it NULL rather than ''.
        onBlur={() => finish(() => onCommit(text === '' && initial === null ? null : text))}
        spellCheck={false}
        className="min-w-[8rem] flex-1 bg-bg-base px-2.5 py-0.5 font-mono text-xs text-fg-base outline outline-1 outline-accent/60"
      />
      <button
        type="button"
        // Before the input's blur commits the text.
        onMouseDown={(e) => {
          e.preventDefault();
          finish(() => onCommit(null));
        }}
        title="Set to NULL"
        className="shrink-0 px-1.5 font-sans text-2xs text-fg-subtle hover:text-fg-base"
      >
        NULL
      </button>
    </span>
  );
}
