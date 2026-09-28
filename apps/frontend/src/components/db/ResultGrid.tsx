import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import type { DbQueryResult } from '../../lib/tauri';
import type { StagedEdits } from '../../lib/dbSql';
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
}

interface Props {
  result: DbQueryResult;
  /** Present when the rows can be edited (a single table with a primary key). */
  editing?: EditProps;
  /** Why editing is off, shown as a hint — e.g. the table has no primary key. */
  readOnlyReason?: string | null;
}

const TH =
  'whitespace-nowrap border-b border-r border-border-hairline px-2.5 py-1 font-sans text-2xs uppercase tracking-widest text-fg-subtle/70';
const TD = 'max-w-md truncate border-b border-r border-border-hairline px-2.5 py-0.5 font-mono text-xs';

/**
 * The results grid: click a header to sort, type to filter, and — for a table
 * preview with a primary key — double-click a cell to edit. Edits are only
 * staged here; the parent turns them into SQL and applies them.
 */
export function ResultGrid({ result, editing, readOnlyReason }: Props) {
  const [sort, setSort] = useState<Sort>(null);
  const [filter, setFilter] = useState('');
  const [editingCell, setEditingCell] = useState<{ row: number | `new-${number}`; col: number } | null>(null);

  // A new result starts unsorted and unfiltered.
  useEffect(() => {
    setSort(null);
    setFilter('');
    setEditingCell(null);
  }, [result]);

  /** Indices into result.rows, filtered then sorted. */
  const order = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let idx = result.rows.map((_, i) => i);
    if (q) idx = idx.filter((i) => result.rows[i]!.some((c) => c !== null && c.toLowerCase().includes(q)));
    if (sort) idx.sort((a, b) => sort.dir * compare(result.rows[a]![sort.col]!, result.rows[b]![sort.col]!));
    return idx;
  }, [result, filter, sort]);

  const cycleSort = (col: number) =>
    setSort((s) => (s?.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null));

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-hairline px-3 py-1">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter rows"
          spellCheck={false}
          className="w-48 rounded-md border border-border-subtle bg-bg-base/60 px-2 py-0.5 font-sans text-xs text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:outline-none"
        />
        {(filter || sort) && (
          <span className="font-sans text-2xs text-fg-subtle">
            {order.length} of {result.rows.length}
          </span>
        )}
        {editing ? (
          <>
            <span className="font-sans text-2xs text-fg-subtle/70">Double-click a cell to edit</span>
            <button
              type="button"
              onClick={() => update((e) => void e.inserts.push(new Map()))}
              className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 font-sans text-2xs text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
            >
              <Plus size={10} /> Add row
            </button>
          </>
        ) : (
          readOnlyReason && <span className="ml-auto font-sans text-2xs text-fg-subtle/70">{readOnlyReason}</span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-max min-w-full border-collapse text-left">
          <thead className="sticky top-0 z-[1] bg-bg-chrome">
            <tr>
              {editing && <th className={cn(TH, 'w-6 px-1')} />}
              {result.columns.map((c, i) => (
                <th key={`${c}-${i}`} className={cn(TH, 'cursor-pointer select-none hover:text-fg-base')} onClick={() => cycleSort(i)}>
                  <span className="inline-flex items-center gap-1">
                    {c}
                    {sort?.col === i && (sort.dir === 1 ? <ArrowUp size={9} /> : <ArrowDown size={9} />)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {order.map((ri, pos) => {
              const deleted = edits?.deletes.has(ri) ?? false;
              return (
                <tr key={ri} className={cn(pos % 2 ? 'bg-surface-1' : undefined, deleted && 'bg-status-err/10')}>
                  {editing && (
                    <td className="w-6 border-b border-r border-border-hairline px-1 text-center">
                      <button
                        type="button"
                        title={deleted ? 'Keep this row' : 'Delete this row'}
                        onClick={() =>
                          update((e) => {
                            if (e.deletes.has(ri)) e.deletes.delete(ri);
                            else e.deletes.add(ri);
                          })
                        }
                        className="text-fg-subtle transition hover:text-status-err"
                      >
                        {deleted ? <Undo2 size={10} /> : <Trash2 size={10} />}
                      </button>
                    </td>
                  )}
                  {result.columns.map((_, ci) => {
                    const { value, dirty } = cellValue(ri, ci);
                    const isEditing = editingCell?.row === ri && editingCell.col === ci;
                    return (
                      <td
                        key={ci}
                        title={value ?? 'NULL'}
                        onDoubleClick={() => editing && !deleted && setEditingCell({ row: ri, col: ci })}
                        className={cn(
                          TD,
                          deleted ? 'text-fg-subtle line-through' : 'text-fg-base/85',
                          dirty && 'bg-status-warn/15',
                          isEditing && 'p-0',
                        )}
                      >
                        {isEditing ? (
                          <CellEditor
                            initial={value}
                            onCommit={(v) => commitCell(ri, ci, v)}
                            onCancel={() => setEditingCell(null)}
                          />
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
              <tr key={`new-${ii}`} className="bg-status-ok/10">
                <td className="w-6 border-b border-r border-border-hairline px-1 text-center">
                  <button
                    type="button"
                    title="Discard this new row"
                    onClick={() => update((e) => void e.inserts.splice(ii, 1))}
                    className="text-fg-subtle transition hover:text-status-err"
                  >
                    <RotateCcw size={10} />
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
                      className={cn(TD, 'text-fg-base/85', isEditing && 'p-0')}
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
                        <span className="italic text-fg-subtle/60">default</span>
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

function CellText({ value }: { value: string | null }) {
  return value === null ? <span className="italic text-fg-subtle/60">NULL</span> : <>{value}</>;
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
