import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  Columns3,
  Database,
  Download,
  History,
  KeyRound,
  ListTree,
  Loader2,
  Play,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import {
  dbConnDelete,
  dbConnList,
  dbConnUpsert,
  dbConnect,
  dbDisconnect,
  dbExport,
  dbExportCancel,
  dbHistoryClear,
  dbHistoryDelete,
  dbHistoryList,
  dbPasswordSet,
  dbPreview,
  dbQuery,
  dbTableSchema,
  dbTables,
  fsPickSaveFile,
  fsWriteFile,
  isTauri,
  type DbBackend,
  type DbConnection,
  type DbQueryHistoryEntry,
  type DbQueryResult,
  type DbTableSchema,
} from '../lib/tauri';
import { useWorkspace } from '../state/workspace';
import { askConfirm } from '../state/confirm';
import { toast, toastError } from '../state/toast';
import { cn } from '../lib/cn';
import { toCsv, toJson } from '../lib/dbExport';
import { isSelectLike, unsafeStatements } from '../lib/sqlSafety';
import { explainSql, hotNodes, parsePlan, type PlanNode } from '../lib/explainPlan';

interface Props {
  tabId: string;
}

/** Backends we can talk to, and the placeholder that shows the URL shape. */
const BACKENDS: Array<{ id: DbBackend; label: string; placeholder: string }> = [
  {
    id: 'postgres',
    label: 'PostgreSQL',
    placeholder: 'postgres://user@localhost:5432/mydb',
  },
  { id: 'mysql', label: 'MySQL', placeholder: 'mysql://user@localhost:3306/mydb' },
  { id: 'sqlite', label: 'SQLite', placeholder: 'sqlite:///path/to/app.db' },
];

/**
 * Strip the password out of a pasted URL.
 *
 * People paste whole connection strings, password included — that's the
 * normal way to hand one around. We take the password into the OS vault and
 * keep only the rest, so what lands in the database is `postgres://user@host/db`.
 */
export function splitPassword(url: string): { url: string; password: string } {
  const at = url.indexOf('://');
  if (at < 0) return { url, password: '' };
  const rest = url.slice(at + 3);
  const endIdx = rest.search(/[/?#]/);
  const end = endIdx < 0 ? rest.length : endIdx;
  const authority = rest.slice(0, end);
  const tail = rest.slice(end);
  const sep = authority.lastIndexOf('@');
  if (sep < 0) return { url, password: '' };
  const userinfo = authority.slice(0, sep);
  const host = authority.slice(sep + 1);
  const colon = userinfo.indexOf(':');
  if (colon < 0) return { url, password: '' };
  const user = userinfo.slice(0, colon);
  const password = decodeURIComponent(userinfo.slice(colon + 1));
  return {
    url: `${url.slice(0, at + 3)}${user}@${host}${tail}`,
    password,
  };
}

/** Guess the backend from a URL so the form's radio follows what you paste. */
function backendFromUrl(url: string): DbBackend | null {
  const scheme = url.split('://')[0]?.toLowerCase() ?? '';
  if (scheme === 'postgres' || scheme === 'postgresql') return 'postgres';
  if (scheme === 'mysql' || scheme === 'mariadb') return 'mysql';
  if (scheme === 'sqlite') return 'sqlite';
  return null;
}

/**
 * A database client tab: saved connections on the left, a SQL editor and a
 * results grid on the right.
 *
 * Deliberately the same shape as the API Client tab — connections are its
 * collections, the query box is its request pane, the grid is its response.
 * Anyone who has used one already knows this one.
 */
export function DbClient({ tabId }: Props) {
  const initialConnectionId = useWorkspace(
    (s) => s.tabs.find((t) => t.id === tabId)?.dbConnectionId,
  );
  const setTabDbConnection = useWorkspace((s) => s.setTabDbConnection);

  const [connections, setConnections] = useState<DbConnection[]>([]);
  const [activeId, setActiveId] = useState<string | null>(initialConnectionId ?? null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [tables, setTables] = useState<string[]>([]);
  const [sql, setSql] = useState('');
  const [result, setResult] = useState<DbQueryResult | null>(null);
  /** When set, the results pane shows this table's structure instead of the grid. */
  const [schema, setSchema] = useState<{ table: string; data: DbTableSchema } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** The statement behind `result`, re-run by the full export. */
  const [resultSql, setResultSql] = useState('');
  /** When set, the results pane shows this query plan instead of the grid. */
  const [plan, setPlan] = useState<{ roots: PlanNode[]; analyze: boolean } | null>(null);
  const [analyze, setAnalyze] = useState(false);
  const [exporting, setExporting] = useState<{ id: string; rows: number } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<DbQueryHistoryEntry[]>([]);

  const active = useMemo(
    () => connections.find((c) => c.id === activeId) ?? null,
    [connections, activeId],
  );

  const reloadConnections = useCallback(async () => {
    if (!isTauri) return;
    try {
      setConnections(await dbConnList());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void reloadConnections();
  }, [reloadConnections]);

  // Selecting a connection resets everything downstream of it — leaving the
  // previous database's tables and grid on screen under a new name would be
  // actively misleading.
  const select = useCallback(
    (id: string | null, name?: string) => {
      setActiveId(id);
      setConnected(false);
      setTables([]);
      setResult(null);
      setSchema(null);
      setPlan(null);
      setHistory([]);
      setError(null);
      setTabDbConnection(tabId, id ?? undefined, name ?? 'Database');
    },
    [setTabDbConnection, tabId],
  );

  const connect = useCallback(async () => {
    if (!activeId || connecting) return;
    setConnecting(true);
    setError(null);
    try {
      await dbConnect(activeId);
      setConnected(true);
      setTables(await dbTables(activeId));
      await reloadConnections(); // refresh last-used ordering
    } catch (e) {
      setConnected(false);
      setError(String(e));
    } finally {
      setConnecting(false);
    }
  }, [activeId, connecting, reloadConnections]);

  const disconnect = useCallback(async () => {
    if (!activeId) return;
    await dbDisconnect(activeId);
    setConnected(false);
    setTables([]);
  }, [activeId]);

  const reloadHistory = useCallback(async () => {
    if (!activeId) return;
    try {
      setHistory(await dbHistoryList(activeId));
    } catch (e) {
      toastError(String(e));
    }
  }, [activeId]);

  useEffect(() => {
    if (historyOpen) void reloadHistory();
  }, [historyOpen, reloadHistory]);

  /** Ask before a destructive statement runs. True when it may proceed. */
  const confirmSafe = useCallback(
    async (text: string, action: string) => {
      const risky = unsafeStatements(text, active?.backend);
      if (risky.length === 0) return true;
      return askConfirm({
        title: `${action} a destructive statement?`,
        body: `${risky.join(', ')} — this affects every row and can't be undone from here.`,
        confirmLabel: `${action} anyway`,
        destructive: true,
      });
    },
    [active?.backend],
  );

  // Queries are serialized by `running`, so a slow one can't have its results
  // overwritten by a fast one started after it.
  const run = useCallback(
    async (text: string) => {
      if (!activeId || !connected || running) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      if (!(await confirmSafe(trimmed, 'Run'))) return;
      setRunning(true);
      setError(null);
      setSchema(null);
      setPlan(null);
      try {
        setResult(await dbQuery(activeId, trimmed));
        setResultSql(trimmed);
      } catch (e) {
        setResult(null);
        setError(String(e));
      } finally {
        setRunning(false);
        // The backend recorded the statement either way.
        if (historyOpen) void reloadHistory();
      }
    },
    [activeId, confirmSafe, connected, running, historyOpen, reloadHistory],
  );

  /** EXPLAIN the editor's statement and show the plan tree. ANALYZE executes
   *  the statement, so the destructive-statement check applies to it. */
  const explain = useCallback(
    async (text: string) => {
      if (!activeId || !active || !connected || running) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      const withAnalyze = analyze && active.backend === 'postgres';
      if (withAnalyze && !(await confirmSafe(trimmed, 'Execute'))) return;
      setRunning(true);
      setError(null);
      setSchema(null);
      try {
        const res = await dbQuery(activeId, explainSql(active.backend, trimmed, withAnalyze));
        setPlan({ roots: parsePlan(active.backend, res), analyze: withAnalyze });
      } catch (e) {
        setPlan(null);
        setError(String(e));
      } finally {
        setRunning(false);
        if (historyOpen) void reloadHistory();
      }
    },
    [activeId, active, analyze, confirmSafe, connected, running, historyOpen, reloadHistory],
  );

  /** Re-run the result's statement in Rust and stream every row to a file. */
  const exportFull = useCallback(
    async (format: 'csv' | 'json') => {
      if (!activeId || exporting || !resultSql) return;
      if (!isSelectLike(resultSql, active?.backend)) {
        toastError('Only a single SELECT-like statement can be exported in full.');
        return;
      }
      if (!(await confirmSafe(resultSql, 'Export'))) return;
      const path = await fsPickSaveFile(`results.${format}`);
      if (!path) return;
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      setExporting({ id, rows: 0 });
      try {
        const rows = await dbExport(activeId, resultSql, format, path, id, (n) =>
          setExporting((x) => (x ? { ...x, rows: n } : x)),
        );
        toast(`Saved ${rows} row${rows === 1 ? '' : 's'} to ${path}`);
      } catch (e) {
        toastError(String(e));
      } finally {
        setExporting(null);
      }
    },
    [activeId, active?.backend, confirmSafe, exporting, resultSql],
  );

  const showSchema = useCallback(
    async (table: string) => {
      if (!activeId) return;
      setError(null);
      try {
        setSchema({ table, data: await dbTableSchema(activeId, table) });
      } catch (e) {
        setError(String(e));
      }
    },
    [activeId],
  );

  const exportResult = useCallback(
    async (format: 'csv' | 'json') => {
      if (!result) return;
      try {
        const path = await fsPickSaveFile(`results.${format}`);
        if (!path) return;
        const text =
          format === 'csv' ? toCsv(result.columns, result.rows) : toJson(result.columns, result.rows);
        await fsWriteFile(path, text);
        toast(`Saved ${result.rows.length} row${result.rows.length === 1 ? '' : 's'} to ${path}`);
      } catch (e) {
        toastError(String(e));
      }
    },
    [result],
  );

  const previewTable = useCallback(
    async (table: string) => {
      if (!activeId || running) return;
      setRunning(true);
      setError(null);
      setSchema(null);
      setPlan(null);
      // Show the query we ran, so the next edit starts from something real.
      const shown = `SELECT * FROM ${table} LIMIT 200`;
      setSql(shown);
      try {
        setResult(await dbPreview(activeId, table, 200));
        setResultSql(shown);
      } catch (e) {
        setResult(null);
        setError(String(e));
      } finally {
        setRunning(false);
      }
    },
    [activeId, running],
  );

  const remove = useCallback(
    async (conn: DbConnection) => {
      const ok = await askConfirm({
        title: `Delete “${conn.name}”?`,
        body: 'The saved connection and its stored password are removed. The database itself is untouched.',
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!ok) return;
      try {
        await dbConnDelete(conn.id);
        if (activeId === conn.id) select(null);
        await reloadConnections();
      } catch (e) {
        toastError(String(e));
      }
    },
    [activeId, reloadConnections, select],
  );

  if (!isTauri) {
    return (
      <div className="flex h-full items-center justify-center font-sans text-xs text-fg-subtle">
        The database client needs the desktop app.
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden bg-bg-base text-sm">
      {/* ── Connections rail ── */}
      <div className="flex w-56 shrink-0 flex-col border-r border-border-hairline bg-bg-panel/40">
        <div className="flex items-center gap-1.5 px-3 py-2">
          <span className="flex-1 font-sans text-2xs uppercase tracking-widest text-fg-subtle/60">
            Connections
          </span>
          <button
            type="button"
            onClick={() => setAdding(true)}
            title="Add a connection"
            className="flex h-5 w-5 items-center justify-center rounded text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
          >
            <Plus size={12} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto pb-2">
          {connections.length === 0 && !adding && (
            <p className="px-3 py-2 font-sans text-xs leading-relaxed text-fg-subtle">
              No connections yet. Add one to browse a database.
            </p>
          )}
          {connections.map((c) => (
            <div
              key={c.id}
              className={cn(
                'group flex items-center gap-2 px-3 py-1.5',
                activeId === c.id ? 'bg-surface-2' : 'hover:bg-surface-1',
              )}
            >
              <button
                type="button"
                onClick={() => select(c.id, c.name)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <Database size={12} className="shrink-0 text-fg-subtle" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-sans text-xs text-fg-base">{c.name}</span>
                  <span className="block truncate font-mono text-2xs text-fg-subtle/70">
                    {c.url}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => void remove(c)}
                title="Delete connection"
                className="shrink-0 text-fg-subtle opacity-0 transition hover:text-status-err group-hover:opacity-100"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}

          {/* Tables of the connected database, indented under its row. */}
          {connected && tables.length > 0 && (
            <div className="mt-2 border-t border-border-hairline pt-2">
              <div className="px-3 pb-1 font-sans text-2xs uppercase tracking-widest text-fg-subtle/60">
                Tables
              </div>
              {tables.map((t) => (
                <div
                  key={t}
                  className={cn(
                    'group flex items-center gap-2 px-3 py-1',
                    schema?.table === t ? 'bg-surface-2' : 'hover:bg-surface-1',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => void previewTable(t)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <Table2 size={11} className="shrink-0 text-fg-subtle" />
                    <span className="truncate font-mono text-xs text-fg-base/85">{t}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void showSchema(t)}
                    title="Show schema"
                    className="shrink-0 text-fg-subtle opacity-0 transition hover:text-fg-base group-hover:opacity-100"
                  >
                    <Columns3 size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {connected && tables.length === 0 && (
            <p className="px-3 py-2 font-sans text-xs text-fg-subtle">No tables.</p>
          )}
        </div>
      </div>

      {/* ── Query pane ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border-hairline px-3 py-1.5">
          <span className="truncate font-sans text-sm text-fg-base">
            {active ? active.name : 'No connection selected'}
          </span>
          {active && (
            <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-sans text-2xs text-fg-subtle">
              {active.backend}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {active && (
              <button
                type="button"
                onClick={() => void (connected ? disconnect() : connect())}
                disabled={connecting}
                className={cn(
                  'flex items-center gap-1 rounded-lg px-2.5 py-1 font-sans text-xs transition-colors disabled:opacity-40',
                  connected
                    ? 'text-fg-muted hover:bg-surface-2 hover:text-fg-base'
                    : 'bg-accent-soft text-fg-base ring-1 ring-accent/45 hover:bg-accent/20',
                )}
              >
                {connecting ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : connected ? (
                  <PlugZap size={11} />
                ) : (
                  <Plug size={11} />
                )}
                {connecting ? 'connecting…' : connected ? 'Disconnect' : 'Connect'}
              </button>
            )}
            {connected && (
              <button
                type="button"
                onClick={() => void dbTables(activeId!).then(setTables).catch(() => {})}
                title="Refresh tables"
                className="flex h-6 w-6 items-center justify-center rounded text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
              >
                <RefreshCw size={12} />
              </button>
            )}
            {active && (
              <button
                type="button"
                onClick={() => setHistoryOpen((o) => !o)}
                title="Query history"
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded transition hover:bg-surface-2 hover:text-fg-base',
                  historyOpen ? 'bg-surface-2 text-fg-base' : 'text-fg-muted',
                )}
              >
                <History size={12} />
              </button>
            )}
          </div>
        </div>

        {adding && (
          <ConnectionForm
            onCancel={() => setAdding(false)}
            onSaved={async (conn) => {
              setAdding(false);
              await reloadConnections();
              select(conn.id, conn.name);
            }}
          />
        )}

        {error && (
          <div className="flex shrink-0 items-start gap-2 border-b border-border-hairline bg-status-err/10 px-3 py-1.5 font-sans text-xs text-status-err">
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{error}</span>
            <button type="button" onClick={() => setError(null)} className="shrink-0 hover:opacity-70">
              <X size={12} />
            </button>
          </div>
        )}

        {/* SQL editor. A plain textarea: this is a query box, and wiring a
            second CodeMirror instance in here would buy highlighting at the
            cost of a whole editor lifecycle to keep in sync. */}
        <div className="shrink-0 border-b border-border-hairline">
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void run(sql);
              }
            }}
            placeholder={connected ? 'SELECT …    (⌘/Ctrl + Enter to run)' : 'Connect first'}
            disabled={!connected}
            spellCheck={false}
            rows={5}
            className="w-full resize-y bg-bg-base px-3 py-2 font-mono text-sm leading-[19px] text-fg-base placeholder:text-fg-subtle/70 focus:outline-none disabled:opacity-50"
          />
          <div className="flex items-center gap-2 px-3 pb-1.5">
            <button
              type="button"
              onClick={() => void run(sql)}
              disabled={!connected || running || !sql.trim()}
              className="flex items-center gap-1 rounded-lg bg-accent-soft px-2.5 py-1 font-sans text-xs text-fg-base ring-1 ring-accent/45 transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {running ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
              Run
            </button>
            <button
              type="button"
              onClick={() => void explain(sql)}
              disabled={!connected || running || !sql.trim()}
              title="Show the query plan"
              className="flex items-center gap-1 rounded-lg px-2.5 py-1 font-sans text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ListTree size={11} />
              Explain
            </button>
            {active?.backend === 'postgres' && (
              <label
                className="flex items-center gap-1 font-sans text-xs text-fg-subtle"
                title="EXPLAIN ANALYZE executes the statement — writes included — to measure real rows and timings."
              >
                <input
                  type="checkbox"
                  checked={analyze}
                  onChange={(e) => setAnalyze(e.target.checked)}
                  className="h-3 w-3 accent-accent"
                />
                Analyze
                {analyze && <span className="text-status-warn">(executes the query)</span>}
              </label>
            )}
            {result && !plan && (
              <span className="font-sans text-xs text-fg-subtle">
                {result.columns.length > 0
                  ? `${result.rows.length} row${result.rows.length === 1 ? '' : 's'}`
                  : `${result.rows_affected} row${result.rows_affected === 1 ? '' : 's'} affected`}
                {' · '}
                {result.duration_ms} ms
                {result.truncated && ' · truncated'}
              </span>
            )}
            {exporting ? (
              <div className="ml-auto flex items-center gap-1.5 font-sans text-xs text-fg-subtle">
                <Loader2 size={11} className="animate-spin" />
                Exporting… {exporting.rows.toLocaleString()} rows
                <button
                  type="button"
                  onClick={() => void dbExportCancel(exporting.id)}
                  className="rounded px-1.5 py-0.5 text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
                >
                  Cancel
                </button>
              </div>
            ) : (
              result &&
              result.columns.length > 0 &&
              !schema &&
              !plan && (
                <div className="ml-auto flex items-center gap-1">
                  {(['csv', 'json'] as const).map((format) => (
                    <button
                      key={format}
                      type="button"
                      onClick={() => void exportResult(format)}
                      title={`Export these rows as ${format.toUpperCase()}`}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 font-sans text-2xs uppercase text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
                    >
                      <Download size={10} />
                      {format}
                    </button>
                  ))}
                  <span className="mx-0.5 h-3 w-px bg-border-hairline" />
                  {(['csv', 'json'] as const).map((format) => (
                    <button
                      key={format}
                      type="button"
                      onClick={() => void exportFull(format)}
                      title={`Export full result as ${format.toUpperCase()} — re-runs the query and streams every row to the file, past the grid's cap`}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 font-sans text-2xs uppercase text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
                    >
                      <Download size={10} />
                      full {format}
                    </button>
                  ))}
                </div>
              )
            )}
          </div>
        </div>

        {/* ── Results grid ── */}
        <div className="min-h-0 flex-1 overflow-auto">
          {schema ? (
            <SchemaView table={schema.table} schema={schema.data} onClose={() => setSchema(null)} />
          ) : plan ? (
            <PlanView roots={plan.roots} analyze={plan.analyze} onClose={() => setPlan(null)} />
          ) : result && result.columns.length > 0 ? (
            <table className="w-max min-w-full border-collapse text-left">
              <thead className="sticky top-0 bg-bg-chrome">
                <tr>
                  {result.columns.map((c, i) => (
                    <th
                      key={`${c}-${i}`}
                      className="whitespace-nowrap border-b border-r border-border-hairline px-2.5 py-1 font-sans text-2xs uppercase tracking-widest text-fg-subtle/70"
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, ri) => (
                  <tr key={ri} className={ri % 2 ? 'bg-surface-1' : undefined}>
                    {row.map((cell, ci) => (
                      <td
                        key={ci}
                        title={cell ?? 'NULL'}
                        className="max-w-md truncate border-b border-r border-border-hairline px-2.5 py-0.5 font-mono text-xs text-fg-base/85"
                      >
                        {cell === null ? (
                          <span className="italic text-fg-subtle/60">NULL</span>
                        ) : (
                          cell
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="flex h-32 items-center justify-center font-sans text-xs text-fg-subtle">
              {result
                ? 'Statement ran — no rows returned.'
                : connected
                  ? 'Run a query, or pick a table on the left.'
                  : 'Not connected.'}
            </div>
          )}
        </div>
      </div>

      {historyOpen && activeId && (
        <HistoryPanel
          entries={history}
          onLoad={(h) => setSql(h.sql)}
          onDelete={async (h) => {
            try {
              await dbHistoryDelete(h.id);
              setHistory((list) => list.filter((x) => x.id !== h.id));
            } catch (e) {
              toastError(String(e));
            }
          }}
          onClear={async () => {
            const ok = await askConfirm({
              title: 'Clear query history?',
              body: `Every recorded statement for “${active?.name ?? 'this connection'}” is removed.`,
              confirmLabel: 'Clear',
              destructive: true,
            });
            if (!ok) return;
            try {
              await dbHistoryClear(activeId);
              setHistory([]);
            } catch (e) {
              toastError(String(e));
            }
          }}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Query history ───────────────────────────────────────────────────────────

/** The connection's recorded statements, newest first. Click one to load it. */
function HistoryPanel({
  entries,
  onLoad,
  onDelete,
  onClear,
  onClose,
}: {
  entries: DbQueryHistoryEntry[];
  onLoad: (h: DbQueryHistoryEntry) => void;
  onDelete: (h: DbQueryHistoryEntry) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? entries.filter((h) => h.sql.toLowerCase().includes(q)) : entries;
  }, [entries, query]);

  return (
    <div className="flex w-72 shrink-0 flex-col border-l border-border-hairline bg-bg-panel/40">
      <div className="flex items-center gap-1.5 px-3 py-2">
        <span className="flex-1 font-sans text-2xs uppercase tracking-widest text-fg-subtle/60">
          History
        </span>
        {entries.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            title="Clear history"
            className="flex h-5 w-5 items-center justify-center rounded text-fg-muted transition hover:bg-surface-2 hover:text-status-err"
          >
            <Trash2 size={11} />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          title="Close"
          className="flex h-5 w-5 items-center justify-center rounded text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
        >
          <X size={12} />
        </button>
      </div>
      <div className="px-3 pb-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          spellCheck={false}
          className="w-full rounded-lg border border-border-subtle bg-bg-base/60 px-2.5 py-1 font-sans text-xs text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:outline-none"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-2">
        {shown.length === 0 && (
          <p className="px-3 py-2 font-sans text-xs text-fg-subtle">
            {entries.length === 0 ? 'No queries run yet.' : 'No matches.'}
          </p>
        )}
        {shown.map((h) => (
          <div key={h.id} className="group flex items-start gap-2 px-3 py-1.5 hover:bg-surface-1">
            <button
              type="button"
              onClick={() => onLoad(h)}
              title={h.error ?? 'Load into the editor'}
              className="min-w-0 flex-1 text-left"
            >
              <span className="line-clamp-2 break-all font-mono text-xs text-fg-base/85">{h.sql}</span>
              <span className="mt-0.5 flex gap-1.5 font-sans text-2xs text-fg-subtle/70">
                <span>{new Date(h.executed_at).toLocaleString()}</span>
                <span>{h.duration_ms} ms</span>
                {h.error ? (
                  <span className="text-status-err">error</span>
                ) : (
                  <span>
                    {h.row_count} row{h.row_count === 1 ? '' : 's'}
                  </span>
                )}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onDelete(h)}
              title="Delete"
              className="mt-0.5 shrink-0 text-fg-subtle opacity-0 transition hover:text-status-err group-hover:opacity-100"
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Plan view ───────────────────────────────────────────────────────────────

/** A query plan as a collapsible tree, with the expensive nodes marked. */
function PlanView({
  roots,
  analyze,
  onClose,
}: {
  roots: PlanNode[];
  analyze: boolean;
  onClose: () => void;
}) {
  const hot = useMemo(() => hotNodes(roots), [roots]);
  return (
    <div className="pb-3">
      <div className="flex items-center gap-2 border-b border-border-hairline px-3 py-1.5">
        <ListTree size={12} className="shrink-0 text-fg-subtle" />
        <span className="font-sans text-xs text-fg-base">
          {analyze ? 'Query plan (analyzed)' : 'Query plan'}
        </span>
        <span className="font-sans text-2xs text-status-warn">■ most expensive</span>
        <button
          type="button"
          onClick={onClose}
          title="Back to results"
          className="ml-auto shrink-0 text-fg-subtle hover:text-fg-base"
        >
          <X size={12} />
        </button>
      </div>
      {roots.length === 0 && (
        <p className="px-3 py-2 font-sans text-xs text-fg-subtle">The plan is empty.</p>
      )}
      {roots.map((n, i) => (
        <PlanNodeRow key={i} node={n} depth={0} hot={hot} />
      ))}
    </div>
  );
}

function PlanNodeRow({ node, depth, hot }: { node: PlanNode; depth: number; hot: Set<PlanNode> }) {
  const [open, setOpen] = useState(true);
  const isHot = hot.has(node);
  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const stats = [
    node.estRows !== undefined && `est ${fmt(node.estRows)} rows`,
    node.estCost !== undefined && `cost ${fmt(node.estCost)}`,
    node.actualRows !== undefined && `actual ${fmt(node.actualRows)} rows`,
    node.actualMs !== undefined && `${fmt(node.actualMs)} ms`,
  ].filter(Boolean);
  return (
    <>
      <div
        className={cn(
          'flex items-center gap-1.5 py-0.5 pr-3 hover:bg-surface-1',
          isHot && 'bg-status-warn/10',
        )}
        style={{ paddingLeft: 12 + depth * 16 }}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center text-fg-subtle',
            node.children.length === 0 && 'invisible',
          )}
        >
          <ChevronRight size={10} className={cn('transition-transform', open && 'rotate-90')} />
        </button>
        <span className={cn('font-mono text-xs', isHot ? 'text-status-warn' : 'text-fg-base')}>
          {node.label}
        </span>
        {node.relation && !node.label.includes(node.relation) && (
          <span className="font-mono text-xs text-accent">{node.relation}</span>
        )}
        {node.detail && (
          <span className="truncate font-mono text-2xs text-fg-subtle" title={node.detail}>
            {node.detail}
          </span>
        )}
        {stats.length > 0 && (
          <span className="ml-auto shrink-0 pl-3 font-sans text-2xs text-fg-subtle/80">
            {stats.join(' · ')}
          </span>
        )}
      </div>
      {open && node.children.map((c, i) => <PlanNodeRow key={i} node={c} depth={depth + 1} hot={hot} />)}
    </>
  );
}

// ─── Schema view ─────────────────────────────────────────────────────────────

const TH =
  'whitespace-nowrap border-b border-r border-border-hairline px-2.5 py-1 font-sans text-2xs uppercase tracking-widest text-fg-subtle/70';
const TD =
  'max-w-md truncate border-b border-r border-border-hairline px-2.5 py-0.5 font-mono text-xs text-fg-base/85';

/** A table's columns, indexes and foreign keys, in the grid's own styling. */
function SchemaView({
  table,
  schema,
  onClose,
}: {
  table: string;
  schema: DbTableSchema;
  onClose: () => void;
}) {
  const section = (label: string) => (
    <div className="px-3 pb-1 pt-3 font-sans text-2xs uppercase tracking-widest text-fg-subtle/60">
      {label}
    </div>
  );
  return (
    <div className="pb-3">
      <div className="flex items-center gap-2 border-b border-border-hairline px-3 py-1.5">
        <Columns3 size={12} className="shrink-0 text-fg-subtle" />
        <span className="truncate font-mono text-xs text-fg-base">{table}</span>
        <button
          type="button"
          onClick={onClose}
          title="Back to results"
          className="ml-auto shrink-0 text-fg-subtle hover:text-fg-base"
        >
          <X size={12} />
        </button>
      </div>

      {section('Columns')}
      <table className="w-max min-w-full border-collapse text-left">
        <thead>
          <tr>
            {['Name', 'Type', 'Nullable', 'Default'].map((h) => (
              <th key={h} className={TH}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {schema.columns.map((c) => (
            <tr key={c.name}>
              <td className={TD}>
                <span className="flex items-center gap-1.5">
                  {c.name}
                  {c.primary_key && (
                    <span title="Primary key">
                      <KeyRound size={10} className="text-accent" />
                    </span>
                  )}
                </span>
              </td>
              <td className={TD}>{c.data_type}</td>
              <td className={TD}>{c.nullable ? 'yes' : 'no'}</td>
              <td className={TD} title={c.default ?? ''}>
                {c.default ?? <span className="italic text-fg-subtle/60">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {schema.indexes.length > 0 && (
        <>
          {section('Indexes')}
          <table className="w-max min-w-full border-collapse text-left">
            <tbody>
              {schema.indexes.map((ix) => (
                <tr key={ix.name}>
                  <td className={TD}>{ix.name}</td>
                  <td className={TD}>{ix.columns}</td>
                  <td className={TD}>{ix.unique ? 'unique' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {schema.foreign_keys.length > 0 && (
        <>
          {section('Foreign keys')}
          <table className="w-max min-w-full border-collapse text-left">
            <tbody>
              {schema.foreign_keys.map((fk, i) => (
                <tr key={`${fk.name}-${i}`}>
                  {fk.name && <td className={TD}>{fk.name}</td>}
                  <td className={TD}>
                    {fk.columns} → {fk.references}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ─── Connection form ─────────────────────────────────────────────────────────

function ConnectionForm({
  onCancel,
  onSaved,
}: {
  onCancel: () => void;
  onSaved: (conn: DbConnection) => void | Promise<void>;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const backend = backendFromUrl(url);
  const placeholder =
    BACKENDS.find((b) => b.id === backend)?.placeholder ?? BACKENDS[0]!.placeholder;

  const save = async () => {
    if (saving) return;
    const trimmedUrl = url.trim();
    const detected = backendFromUrl(trimmedUrl);
    if (!detected) {
      setError('URL must start with postgres://, mysql:// or sqlite://');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // A pasted URL usually carries the password inline; move it to the
      // vault so only the sanitized URL is persisted.
      const split = splitPassword(trimmedUrl);
      const secret = password || split.password;
      const conn = await dbConnUpsert({
        name: name.trim() || split.url,
        backend: detected,
        url: split.url,
        has_password: secret.length > 0,
      });
      if (secret) await dbPasswordSet(conn.id, secret);
      await onSaved(conn);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="shrink-0 space-y-2 border-b border-border-hairline bg-bg-panel/40 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (optional)"
          spellCheck={false}
          className="w-40 shrink-0 rounded-lg border border-border-subtle bg-bg-base/60 px-2.5 py-1.5 font-sans text-xs text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:outline-none"
        />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') onCancel();
          }}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-bg-base/60 px-2.5 py-1.5 font-mono text-xs text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:outline-none"
        />
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') onCancel();
          }}
          placeholder="Password (optional — or paste it in the URL)"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-bg-base/60 px-2.5 py-1.5 font-sans text-xs text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !url.trim()}
          className="shrink-0 rounded-lg bg-accent-soft px-3 py-1.5 font-sans text-xs text-fg-base ring-1 ring-accent/45 transition-colors hover:bg-accent/20 disabled:opacity-40"
        >
          {saving ? 'saving…' : 'save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded-lg px-2.5 py-1.5 font-sans text-xs text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
        >
          cancel
        </button>
      </div>
      <p className="font-sans text-2xs leading-relaxed text-fg-subtle">
        The password is stored in your OS credential vault, never in ARC&apos;s database — the
        saved URL keeps only <span className="font-mono">user@host</span>.
      </p>
      {error && <p className="font-sans text-xs text-status-err">{error}</p>}
    </div>
  );
}
