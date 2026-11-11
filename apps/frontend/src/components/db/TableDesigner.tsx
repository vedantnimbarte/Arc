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
import { ObjIcon, ToolButton, ToolWindowHeader, inputCls, primaryBtn, textBtn } from './chrome';

interface Props {
  backend: DbBackend;
  /** The table being altered, or null to create one. */
  current: { table: string; schema: DbTableSchema } | null;
  /** New tables are created here on Postgres when the name has no schema. */
  defaultSchema: string;
  onSendToEditor: (sql: string) => void;
  onClose: () => void;
}

const INPUT = cn(inputCls, 'h-6 w-full');
const TH = 'h-7 border-b border-edge-1 px-1.5 text-left font-display text-2xs font-medium text-fg-subtle';

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
      <ToolWindowHeader actions={<ToolButton icon={X} label="Close" onClick={onClose} />}>
        <span className="flex min-w-0 items-center gap-1.5 px-1">
          <ObjIcon kind="table" />
          <span className="truncate font-display text-xs font-medium text-fg-base">
            {current ? (
              <>
                Alter <span className="font-mono">{current.table}</span>
              </>
            ) : (
              'New table'
            )}
          </span>
        </span>
      </ToolWindowHeader>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        <label className="mb-3 flex max-w-sm flex-col gap-1">
          <span className="font-display text-2xs text-fg-muted">Table name</span>
          <input
            value={draft.table}
            onChange={(e) => setDraft((d) => ({ ...d, table: e.target.value }))}
            placeholder={backend === 'postgres' ? `${defaultSchema}.orders` : 'orders'}
            spellCheck={false}
            autoFocus={!current}
            className={cn(inputCls, 'w-full')}
          />
        </label>

        <datalist id={listId}>
          {TYPE_SUGGESTIONS[backend].map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>

        <table className="w-full max-w-4xl border-separate border-spacing-0 font-display text-xs">
          <thead>
            <tr>
              <th className={cn(TH, 'w-14')} />
              <th className={TH}>Column</th>
              <th className={TH}>Type</th>
              <th className={cn(TH, 'text-center')}>Not null</th>
              <th className={TH}>{backend === 'mysql' ? 'Default value' : 'Default (SQL)'}</th>
              <th className={cn(TH, 'text-center')} title={current ? 'Change the primary key by hand' : undefined}>
                Key
              </th>
              <th className={cn(TH, 'w-7')} />
            </tr>
          </thead>
          <tbody>
            {draft.columns.map((c, i) => (
              <tr key={i} className="align-middle hover:bg-surface-1">
                <td className="h-8 border-b border-edge-1 px-1">
                  <span className="flex items-center gap-0.5 text-fg-subtle">
                    <ObjIcon kind={c.primary_key ? 'pk' : 'column'} size={11} />
                    <button type="button" onClick={() => move(i, -1)} title="Move up" aria-label="Move up" className="rounded p-0.5 hover:bg-surface-2 hover:text-fg-base">
                      <ArrowUp size={11} />
                    </button>
                    <button type="button" onClick={() => move(i, 1)} title="Move down" aria-label="Move down" className="rounded p-0.5 hover:bg-surface-2 hover:text-fg-base">
                      <ArrowDown size={11} />
                    </button>
                  </span>
                </td>
                <td className="border-b border-edge-1 px-1.5">
                  <input
                    value={c.name}
                    onChange={(e) => setCol(i, { name: e.target.value })}
                    spellCheck={false}
                    className={cn(INPUT, c.original && c.original !== c.name.trim() && 'ring-status-warn/60')}
                    title={c.original && c.original !== c.name.trim() ? `Renamed from ${c.original}` : undefined}
                  />
                </td>
                <td className="border-b border-edge-1 px-1.5">
                  <input
                    value={c.data_type}
                    onChange={(e) => setCol(i, { data_type: e.target.value })}
                    list={listId}
                    spellCheck={false}
                    className={INPUT}
                  />
                </td>
                <td className="border-b border-edge-1 px-1.5 text-center">
                  <input
                    type="checkbox"
                    checked={!c.nullable}
                    onChange={(e) => setCol(i, { nullable: !e.target.checked })}
                    className="h-3 w-3 accent-accent"
                  />
                </td>
                <td className="border-b border-edge-1 px-1.5">
                  <input
                    value={c.default ?? ''}
                    onChange={(e) => setCol(i, { default: e.target.value || null })}
                    placeholder="none"
                    spellCheck={false}
                    className={INPUT}
                  />
                </td>
                <td className="border-b border-edge-1 px-1.5 text-center">
                  <input
                    type="checkbox"
                    checked={c.primary_key}
                    disabled={!!current}
                    onChange={(e) => setCol(i, { primary_key: e.target.checked, nullable: e.target.checked ? false : c.nullable })}
                    className="h-3 w-3 accent-accent disabled:opacity-40"
                  />
                </td>
                <td className="border-b border-edge-1 px-1 text-center">
                  <button
                    type="button"
                    onClick={() => setDraft((d) => ({ ...d, columns: d.columns.filter((_, j) => j !== i) }))}
                    title={c.original ? `Drop column ${c.original}` : 'Remove'}
                    aria-label={c.original ? `Drop column ${c.original}` : 'Remove column'}
                    className="rounded p-1 text-fg-subtle transition hover:bg-surface-2 hover:text-status-err"
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
          className={cn(textBtn, 'mt-1.5')}
        >
          <Plus size={12} /> Add column
        </button>

        <div className="mt-4 max-w-4xl">
          <div className="mb-1 font-display text-2xs text-fg-muted">SQL preview</div>
          <pre
            className={cn(
              'max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-surface-1 px-3 py-2 font-mono text-xs ring-1 ring-inset ring-edge-1',
              problem ? 'text-status-warn' : 'text-fg-base/85',
            )}
          >
            {problem ?? (sql || '-- No changes yet.')}
          </pre>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-edge-1 px-4 py-2">
        <button type="button" onClick={onClose} className={textBtn}>
          Cancel
        </button>
        <button
          type="button"
          disabled={!!problem || !sql}
          onClick={() => onSendToEditor(sql)}
          className={primaryBtn}
        >
          Open SQL in editor
        </button>
      </div>
    </div>
  );
}
