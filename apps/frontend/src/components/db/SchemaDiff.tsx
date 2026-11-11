import { useMemo, useState } from 'react';
import { ArrowLeftRight, ArrowRight, Copy, Download, GitCompareArrows, Loader2, Minus, Pencil, Plus, SquarePen, X } from 'lucide-react';
import {
  dbConnect,
  dbDisconnect,
  dbIsConnected,
  dbTables,
  fsPickSaveFile,
  fsWriteFile,
  type DbConnection,
  type DbTableSchema,
} from '../../lib/tauri';
import { loadSchemas } from '../../lib/dbSchemas';
import { diffSchemas, migrationSql, type TableDiff } from '../../lib/schemaDiff';
import { toast, toastError } from '../../state/toast';
import { cn } from '../../lib/cn';
import { ObjIcon, Placeholder, ToolButton, ToolWindowHeader, inputCls, primaryBtn, textBtn } from './chrome';

interface Props {
  active: DbConnection;
  /** The active connection's schemas, already loaded. */
  schemas: Record<string, DbTableSchema>;
  connections: DbConnection[];
  /** Put SQL into this connection's editor. */
  onSendToEditor: (sql: string) => void;
  onClose: () => void;
}

const STATUS_STYLE: Record<TableDiff['status'], string> = {
  added: 'text-status-ok',
  removed: 'text-status-err',
  changed: 'text-status-warn',
};

/** The +/−/~ gutter mark a diff viewer draws beside each table. */
const STATUS_ICON = { added: Plus, removed: Minus, changed: Pencil } as const;
const STATUS_BG: Record<TableDiff['status'], string> = {
  added: 'bg-status-ok/[0.07]',
  removed: 'bg-status-err/[0.07]',
  changed: 'bg-status-warn/[0.06]',
};

/**
 * Compare this connection's schema with another saved connection of the same
 * backend and generate the SQL that makes one match the other. Review-only:
 * the SQL is copied, saved, or sent to the editor — never run from here.
 */
export function SchemaDiff({ active, schemas, connections, onSendToEditor, onClose }: Props) {
  const others = useMemo(
    () => connections.filter((c) => c.id !== active.id && c.backend === active.backend),
    [connections, active],
  );
  const [otherId, setOtherId] = useState(others[0]?.id ?? '');
  /** true: change the *other* database to match this one. */
  const [applyToOther, setApplyToOther] = useState(true);
  const [otherSchemas, setOtherSchemas] = useState<{ id: string; data: Record<string, DbTableSchema> } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const other = others.find((c) => c.id === otherId) ?? null;

  const compare = async () => {
    if (!other) return;
    setLoading(true);
    setError(null);
    // Leave the other connection as we found it.
    let opened = false;
    try {
      if (!(await dbIsConnected(other.id))) {
        await dbConnect(other.id);
        opened = true;
      }
      const data = await loadSchemas(other.id, await dbTables(other.id));
      setOtherSchemas({ id: other.id, data });
    } catch (e) {
      setError(`${other.name}: ${String(e)}`);
    } finally {
      if (opened) await dbDisconnect(other.id).catch(() => {});
      setLoading(false);
    }
  };

  const loaded = otherSchemas && otherSchemas.id === otherId ? otherSchemas.data : null;
  const diffs = useMemo(() => {
    if (!loaded) return null;
    return applyToOther
      ? diffSchemas(active.backend, schemas, loaded)
      : diffSchemas(active.backend, loaded, schemas);
  }, [loaded, applyToOther, active.backend, schemas]);
  const sql = useMemo(() => (diffs ? migrationSql(diffs) : ''), [diffs]);
  const target = applyToOther ? (other?.name ?? 'other') : active.name;
  const source = applyToOther ? active.name : (other?.name ?? 'other');

  const save = async () => {
    try {
      const path = await fsPickSaveFile('migration.sql');
      if (!path) return;
      await fsWriteFile(path, sql + '\n');
      toast(`Saved to ${path}`);
    } catch (e) {
      toastError(String(e));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolWindowHeader actions={<ToolButton icon={X} label="Back to results" onClick={onClose} />}>
        <span className="flex min-w-0 items-center gap-1.5 px-1">
          <GitCompareArrows size={12} className="shrink-0 text-fg-subtle" />
          <span className="font-display text-xs font-medium text-fg-base">Compare schemas</span>
        </span>
        {others.length === 0 ? (
          <span className="px-1 font-display text-xs text-fg-subtle">
            Save another {active.backend} connection to compare against.
          </span>
        ) : (
          <>
            <select
              value={otherId}
              onChange={(e) => setOtherId(e.target.value)}
              aria-label="Connection to compare with"
              className={cn(inputCls, 'ml-1 h-6 font-display')}
            >
              {others.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setApplyToOther((v) => !v)}
              title="Swap which side changes"
              className={cn(textBtn, 'ring-1 ring-inset ring-edge-2')}
            >
              <ArrowLeftRight size={11} />
              Make <span className="font-mono text-fg-base">{target}</span> match{' '}
              <span className="font-mono text-fg-base">{source}</span>
            </button>
            <button type="button" onClick={() => void compare()} disabled={loading || !other} className={primaryBtn}>
              {loading && <Loader2 size={11} className="animate-spin" />}
              {loaded ? 'Compare again' : 'Compare'}
            </button>
          </>
        )}
      </ToolWindowHeader>

      {error && <p className="border-b border-status-err/25 bg-status-err/[0.08] px-3 py-1.5 font-mono text-xs text-status-err">{error}</p>}

      {diffs && (
        <div className="flex min-h-0 flex-1">
          <div className="w-72 shrink-0 overflow-auto border-r border-edge-1">
            <div className="flex h-7 items-center gap-2 border-b border-edge-1 px-3 font-display text-2xs text-fg-subtle">
              {diffs.length === 0 ? 'The schemas match.' : `${diffs.length} table${diffs.length === 1 ? '' : 's'} differ`}
            </div>
            {diffs.map((d) => {
              const Mark = STATUS_ICON[d.status];
              return (
              <div key={d.table} className={cn('border-b border-edge-1 px-2 py-1', STATUS_BG[d.status])}>
                <div className="flex h-5 items-center gap-1.5">
                  <Mark size={11} strokeWidth={2.4} className={cn('shrink-0', STATUS_STYLE[d.status])} aria-label={d.status} />
                  <ObjIcon kind="table" size={11} />
                  <span className="truncate font-mono text-xs text-fg-base">{d.table}</span>
                  <span className={cn('ml-auto shrink-0 font-display text-2xs', STATUS_STYLE[d.status])}>{d.status}</span>
                </div>
                {d.status === 'changed' && (
                  <ul className="mt-0.5 space-y-0.5 pl-5">
                    {d.changes.map((c, i) => (
                      <li
                        key={i}
                        className={cn(
                          'flex gap-1 font-mono text-2xs',
                          c.unsupported ? 'text-status-warn' : 'text-fg-subtle',
                        )}
                        title={c.unsupported ? c.sql.join('\n') : undefined}
                      >
                        <ArrowRight size={9} className="mt-[3px] shrink-0" />
                        <span className="break-all">{c.summary}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              );
            })}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-7 shrink-0 items-center gap-1 border-b border-edge-1 px-3">
              <span className="font-display text-2xs text-fg-subtle">
                SQL to run on <span className="font-mono text-fg-muted">{target}</span>
              </span>
              <span className="flex-1" />
              {sql && (
                <>
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard.writeText(sql).then(() => toast('SQL copied'))}
                    className={textBtn}
                  >
                    <Copy size={11} /> Copy
                  </button>
                  <button type="button" onClick={() => void save()} className={textBtn}>
                    <Download size={11} /> Save .sql
                  </button>
                  {!applyToOther && (
                    <button
                      type="button"
                      onClick={() => onSendToEditor(sql)}
                      title="Load into this connection's editor to review and run"
                      className={primaryBtn}
                    >
                      <SquarePen size={11} /> Open in editor
                    </button>
                  )}
                </>
              )}
            </div>
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs text-fg-base/85">
              {sql || '-- nothing to change'}
            </pre>
          </div>
        </div>
      )}
      {!diffs && !loading && others.length > 0 && !error && (
        <Placeholder>
          <span className="max-w-md leading-relaxed">
            Pick a connection and Compare. Nothing runs from here: review the generated SQL, then copy
            it, save it, or open it in the editor of the database it targets.
          </span>
        </Placeholder>
      )}
    </div>
  );
}
