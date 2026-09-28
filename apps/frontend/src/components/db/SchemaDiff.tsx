import { useMemo, useState } from 'react';
import { ArrowRight, Copy, Download, GitCompareArrows, Loader2, SquarePen, X } from 'lucide-react';
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
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-hairline px-3 py-1.5">
        <GitCompareArrows size={12} className="shrink-0 text-fg-subtle" />
        <span className="font-sans text-xs text-fg-base">Schema diff</span>
        {others.length === 0 ? (
          <span className="font-sans text-xs text-fg-subtle">
            Save another {active.backend} connection to compare against.
          </span>
        ) : (
          <>
            <select
              value={otherId}
              onChange={(e) => setOtherId(e.target.value)}
              className="rounded-md border border-border-subtle bg-bg-base/60 px-1.5 py-0.5 font-sans text-xs text-fg-base focus:border-accent/45 focus:outline-none"
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
              className="flex items-center gap-1 rounded px-1.5 py-0.5 font-sans text-xs text-fg-muted ring-1 ring-edge-2 transition hover:bg-surface-2 hover:text-fg-base"
            >
              make <span className="font-medium text-fg-base">{target}</span> match{' '}
              <span className="font-medium text-fg-base">{source}</span>
            </button>
            <button
              type="button"
              onClick={() => void compare()}
              disabled={loading || !other}
              className="flex items-center gap-1 rounded-lg bg-accent-soft px-2.5 py-0.5 font-sans text-xs text-fg-base ring-1 ring-accent/45 transition-colors hover:bg-accent/20 disabled:opacity-40"
            >
              {loading && <Loader2 size={11} className="animate-spin" />}
              {loaded ? 'Compare again' : 'Compare'}
            </button>
          </>
        )}
        <button type="button" onClick={onClose} title="Back to results" className="ml-auto shrink-0 text-fg-subtle hover:text-fg-base">
          <X size={12} />
        </button>
      </div>

      {error && <p className="px-3 py-2 font-sans text-xs text-status-err">{error}</p>}

      {diffs && (
        <div className="flex min-h-0 flex-1">
          <div className="w-72 shrink-0 overflow-auto border-r border-border-hairline py-1">
            {diffs.length === 0 && (
              <p className="px-3 py-2 font-sans text-xs text-fg-subtle">The schemas match.</p>
            )}
            {diffs.map((d) => (
              <div key={d.table} className="px-3 py-1">
                <div className="flex items-center gap-1.5">
                  <span className={cn('font-sans text-2xs uppercase tracking-widest', STATUS_STYLE[d.status])}>
                    {d.status}
                  </span>
                  <span className="truncate font-mono text-xs text-fg-base">{d.table}</span>
                </div>
                {d.status === 'changed' && (
                  <ul className="mt-0.5 space-y-0.5 pl-2">
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
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-1 border-b border-border-hairline px-3 py-1">
              <span className="font-sans text-2xs uppercase tracking-widest text-fg-subtle/60">
                SQL to run on {target}
              </span>
              <span className="flex-1" />
              {sql && (
                <>
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard.writeText(sql).then(() => toast('SQL copied'))}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 font-sans text-2xs text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
                  >
                    <Copy size={10} /> Copy
                  </button>
                  <button
                    type="button"
                    onClick={() => void save()}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 font-sans text-2xs text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
                  >
                    <Download size={10} /> Save .sql
                  </button>
                  {!applyToOther && (
                    <button
                      type="button"
                      onClick={() => onSendToEditor(sql)}
                      title="Load into this connection's editor to review and run"
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 font-sans text-2xs text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
                    >
                      <SquarePen size={10} /> Open in editor
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
        <p className="px-3 py-3 font-sans text-xs leading-relaxed text-fg-subtle">
          Pick a connection and Compare. Nothing runs from here: review the generated SQL, then copy
          it, save it, or open it in the editor of the database it targets.
        </p>
      )}
    </div>
  );
}
