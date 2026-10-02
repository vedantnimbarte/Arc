import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import type { DbBackend, DbTableSchema } from '../../lib/tauri';
import {
  TYPE_SUGGESTIONS,
  designSql,
  draftFrom,
  draftProblem,
  emptyDraft,
  type Draft,
  type DraftColumn,
} from '../../lib/tableDesign';
import { cn } from '../../lib/cn';

interface Props {
  backend: DbBackend;
  /** The table being altered, or null to create one. */
  current: { table: string; schema: DbTableSchema } | null;
  /** New tables are created here on Postgres when the name has no schema. */
  defaultSchema: string;
  onSendToEditor: (sql: string) => void;
  onClose: () => void;
}

const INPUT =
  'w-full rounded border border-border-subtle bg-bg-base/60 px-2 py-0.5 font-mono text-xs text-fg-base placeholder:text-fg-subtle/50 focus:border-accent/45 focus:outline-none';

/**
 * Create or alter a table through a form. It only writes SQL — the statements
 * go to the editor to be read and run there, under the same safety checks as
 * anything typed by hand.
 */
export function TableDesigner({ backend, current, defaultSchema, onSendToEditor, onClose }: Props) {
  const [draft, setDraft] = useState<Draft>(() =>
    current ? draftFrom(current.table, current.schema) : emptyDraft(backend),
  );
  const listId = `types-${backend}`;

  // A bare new name on Postgres lands in the schema the sidebar groups under.
  const target = useMemo(() => {
    const t = draft.table.trim();
    return !current && backend === 'postgres' && t && !t.includes('.') ? `${defaultSchema}.${t}` : t;
  }, [draft.table, current, backend, defaultSchema]);

  const problem = draftProblem(draft);
  const sql = useMemo(
    () => (problem ? '' : designSql(backend, current, { ...draft, table: target })),
    [problem, backend, current, draft, target],
  );

  const setCol = (i: number, patch: Partial<DraftColumn>) =>
    setDraft((d) => ({ ...d, columns: d.columns.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  const move = (i: number, by: -1 | 1) =>
    setDraft((d) => {
      const cols = [...d.columns];
      const j = i + by;
      if (j < 0 || j >= cols.length) return d;
      [cols[i], cols[j]] = [cols[j]!, cols[i]!];
      return { ...d, columns: cols };
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-hairline px-4 py-2">
        <span className="font-sans text-sm text-fg-base">{current ? `Alter ${current.table}` : 'New table'}</span>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          className="ml-auto flex h-6 w-6 items-center justify-center rounded text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
        >
          <X size={12} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        <label className="mb-3 flex max-w-sm flex-col gap-1">
          <span className="font-sans text-2xs text-fg-subtle">Table name</span>
          <input
            value={draft.table}
            onChange={(e) => setDraft((d) => ({ ...d, table: e.target.value }))}
            placeholder={backend === 'postgres' ? `${defaultSchema}.orders` : 'orders'}
            spellCheck={false}
            autoFocus={!current}
            className={INPUT}
          />
        </label>

        <datalist id={listId}>
          {TYPE_SUGGESTIONS[backend].map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>

        <table className="w-full max-w-4xl border-collapse font-sans text-xs">
          <thead>
            <tr className="text-left text-2xs text-fg-subtle">
              <th className="w-12 py-1 font-normal" />
              <th className="py-1 pr-2 font-normal">Column</th>
              <th className="py-1 pr-2 font-normal">Type</th>
              <th className="py-1 pr-2 text-center font-normal">Not null</th>
              <th className="py-1 pr-2 font-normal">{backend === 'mysql' ? 'Default value' : 'Default (SQL)'}</th>
              <th className="py-1 pr-2 text-center font-normal" title={current ? 'Change the primary key by hand' : undefined}>
                Key
              </th>
              <th className="w-6" />
            </tr>
          </thead>
          <tbody>
            {draft.columns.map((c, i) => (
              <tr key={i} className="align-middle">
                <td className="py-1">
                  <span className="flex text-fg-subtle">
                    <button type="button" onClick={() => move(i, -1)} title="Move up" className="p-0.5 hover:text-fg-base">
                      <ArrowUp size={10} />
                    </button>
                    <button type="button" onClick={() => move(i, 1)} title="Move down" className="p-0.5 hover:text-fg-base">
                      <ArrowDown size={10} />
                    </button>
                  </span>
                </td>
                <td className="py-1 pr-2">
                  <input
                    value={c.name}
                    onChange={(e) => setCol(i, { name: e.target.value })}
                    spellCheck={false}
                    className={cn(INPUT, c.original && c.original !== c.name.trim() && 'border-status-warn/60')}
                    title={c.original && c.original !== c.name.trim() ? `Renamed from ${c.original}` : undefined}
                  />
                </td>
                <td className="py-1 pr-2">
                  <input
                    value={c.data_type}
                    onChange={(e) => setCol(i, { data_type: e.target.value })}
                    list={listId}
                    spellCheck={false}
                    className={INPUT}
                  />
                </td>
                <td className="py-1 pr-2 text-center">
                  <input
                    type="checkbox"
                    checked={!c.nullable}
                    onChange={(e) => setCol(i, { nullable: !e.target.checked })}
                    className="h-3 w-3 accent-accent"
                  />
                </td>
                <td className="py-1 pr-2">
                  <input
                    value={c.default ?? ''}
                    onChange={(e) => setCol(i, { default: e.target.value || null })}
                    placeholder="none"
                    spellCheck={false}
                    className={INPUT}
                  />
                </td>
                <td className="py-1 pr-2 text-center">
                  <input
                    type="checkbox"
                    checked={c.primary_key}
                    disabled={!!current}
                    onChange={(e) => setCol(i, { primary_key: e.target.checked, nullable: e.target.checked ? false : c.nullable })}
                    className="h-3 w-3 accent-accent disabled:opacity-40"
                  />
                </td>
                <td className="py-1">
                  <button
                    type="button"
                    onClick={() => setDraft((d) => ({ ...d, columns: d.columns.filter((_, j) => j !== i) }))}
                    title={c.original ? `Drop column ${c.original}` : 'Remove'}
                    className="p-0.5 text-fg-subtle transition hover:text-status-err"
                  >
                    <Trash2 size={11} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          type="button"
          onClick={() =>
            setDraft((d) => ({
              ...d,
              columns: [
                ...d.columns,
                {
                  name: '',
                  data_type: backend === 'sqlite' ? 'TEXT' : backend === 'mysql' ? 'varchar(255)' : 'text',
                  nullable: true,
                  default: null,
                  primary_key: false,
                  original: null,
                },
              ],
            }))
          }
          className="mt-1 flex items-center gap-1 rounded px-1.5 py-0.5 font-sans text-xs text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
        >
          <Plus size={11} /> Add column
        </button>

        <div className="mt-4 max-w-4xl">
          <div className="mb-1 font-sans text-2xs text-fg-subtle">SQL</div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-surface-1 px-3 py-2 font-mono text-xs text-fg-base/85 ring-1 ring-border-hairline">
            {problem ?? (sql || '-- No changes yet.')}
          </pre>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-hairline px-4 py-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-2.5 py-1 font-sans text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!!problem || !sql}
          onClick={() => onSendToEditor(sql)}
          className="rounded-lg bg-accent-soft px-2.5 py-1 font-sans text-xs text-fg-base ring-1 ring-accent/45 transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Open SQL in editor
        </button>
      </div>
    </div>
  );
}
