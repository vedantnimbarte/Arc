import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowLeft,
  Bookmark,
  ChevronRight,
  Copy,
  Database,
  Download,
  FileUp,
  GitCompareArrows,
  HardDriveDownload,
  HardDriveUpload,
  History,
  ListTree,
  Loader2,
  Lock,
  Network,
  Pencil,
  Play,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Square,
  TableProperties,
  Trash2,
  X,
} from 'lucide-react';
import {
  dbApply,
  dbBegin,
  dbCancel,
  dbCommit,
  dbConnDelete,
  dbConnList,
  dbConnUpsert,
  dbConnect,
  dbDisconnect,
  dbDump,
  dbExactCount,
  dbExport,
  dbHistoryClear,
  dbHistoryDelete,
  dbHistoryList,
  dbJobCancel,
  dbPasswordSet,
  dbQuery,
  dbRestore,
  dbRollback,
  dbRowCounts,
  dbSavedDelete,
  dbSavedList,
  dbSavedUpsert,
  dbSshPassphraseSet,
  dbTableSchema,
  dbTables,
  fsPickFiles,
  fsPickSaveFile,
  fsWriteFile,
  isTauri,
  type DbBackend,
  type DbConnection,
  type DbQueryHistoryEntry,
  type DbQueryResult,
  type DbRowCount,
  type DbSafety,
  type DbSavedQuery,
  type DbTableSchema,
} from '../lib/tauri';
import { useWorkspace } from '../state/workspace';
import { askConfirm } from '../state/confirm';
import { toast, toastError } from '../state/toast';
import { cn } from '../lib/cn';
import { toCsv, toJson } from '../lib/dbExport';
import { isReadOnlySql, isSelectLike, unsafeStatements } from '../lib/sqlSafety';
import { explainSql, hotNodes, parsePlan, planText, type PlanNode } from '../lib/explainPlan';
import { editCount, editStatements, emptyEdits, type StagedEdits } from '../lib/dbSql';
import { createTableSql } from '../lib/schemaDiff';
import { loadSchemas, schemaSummary } from '../lib/dbSchemas';
import { bindParams, queryParams } from '../lib/sqlParams';
import { browseSql, newBrowse, type Browse } from '../lib/dbBrowse';
import { buildRelations } from '../lib/dbRelations';
import type { SqlContext } from '../lib/ai';
import { formatRowCount } from '../lib/dbFormat';
import { SchemaDiagram } from './SchemaDiagram';
import { SqlEditor, type SqlEditorHandle } from './db/SqlEditor';
import { ResultGrid } from './db/ResultGrid';
import { QueryPanel, type QueryPanelTab } from './db/QueryPanel';
import { SchemaView } from './db/SchemaView';
import { ImportCsvDialog } from './db/ImportCsvDialog';
import { SchemaDiff } from './db/SchemaDiff';
import { TableTree } from './db/TableTree';
import { DbAnalytics } from './db/DbAnalytics';
import { TableDesigner } from './db/TableDesigner';
import { AskClaudeBar, ClaudeExplain } from './db/ClaudeSql';
import { QueryParamsDialog } from './db/QueryParamsDialog';

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

/** Sidebar group name for backends without schemas: the database name from a
 *  MySQL URL, `main` for SQLite (its name for the attached file). */
function defaultSchema(conn: DbConnection | null): string {
  if (conn?.backend === 'mysql') {
    try {
      const db = decodeURIComponent(new URL(conn.url).pathname.slice(1));
      if (db) return db;
    } catch {
      /* unparsable URL — fall through */
    }
    return conn.name;
  }
  return 'main';
}

/** Guess the backend from a URL so the form's radio follows what you paste. */
function backendFromUrl(url: string): DbBackend | null {
  const scheme = url.split('://')[0]?.toLowerCase() ?? '';
  if (scheme === 'postgres' || scheme === 'postgresql') return 'postgres';
  if (scheme === 'mysql' || scheme === 'mariadb') return 'mysql';
  if (scheme === 'sqlite') return 'sqlite';
  return null;
}

const SAFETY_LEVELS: Array<{ id: DbSafety; label: string; hint: string }> = [
  { id: 'normal', label: 'Normal', hint: 'Asks before DROP, TRUNCATE, or UPDATE/DELETE without WHERE.' },
  { id: 'production', label: 'Production', hint: 'Asks before every write, and shows a red bar while connected.' },
  { id: 'readonly', label: 'Read-only', hint: 'Refuses writes — the server is put in read-only mode too.' },
];

/** A statement that can change the schema, so the sidebar and completion refresh after it. */
const DDL = /\b(create|alter|drop|rename|truncate)\b/i;

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** What the area under the editor shows. */
type Pane = 'grid' | 'schema' | 'plan' | 'diagram' | 'diff' | 'design';

/**
 * One query tab inside the connection: its editor text and what it last
 * showed. The active tab's values live in the component's own state; this
 * snapshot is what an inactive tab keeps until it's switched back to.
 */
interface QueryTab {
  id: string;
  name: string;
  sql: string;
  result: DbQueryResult | null;
  resultSql: string;
  resultTable: string | null;
  browse: Browse | null;
  hasNext: boolean;
  /** Tables left by following foreign keys, for Back. */
  trail: Browse[];
  plan: { roots: PlanNode[]; analyze: boolean } | null;
  pane: Pane;
}

const blankTab = (id: string, n: number): QueryTab => ({
  id,
  name: `Query ${n}`,
  sql: '',
  result: null,
  resultSql: '',
  resultTable: null,
  browse: null,
  hasNext: false,
  trail: [],
  plan: null,
  pane: 'grid',
});

const ICON_BTN =
  'flex h-6 w-6 items-center justify-center rounded transition hover:bg-surface-2 hover:text-fg-base';

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
  /** Every table's schema, for completion, the diagram, the diff and grid edits. */
  const [schemas, setSchemas] = useState<Record<string, DbTableSchema> | null>(null);
  const [rowCounts, setRowCounts] = useState<Record<string, DbRowCount>>({});
  const [sql, setSql] = useState('');
  const [result, setResult] = useState<DbQueryResult | null>(null);
  /** The table `result` previews, when it is one — what makes the grid editable. */
  const [resultTable, setResultTable] = useState<string | null>(null);
  const [edits, setEdits] = useState<StagedEdits>(emptyEdits);
  const [showEditSql, setShowEditSql] = useState(false);
  const [pane, setPane] = useState<Pane>('grid');
  const [view, setView] = useState<'query' | 'analytics'>('query');
  const [schema, setSchema] = useState<{ table: string; data: DbTableSchema } | null>(null);
  const [plan, setPlan] = useState<{ roots: PlanNode[]; analyze: boolean } | null>(null);
  /** Query id of the statement running now; `dbCancel` stops it. */
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ editing: DbConnection | null } | null>(null);
  /** The statement behind `result`, re-run by the full export. */
  const [resultSql, setResultSql] = useState('');
  const [analyze, setAnalyze] = useState(false);
  const [exporting, setExporting] = useState<{ id: string; rows: number } | null>(null);
  const [panel, setPanel] = useState<QueryPanelTab | null>(null);
  const [history, setHistory] = useState<DbQueryHistoryEntry[]>([]);
  const [saved, setSaved] = useState<DbSavedQuery[]>([]);
  const [savingName, setSavingName] = useState<string | null>(null);
  const [autoCommit, setAutoCommit] = useState(true);
  const [inTx, setInTx] = useState(false);
  const [importTable, setImportTable] = useState<string | null>(null);
  /** Server-side browse behind `result`, when it previews a table. */
  const [browse, setBrowse] = useState<Browse | null>(null);
  const [hasNext, setHasNext] = useState(false);
  const [trail, setTrail] = useState<Browse[]>([]);
  const [queryTabs, setQueryTabs] = useState<QueryTab[]>(() => [blankTab('q1', 1)]);
  const [activeTabId, setActiveTabId] = useState('q1');
  const tabCounter = useRef(1);
  /** Table designer target: null table = create. */
  const [design, setDesign] = useState<{ table: string | null } | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  /** The question an open Claude explanation answers; `n` remounts it per question. */
  const [aiExplain, setAiExplain] = useState<
    { n: number; sql: string; problem: { error: string } | { plan: string } } | null
  >(null);
  /** The statement behind `error`, for "Explain with Claude". */
  const [failedSql, setFailedSql] = useState<string | null>(null);
  const [paramPrompt, setParamPrompt] = useState<{ sql: string; names: string[] } | null>(null);
  const paramValues = useRef<Record<string, string>>({});
  const [backingUp, setBackingUp] = useState<'dump' | 'restore' | null>(null);
  const editor = useRef<SqlEditorHandle>(null);
  /** Guards against a slow schema load overwriting a newer one. */
  const schemaLoad = useRef(0);

  const running = runningId !== null;
  const active = useMemo(
    () => connections.find((c) => c.id === activeId) ?? null,
    [connections, activeId],
  );

  const safety: DbSafety = active?.safety ?? 'normal';
  const readOnly = safety === 'readonly';

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

  /** Tables, their schemas and row counts. Schemas and counts load in the
   *  background — the sidebar is usable before they arrive. */
  const refreshCatalog = useCallback(async (id: string) => {
    const list = await dbTables(id);
    setTables(list);
    const token = ++schemaLoad.current;
    void loadSchemas(id, list)
      .then((s) => token === schemaLoad.current && setSchemas(s))
      .catch((e) => toastError(`Schema: ${String(e)}`));
    void dbRowCounts(id)
      .then((counts) => {
        if (token === schemaLoad.current) setRowCounts(Object.fromEntries(counts.map((c) => [c.table, c])));
      })
      .catch(() => {});
  }, []);

  // Selecting a connection resets everything downstream of it — leaving the
  // previous database's tables and grid on screen under a new name would be
  // actively misleading.
  const reset = useCallback(() => {
    schemaLoad.current++;
    setConnected(false);
    setTables([]);
    setSchemas(null);
    setRowCounts({});
    setResult(null);
    setResultTable(null);
    setEdits(emptyEdits());
    setSchema(null);
    setPlan(null);
    setPane('grid');
    setHistory([]);
    setSaved([]);
    setError(null);
    setFailedSql(null);
    setInTx(false);
    setBrowse(null);
    setHasNext(false);
    setTrail([]);
    setDesign(null);
    setAiExplain(null);
    setView('query');
    // Query tabs are per database: the editor text stays with the active tab,
    // the others' results would describe the old database.
    setQueryTabs((tabs) => {
      const keep = tabs.find((t) => t.id === activeTabId) ?? blankTab('q1', 1);
      return [{ ...blankTab(keep.id, 1), name: keep.name }];
    });
  }, [activeTabId]);

  /** Ask before abandoning an open transaction; roll it back if the user agrees. */
  const releaseTransaction = useCallback(async () => {
    if (!inTx || !activeId) return true;
    const ok = await askConfirm({
      title: 'Roll back the open transaction?',
      body: 'Its uncommitted changes are discarded.',
      confirmLabel: 'Roll back',
      destructive: true,
    });
    if (!ok) return false;
    await dbRollback(activeId).catch(() => {});
    setInTx(false);
    return true;
  }, [inTx, activeId]);

  const select = useCallback(
    async (id: string | null, name?: string) => {
      if (id === activeId) return;
      if (!(await releaseTransaction())) return;
      setActiveId(id);
      reset();
      setTabDbConnection(tabId, id ?? undefined, name ?? 'Database');
    },
    [activeId, releaseTransaction, reset, setTabDbConnection, tabId],
  );

  const connect = useCallback(async () => {
    if (!activeId || connecting) return;
    setConnecting(true);
    setError(null);
    try {
      await dbConnect(activeId);
      setConnected(true);
      setInTx(false);
      await refreshCatalog(activeId);
      await reloadConnections(); // refresh last-used ordering
    } catch (e) {
      setConnected(false);
      setError(String(e));
    } finally {
      setConnecting(false);
    }
  }, [activeId, connecting, refreshCatalog, reloadConnections]);

  const disconnect = useCallback(async () => {
    if (!activeId) return;
    if (inTx && !(await releaseTransaction())) return;
    await dbDisconnect(activeId);
    reset();
  }, [activeId, inTx, releaseTransaction, reset]);

  const reloadHistory = useCallback(async () => {
    if (!activeId) return;
    try {
      setHistory(await dbHistoryList(activeId));
    } catch (e) {
      toastError(String(e));
    }
  }, [activeId]);

  const reloadSaved = useCallback(async () => {
    if (!activeId) return;
    try {
      setSaved(await dbSavedList(activeId));
    } catch (e) {
      toastError(String(e));
    }
  }, [activeId]);

  useEffect(() => {
    if (panel === 'history') void reloadHistory();
    if (panel) void reloadSaved();
  }, [panel, reloadHistory, reloadSaved]);

  /**
   * Whether a statement may run, given the connection's safety level:
   * read-only refuses writes outright, production asks before any write, and
   * every level asks before a destructive one. True when it may proceed.
   */
  const confirmSafe = useCallback(
    async (text: string, action: string) => {
      const writes = !isReadOnlySql(text, active?.backend);
      if (safety === 'readonly' && writes) {
        setError('This connection is read-only, and the statement writes. Change the connection’s safety level to run it.');
        return false;
      }
      const risky = unsafeStatements(text, active?.backend);
      if (risky.length > 0) {
        return askConfirm({
          title: `${action} a destructive statement${safety === 'production' ? ' on production' : ''}?`,
          body: `${risky.join(', ')} — this affects every row and can't be undone from here.`,
          confirmLabel: `${action} anyway`,
          destructive: true,
        });
      }
      if (safety === 'production' && writes) {
        return askConfirm({
          title: `${action} on production?`,
          body: `“${active?.name ?? 'This connection'}” is marked production, and this statement changes data or schema.`,
          confirmLabel: action,
          destructive: true,
        });
      }
      return true;
    },
    [active?.backend, active?.name, safety],
  );

  /** The same gate for writes the client builds itself (grid edits, imports). */
  const confirmWrite = useCallback(
    async (what: string) => {
      if (safety === 'readonly') {
        setError('This connection is read-only.');
        return false;
      }
      if (safety !== 'production') return true;
      return askConfirm({
        title: `${what} on production?`,
        body: `“${active?.name ?? 'This connection'}” is marked production.`,
        confirmLabel: what,
        destructive: true,
      });
    },
    [active?.name, safety],
  );

  /** In manual-commit mode, open a transaction before the first write. */
  const ensureTransaction = useCallback(async () => {
    if (autoCommit || inTx || !activeId) return;
    await dbBegin(activeId);
    setInTx(true);
  }, [autoCommit, inTx, activeId]);

  // Queries are serialized by `running`, so a slow one can't have its results
  // overwritten by a fast one started after it.
  const run = useCallback(
    async (text: string, bound = false) => {
      if (!activeId || !active || !connected || running) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      // `:name` parameters are asked for first; the dialog runs the bound text.
      const names = bound ? [] : queryParams(trimmed, active.backend);
      if (names.length > 0) {
        setParamPrompt({ sql: trimmed, names });
        return;
      }
      if (!(await confirmSafe(trimmed, 'Run'))) return;
      const queryId = newId();
      setRunningId(queryId);
      setError(null);
      setFailedSql(null);
      setAiExplain(null);
      setPane('grid');
      try {
        await ensureTransaction();
        setResult(await dbQuery(activeId, trimmed, queryId));
        setResultSql(trimmed);
        setResultTable(null);
        setBrowse(null);
        setTrail([]);
        setEdits(emptyEdits());
        if (DDL.test(trimmed)) void refreshCatalog(activeId);
      } catch (e) {
        setResult(null);
        setError(String(e));
        setFailedSql(trimmed);
      } finally {
        setRunningId(null);
        // The backend recorded the statement either way.
        if (panel === 'history') void reloadHistory();
      }
    },
    [activeId, active, confirmSafe, connected, running, ensureTransaction, refreshCatalog, panel, reloadHistory],
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
      const queryId = newId();
      setRunningId(queryId);
      setError(null);
      try {
        const res = await dbQuery(activeId, explainSql(active.backend, trimmed, withAnalyze), queryId);
        setPlan({ roots: parsePlan(active.backend, res), analyze: withAnalyze });
        setPane('plan');
        setAiExplain(null);
      } catch (e) {
        setError(String(e));
        setFailedSql(trimmed);
      } finally {
        setRunningId(null);
        if (panel === 'history') void reloadHistory();
      }
    },
    [activeId, active, analyze, confirmSafe, connected, running, panel, reloadHistory],
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
      const id = newId();
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
        const data = schemas?.[table] ?? (await dbTableSchema(activeId, table));
        setSchema({ table, data });
        setPane('schema');
      } catch (e) {
        setError(String(e));
      }
    },
    [activeId, schemas],
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

  /** True when there are no staged grid edits, or the user agrees to drop them. */
  const discardEditsOk = useCallback(async () => {
    if (editCount(edits) === 0) return true;
    return askConfirm({
      title: 'Discard unsaved edits?',
      body: 'The staged changes in the grid have not been applied.',
      confirmLabel: 'Discard',
      destructive: true,
    });
  }, [edits]);

  /** Load one page of a table browse into the grid. Kept out of the query
   *  history: sorting and paging would otherwise bury what was typed. */
  const loadBrowse = useCallback(
    async (b: Browse): Promise<boolean> => {
      if (!activeId || !active || running) return false;
      setRunningId(newId());
      setError(null);
      setFailedSql(null);
      setAiExplain(null);
      setPane('grid');
      const fetchSql = browseSql(active.backend, b);
      try {
        const res = await dbQuery(activeId, fetchSql, undefined, { history: false });
        const more = res.rows.length > b.pageSize;
        setResult(more ? { ...res, rows: res.rows.slice(0, b.pageSize) } : res);
        setHasNext(more);
        setBrowse(b);
        setResultTable(b.table);
        // The full export re-runs this — every matching row, not the page.
        setResultSql(browseSql(active.backend, b, 'none'));
        // Show the page's query, so the next edit starts from something real.
        setSql(browseSql(active.backend, b, 'page'));
        setEdits(emptyEdits());
        return true;
      } catch (e) {
        setResult(null);
        setError(String(e));
        setFailedSql(fetchSql);
        return false;
      } finally {
        setRunningId(null);
      }
    },
    [activeId, active, running],
  );

  const previewTable = useCallback(
    async (table: string) => {
      if (!(await discardEditsOk())) return;
      setTrail([]);
      await loadBrowse(newBrowse(table));
    },
    [discardEditsOk, loadBrowse],
  );

  /** Sort, filter or page the current browse. */
  const changeBrowse = useCallback(
    async (b: Browse) => {
      if (await discardEditsOk()) await loadBrowse(b);
    },
    [discardEditsOk, loadBrowse],
  );

  /** Follow a foreign key: open the referenced rows, remembering where we were. */
  const followLink = useCallback(
    async (b: Browse) => {
      if (!(await discardEditsOk())) return;
      const from = browse;
      if ((await loadBrowse(b)) && from) setTrail((t) => [...t, from]);
    },
    [browse, discardEditsOk, loadBrowse],
  );

  const goBack = useCallback(async () => {
    const prev = trail.at(-1);
    if (!prev || !(await discardEditsOk())) return;
    if (await loadBrowse(prev)) setTrail((t) => t.slice(0, -1));
  }, [trail, discardEditsOk, loadBrowse]);

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
        if (activeId === conn.id) {
          setActiveId(null);
          reset();
          setTabDbConnection(tabId, undefined, 'Database');
        }
        await reloadConnections();
      } catch (e) {
        toastError(String(e));
      }
    },
    [activeId, reloadConnections, reset, setTabDbConnection, tabId],
  );

  // ─── Transactions ──────────────────────────────────────────────────────────

  const finishTx = useCallback(
    async (commit: boolean) => {
      if (!activeId) return;
      try {
        await (commit ? dbCommit(activeId) : dbRollback(activeId));
        toast(commit ? 'Committed' : 'Rolled back');
      } catch (e) {
        toastError(String(e));
      } finally {
        setInTx(false);
        void refreshCatalog(activeId);
      }
    },
    [activeId, refreshCatalog],
  );

  // ─── Staged grid edits ─────────────────────────────────────────────────────

  const tableSchema = resultTable ? schemas?.[resultTable] : undefined;
  const pk = useMemo(
    () => tableSchema?.columns.filter((c) => c.primary_key).map((c) => c.name) ?? [],
    [tableSchema],
  );
  const editable =
    !readOnly &&
    !!result &&
    !!resultTable &&
    !!tableSchema &&
    pk.length > 0 &&
    pk.every((c) => result.columns.includes(c));
  const readOnlyReason = !resultTable
    ? null
    : readOnly
      ? 'Read-only connection'
      : !tableSchema
        ? 'Loading schema…'
        : pk.length === 0
          ? 'Read-only: the table has no primary key'
          : null;

  /** Foreign-key columns of the browsed table, each opening the row it references. */
  const relations = useMemo(() => (schemas ? buildRelations(schemas).relations : []), [schemas]);
  const links = useMemo(() => {
    if (!result || !resultTable) return undefined;
    const out: Record<string, { to: string; follow: (row: Array<string | null>) => void }> = {};
    for (const r of relations) {
      if (r.from !== resultTable || r.fromColumns.length !== r.toColumns.length) continue;
      const idx = r.fromColumns.map((c) => result.columns.indexOf(c));
      if (idx.some((i) => i < 0)) continue;
      out[r.fromColumns[0]!] = {
        to: r.to,
        follow: (row) => {
          const values = idx.map((i) => row[i] ?? null);
          if (values.some((v) => v === null)) return;
          void followLink(newBrowse(r.to, Object.fromEntries(r.toColumns.map((c, k) => [c, `=${values[k]}`]))));
        },
      };
    }
    return out;
  }, [relations, result, resultTable, followLink]);

  const aiContext = useMemo<SqlContext | null>(
    () => (active ? { dialect: active.backend, schema: schemaSummary(tables, schemas) } : null),
    [active, tables, schemas],
  );

  const statements = useMemo(
    () =>
      editable && active && result && resultTable
        ? editStatements(active.backend, resultTable, result.columns, result.rows, pk, edits)
        : [],
    [editable, active, result, resultTable, pk, edits],
  );

  const applyEdits = useCallback(async () => {
    if (!activeId || !active || !resultTable || statements.length === 0 || running) return;
    if (!(await confirmWrite('Apply changes'))) return;
    setRunningId(newId());
    setError(null);
    try {
      await ensureTransaction();
      const n = await dbApply(activeId, statements);
      toast(`${n} row${n === 1 ? '' : 's'} changed${!autoCommit ? ' — commit to keep them' : ''}`);
      setEdits(emptyEdits());
      setShowEditSql(false);
      // Re-read the same page, so the grid shows what the database now holds.
      const b = browse ?? newBrowse(resultTable);
      const res = await dbQuery(activeId, browseSql(active.backend, b), undefined, { history: false });
      setHasNext(res.rows.length > b.pageSize);
      setResult({ ...res, rows: res.rows.slice(0, b.pageSize) });
      void dbRowCounts(activeId)
        .then((c) => setRowCounts(Object.fromEntries(c.map((x) => [x.table, x]))))
        .catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setRunningId(null);
      if (panel === 'history') void reloadHistory();
    }
  }, [
    activeId,
    active,
    resultTable,
    statements,
    running,
    confirmWrite,
    ensureTransaction,
    autoCommit,
    browse,
    panel,
    reloadHistory,
  ]);

  // ─── Query tabs ────────────────────────────────────────────────────────────

  /** The active tab as it stands now, from the live state. */
  const snapshot = useCallback(
    (t: QueryTab): QueryTab => ({ ...t, sql, result, resultSql, resultTable, browse, hasNext, trail, plan, pane }),
    [sql, result, resultSql, resultTable, browse, hasNext, trail, plan, pane],
  );

  const loadTab = (t: QueryTab) => {
    setSql(t.sql);
    setResult(t.result);
    setResultSql(t.resultSql);
    setResultTable(t.resultTable);
    setBrowse(t.browse);
    setHasNext(t.hasNext);
    setTrail(t.trail);
    setPlan(t.plan);
    setPane(t.pane === 'design' || t.pane === 'schema' ? 'grid' : t.pane);
    setEdits(emptyEdits());
    setError(null);
    setFailedSql(null);
    setAiExplain(null);
    setActiveTabId(t.id);
  };

  const switchTab = useCallback(
    async (id: string) => {
      if (id === activeTabId || running || !(await discardEditsOk())) return;
      const target = queryTabs.find((t) => t.id === id);
      if (!target) return;
      setQueryTabs((tabs) => tabs.map((t) => (t.id === activeTabId ? snapshot(t) : t)));
      loadTab(target);
    },
    // loadTab only calls setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTabId, running, discardEditsOk, queryTabs, snapshot],
  );

  const newTab = useCallback(async () => {
    if (running || !(await discardEditsOk())) return;
    const n = ++tabCounter.current;
    const fresh = blankTab(`q${n}`, n);
    setQueryTabs((tabs) => [...tabs.map((t) => (t.id === activeTabId ? snapshot(t) : t)), fresh]);
    loadTab(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, discardEditsOk, activeTabId, snapshot]);

  const closeTab = useCallback(
    async (id: string) => {
      if (queryTabs.length === 1 || running) return;
      if (id === activeTabId) {
        if (!(await discardEditsOk())) return;
        const i = queryTabs.findIndex((t) => t.id === id);
        const next = queryTabs[i + 1] ?? queryTabs[i - 1]!;
        loadTab(next);
      }
      setQueryTabs((tabs) => tabs.filter((t) => t.id !== id));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryTabs, running, activeTabId, discardEditsOk],
  );

  // ─── Backup & restore ──────────────────────────────────────────────────────

  const backup = useCallback(async () => {
    if (!activeId || !active || backingUp) return;
    const stamp = new Date().toISOString().slice(0, 10);
    const base = active.name.replace(/[^\w.-]+/g, '-');
    const path = await fsPickSaveFile(`${base}-${stamp}.${active.backend === 'sqlite' ? 'db' : 'sql'}`);
    if (!path) return;
    setBackingUp('dump');
    try {
      await dbDump(activeId, path);
      toast(`Backed up ${active.name} to ${path}`);
    } catch (e) {
      toastError(String(e));
    } finally {
      setBackingUp(null);
    }
  }, [activeId, active, backingUp]);

  const restore = useCallback(async () => {
    if (!activeId || !active || backingUp) return;
    if (readOnly) {
      setError('This connection is read-only.');
      return;
    }
    const [path] = await fsPickFiles();
    if (!path) return;
    const ok = await askConfirm({
      title: `Run ${path.split(/[\\/]/).pop()} against ${active.name}?`,
      body:
        (safety === 'production' ? 'This is a production connection. ' : '') +
        'Every statement in the script runs' +
        (active.backend === 'postgres' ? ' in one transaction, stopping at the first error.' : ', in order.') +
        ' A dump usually drops or replaces what it creates.',
      confirmLabel: 'Restore',
      destructive: true,
    });
    if (!ok) return;
    setBackingUp('restore');
    try {
      await dbRestore(activeId, path);
      toast('Restore finished');
      await refreshCatalog(activeId);
    } catch (e) {
      setError(String(e));
    } finally {
      setBackingUp(null);
    }
  }, [activeId, active, backingUp, readOnly, safety, refreshCatalog]);

  /** Open the CSV import, behind the connection's write gate. */
  const openImport = useCallback(
    async (table: string) => {
      if (await confirmWrite('Import into this table')) setImportTable(table);
    },
    [confirmWrite],
  );

  const openDesigner = useCallback((table: string | null) => {
    setView('query');
    setDesign({ table });
    setPane('design');
  }, []);

  /** Put generated SQL in the editor for review — nothing runs until Run. */
  const sendToEditor = useCallback((text: string, note: string) => {
    setSql(text);
    setPane('grid');
    setDesign(null);
    setView('query');
    toast(note);
  }, []);

  // ─── Saved queries ─────────────────────────────────────────────────────────

  const saveQuery = useCallback(
    async (name: string) => {
      if (!activeId || !sql.trim() || !name.trim()) return;
      try {
        await dbSavedUpsert({ connection_id: activeId, name: name.trim(), sql });
        setSavingName(null);
        setPanel('saved');
        await reloadSaved();
        toast(`Saved “${name.trim()}”`);
      } catch (e) {
        toastError(String(e));
      }
    },
    [activeId, sql, reloadSaved],
  );

  const exactCount = useCallback(
    async (table: string) => {
      if (!activeId) return;
      try {
        const rows = await dbExactCount(activeId, table);
        setRowCounts((c) => ({ ...c, [table]: { table, rows, estimated: false } }));
      } catch (e) {
        toastError(String(e));
      }
    },
    [activeId],
  );

  const copyDdl = useCallback(
    async (table: string, data: DbTableSchema) => {
      if (!active) return;
      await navigator.clipboard.writeText(createTableSql(active.backend, table, data).join(';\n\n') + ';');
      toast(`CREATE TABLE ${table} copied`);
    },
    [active],
  );

  const completion = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const t of tables) out[t] = schemas?.[t]?.columns.map((c) => c.name) ?? [];
    return out;
  }, [tables, schemas]);

  const schemaActions = (table: string, data: DbTableSchema) => (
    <>
      <button
        type="button"
        onClick={() => void copyDdl(table, data)}
        title="Copy CREATE TABLE"
        className="flex items-center gap-1 rounded px-1.5 py-0.5 font-sans text-2xs text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
      >
        <Copy size={10} /> DDL
      </button>
      {!readOnly && (
        <>
          <button
            type="button"
            onClick={() => openDesigner(table)}
            title="Add, rename, change or drop columns"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 font-sans text-2xs text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
          >
            <TableProperties size={10} /> Alter
          </button>
          <button
            type="button"
            onClick={() => void openImport(table)}
            title="Import rows from a CSV file"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 font-sans text-2xs text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
          >
            <FileUp size={10} /> Import CSV
          </button>
        </>
      )}
    </>
  );

  if (!isTauri) {
    return (
      <div className="flex h-full items-center justify-center font-sans text-xs text-fg-subtle">
        The database client needs the desktop app.
      </div>
    );
  }

  const nEdits = editCount(edits);

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
            onClick={() => setForm({ editing: null })}
            title="Add a connection"
            className="flex h-5 w-5 items-center justify-center rounded text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
          >
            <Plus size={12} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto pb-2">
          {connections.length === 0 && !form && (
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
                onClick={() => void select(c.id, c.name)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <Database size={12} className="shrink-0 text-fg-subtle" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 truncate font-sans text-xs text-fg-base">
                    <span className="truncate">{c.name}</span>
                    {c.ssh && (
                      <span className="shrink-0 rounded bg-surface-2 px-1 font-sans text-[9px] text-fg-subtle" title={`via SSH ${c.ssh.user}@${c.ssh.host}`}>
                        SSH
                      </span>
                    )}
                    {c.safety === 'production' && (
                      <span className="shrink-0 rounded bg-status-err/15 px-1 font-sans text-[9px] text-status-err" title="Production: every write asks first">
                        PROD
                      </span>
                    )}
                    {c.safety === 'readonly' && (
                      <span className="shrink-0 rounded bg-surface-2 px-1 font-sans text-[9px] text-fg-subtle" title="Read-only">
                        RO
                      </span>
                    )}
                  </span>
                  <span className="block truncate font-mono text-2xs text-fg-subtle/70">
                    {c.url}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setForm({ editing: c })}
                title="Edit connection"
                className="shrink-0 text-fg-subtle opacity-0 transition hover:text-fg-base group-hover:opacity-100"
              >
                <Pencil size={11} />
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

          {/* Tables of the connected database, grouped by schema. */}
          {connected && tables.length > 0 && (
            <TableTree
              tables={tables}
              rowCounts={rowCounts}
              defaultSchema={defaultSchema(active)}
              activeTable={pane === 'schema' && schema ? schema.table : resultTable}
              onPreview={(t) => {
                setView('query');
                void previewTable(t);
              }}
              onExactCount={(t) => void exactCount(t)}
              onImport={readOnly ? undefined : (t) => void openImport(t)}
              onSchema={(t) => {
                setView('query');
                void showSchema(t);
              }}
              onCreateTable={readOnly ? undefined : () => openDesigner(null)}
            />
          )}
          {connected && tables.length === 0 && (
            <p className="px-3 py-2 font-sans text-xs text-fg-subtle">
              No tables.{' '}
              {!readOnly && (
                <button type="button" onClick={() => openDesigner(null)} className="text-fg-muted underline hover:text-fg-base">
                  Create one
                </button>
              )}
            </p>
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
          {connected && (
            <div
              role="tablist"
              aria-label="View"
              className="ml-2 flex shrink-0 rounded-md bg-surface-1 p-0.5 ring-1 ring-border-hairline"
            >
              {(['query', 'analytics'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => setView(v)}
                  className={cn(
                    'rounded px-2.5 py-0.5 font-sans text-xs transition-colors',
                    view === v ? 'bg-surface-3 text-fg-base' : 'text-fg-muted hover:text-fg-base',
                  )}
                >
                  {v === 'query' ? 'Query' : 'Analytics'}
                </button>
              ))}
            </div>
          )}
          {inTx && (
            <span className="flex shrink-0 items-center gap-1 rounded bg-status-warn/15 px-1.5 py-0.5 font-sans text-2xs text-status-warn">
              transaction open
              <button type="button" onClick={() => void finishTx(true)} className="ml-1 rounded px-1 text-fg-base hover:bg-status-warn/20">
                Commit
              </button>
              <button type="button" onClick={() => void finishTx(false)} className="rounded px-1 text-fg-base hover:bg-status-warn/20">
                Rollback
              </button>
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
                onClick={() => void refreshCatalog(activeId!).catch((e) => toastError(String(e)))}
                title="Refresh tables"
                className={cn(ICON_BTN, 'text-fg-muted')}
              >
                <RefreshCw size={12} />
              </button>
            )}
            {connected && tables.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setView('query');
                    setPane((p) => (p === 'diagram' ? 'grid' : 'diagram'));
                  }}
                  title="Schema diagram"
                  className={cn(ICON_BTN, pane === 'diagram' ? 'bg-surface-2 text-fg-base' : 'text-fg-muted')}
                >
                  <Network size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setView('query');
                    setPane((p) => (p === 'diff' ? 'grid' : 'diff'));
                  }}
                  title="Compare schema with another connection"
                  className={cn(ICON_BTN, pane === 'diff' ? 'bg-surface-2 text-fg-base' : 'text-fg-muted')}
                >
                  <GitCompareArrows size={12} />
                </button>
              </>
            )}
            {connected && (
              <>
                <button
                  type="button"
                  onClick={() => void backup()}
                  disabled={backingUp !== null}
                  title={active?.backend === 'sqlite' ? 'Back up: save a copy of the database file' : 'Back up: dump the database to a SQL file'}
                  className={cn(ICON_BTN, 'text-fg-muted disabled:opacity-40')}
                >
                  {backingUp === 'dump' ? <Loader2 size={12} className="animate-spin" /> : <HardDriveDownload size={12} />}
                </button>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => void restore()}
                    disabled={backingUp !== null}
                    title="Restore: run a SQL script or dump file against this database"
                    className={cn(ICON_BTN, 'text-fg-muted disabled:opacity-40')}
                  >
                    {backingUp === 'restore' ? <Loader2 size={12} className="animate-spin" /> : <HardDriveUpload size={12} />}
                  </button>
                )}
              </>
            )}
            {active && (
              <button
                type="button"
                onClick={() => setPanel((p) => (p ? null : 'history'))}
                title="History and saved queries"
                className={cn(ICON_BTN, panel ? 'bg-surface-2 text-fg-base' : 'text-fg-muted')}
              >
                <History size={12} />
              </button>
            )}
          </div>
        </div>

        {form && (
          <ConnectionForm
            editing={form.editing}
            onCancel={() => setForm(null)}
            onSaved={async (conn) => {
              const wasEditing = form.editing;
              setForm(null);
              await reloadConnections();
              if (!wasEditing) await select(conn.id, conn.name);
              else if (conn.id === activeId && connected) toast('Saved — reconnect to use the new settings');
            }}
          />
        )}

        {connected && safety === 'production' && (
          <div className="flex shrink-0 items-center gap-1.5 border-b border-status-err/30 bg-status-err/10 px-3 py-1 font-sans text-xs text-status-err">
            <ShieldAlert size={12} />
            Production database — every write asks for confirmation.
          </div>
        )}
        {connected && readOnly && (
          <div className="flex shrink-0 items-center gap-1.5 border-b border-border-hairline bg-surface-1 px-3 py-1 font-sans text-xs text-fg-muted">
            <Lock size={11} />
            Read-only — writes are refused here and by the server.
          </div>
        )}

        {error && (
          <div className="flex shrink-0 items-start gap-2 border-b border-border-hairline bg-status-err/10 px-3 py-1.5 font-sans text-xs text-status-err">
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{error}</span>
            {failedSql && aiContext && (
              <button
                type="button"
                onClick={() => setAiExplain((x) => ({ n: (x?.n ?? 0) + 1, sql: failedSql, problem: { error } }))}
                className="flex shrink-0 items-center gap-1 rounded px-1.5 text-fg-base hover:bg-status-err/15"
              >
                <Sparkles size={11} /> Explain with Claude
              </button>
            )}
            <button type="button" onClick={() => setError(null)} className="shrink-0 hover:opacity-70">
              <X size={12} />
            </button>
          </div>
        )}

        {aiExplain && aiContext && view === 'query' && (
          <ClaudeExplain
            key={aiExplain.n}
            sql={aiExplain.sql}
            problem={aiExplain.problem}
            ctx={aiContext}
            onUseFix={(text) => {
              setAiExplain(null);
              sendToEditor(text, 'Claude’s suggestion is in the editor — review it, then Run');
            }}
            onClose={() => setAiExplain(null)}
          />
        )}

        {view === 'analytics' && connected && active && activeId ? (
          <div className="min-h-0 flex-1">
            <DbAnalytics
              key={activeId}
              connId={activeId}
              backend={active.backend}
              safety={safety}
              onOpenSql={(text) => sendToEditor(text, 'Query from the analytics view is in the editor')}
            />
          </div>
        ) : (
          <>
          {/* Query tabs */}
          {connected && (
            <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border-hairline px-2 pt-1">
              {queryTabs.map((t) => {
                const isActive = t.id === activeTabId;
                const label = (isActive ? resultTable : t.resultTable) ?? t.name;
                return (
                  <div
                    key={t.id}
                    className={cn(
                      'group flex shrink-0 items-center gap-1 rounded-t-md border border-b-0 px-2.5 py-1 font-sans text-xs',
                      isActive
                        ? 'border-border-hairline bg-bg-base text-fg-base'
                        : 'border-transparent text-fg-muted hover:bg-surface-1 hover:text-fg-base',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => void switchTab(t.id)}
                      disabled={running}
                      className="max-w-[12rem] truncate disabled:cursor-not-allowed"
                      title={label}
                    >
                      {label}
                    </button>
                    {queryTabs.length > 1 && (
                      <button
                        type="button"
                        onClick={() => void closeTab(t.id)}
                        title="Close tab"
                        className="text-fg-subtle opacity-0 transition hover:text-fg-base group-hover:opacity-100"
                      >
                        <X size={10} />
                      </button>
                    )}
                  </div>
                );
              })}
              <button
                type="button"
                onClick={() => void newTab()}
                disabled={running}
                title="New query tab"
                className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted transition hover:bg-surface-2 hover:text-fg-base disabled:opacity-40"
              >
                <Plus size={11} />
              </button>
            </div>
          )}

          {askOpen && aiContext && connected && (
            <AskClaudeBar
              ctx={aiContext}
              onUse={(text) => {
                setAskOpen(false);
                sendToEditor(text, 'Claude’s query is in the editor — review it, then Run');
              }}
              onClose={() => setAskOpen(false)}
            />
          )}

          {/* SQL editor */}
          <div className="shrink-0 border-b border-border-hairline">
            <div className="h-32 min-h-[64px] resize-y overflow-hidden">
              <SqlEditor
                ref={editor}
                value={sql}
                onChange={setSql}
                onRun={(text) => void run(text)}
                backend={active?.backend ?? null}
                completion={completion}
                disabled={!connected}
                placeholder={connected ? 'SELECT …    (⌘/Ctrl + Enter runs the selection or everything)' : 'Connect first'}
              />
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-1.5 pt-1 [&>*]:shrink-0 [&>*]:whitespace-nowrap">
              {running ? (
                <button
                  type="button"
                  onClick={() => runningId && void dbCancel(runningId).catch((e) => toastError(String(e)))}
                  title="Ask the server to stop this statement"
                  className="flex items-center gap-1 rounded-lg bg-status-err/15 px-2.5 py-1 font-sans text-xs text-status-err ring-1 ring-status-err/40 transition-colors hover:bg-status-err/25"
                >
                  <Square size={10} />
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void run(editor.current?.selectionOrAll() ?? sql)}
                  disabled={!connected || !sql.trim()}
                  title="Run the selection, or everything (⌘/Ctrl + Enter)"
                  className="flex items-center gap-1 rounded-lg bg-accent-soft px-2.5 py-1 font-sans text-xs text-fg-base ring-1 ring-accent/45 transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Play size={11} />
                  Run
                </button>
              )}
              <button
                type="button"
                onClick={() => void explain(editor.current?.selectionOrAll() ?? sql)}
                disabled={!connected || running || !sql.trim()}
                title="Show the query plan"
                className="flex items-center gap-1 rounded-lg px-2.5 py-1 font-sans text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ListTree size={11} />
                Explain
              </button>
              <button
                type="button"
                onClick={() => setAskOpen((o) => !o)}
                disabled={!connected}
                title="Describe a query and let Claude write it"
                className={cn(
                  'flex items-center gap-1 rounded-lg px-2.5 py-1 font-sans text-xs transition-colors hover:bg-surface-2 hover:text-fg-base disabled:cursor-not-allowed disabled:opacity-40',
                  askOpen ? 'bg-surface-2 text-fg-base' : 'text-fg-muted',
                )}
              >
                <Sparkles size={11} />
                Ask Claude
              </button>
              {savingName === null ? (
                <button
                  type="button"
                  onClick={() => setSavingName('')}
                  disabled={!activeId || !sql.trim()}
                  title="Save this query on the connection"
                  className="flex items-center gap-1 rounded-lg px-2.5 py-1 font-sans text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Bookmark size={11} />
                  Save
                </button>
              ) : (
                <input
                  autoFocus
                  value={savingName}
                  onChange={(e) => setSavingName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveQuery(savingName);
                    if (e.key === 'Escape') setSavingName(null);
                  }}
                  onBlur={() => !savingName.trim() && setSavingName(null)}
                  placeholder="Name, then Enter"
                  className="w-40 rounded-md border border-accent/45 bg-bg-base px-2 py-0.5 font-sans text-xs text-fg-base focus:outline-none"
                />
              )}
              <label
                className="flex items-center gap-1 font-sans text-xs text-fg-subtle"
                title={
                  inTx
                    ? 'Commit or roll back the open transaction first'
                    : 'Off: statements run inside a transaction you commit or roll back yourself'
                }
              >
                <input
                  type="checkbox"
                  checked={autoCommit}
                  disabled={inTx || !connected}
                  onChange={(e) => setAutoCommit(e.target.checked)}
                  className="h-3 w-3 accent-accent"
                />
                Auto-commit
              </label>
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
              {result && pane === 'grid' && (
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
                    onClick={() => void dbJobCancel(exporting.id)}
                    className="rounded px-1.5 py-0.5 text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                result &&
                result.columns.length > 0 &&
                pane === 'grid' && (
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

          {/* Staged edits bar */}
          {pane === 'grid' && nEdits > 0 && (
            <div className="shrink-0 border-b border-border-hairline bg-status-warn/10">
              <div className="flex items-center gap-2 px-3 py-1 font-sans text-xs">
                <span className="text-status-warn">
                  {nEdits} pending change{nEdits === 1 ? '' : 's'} to {resultTable}
                </span>
                <button
                  type="button"
                  onClick={() => setShowEditSql((v) => !v)}
                  className="flex items-center gap-0.5 text-fg-muted hover:text-fg-base"
                >
                  <ChevronRight size={10} className={cn('transition-transform', showEditSql && 'rotate-90')} />
                  SQL
                </button>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => setEdits(emptyEdits())}
                  className="rounded px-2 py-0.5 text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
                >
                  Discard
                </button>
                <button
                  type="button"
                  onClick={() => void applyEdits()}
                  disabled={running}
                  className="rounded-md bg-accent-soft px-2.5 py-0.5 text-fg-base ring-1 ring-accent/45 transition-colors hover:bg-accent/20 disabled:opacity-40"
                >
                  Apply {autoCommit ? '' : '(in transaction)'}
                </button>
              </div>
              {showEditSql && (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all px-3 pb-2 font-mono text-2xs text-fg-base/80">
                  {statements.map((s) => `${s};`).join('\n')}
                </pre>
              )}
            </div>
          )}

          {/* ── Results area ── */}
          <div className="min-h-0 flex-1 overflow-hidden">
            {pane === 'diagram' && active ? (
              schemas ? (
                <SchemaDiagram
                  backend={active.backend}
                  schemas={schemas}
                  rowCounts={rowCounts}
                  onOpenTable={(t) => void previewTable(t)}
                  renderDetails={(t, s, onCloseDetails) => (
                    <SchemaView table={t} schema={s} onClose={onCloseDetails} />
                  )}
                  onClose={() => setPane('grid')}
                />
              ) : (
                <Waiting label="Loading schema…" />
              )
            ) : pane === 'diff' && active ? (
              schemas ? (
                <SchemaDiff
                  active={active}
                  schemas={schemas}
                  connections={connections}
                  onSendToEditor={(text) => {
                    setSql(text);
                    setPane('grid');
                    toast('Migration SQL loaded — review it, then Run');
                  }}
                  onClose={() => setPane('grid')}
                />
              ) : (
                <Waiting label="Loading schema…" />
              )
            ) : pane === 'schema' && schema ? (
              <div className="h-full overflow-auto">
                <SchemaView
                  table={schema.table}
                  schema={schema.data}
                  onClose={() => setPane('grid')}
                  actions={schemaActions(schema.table, schema.data)}
                />
              </div>
            ) : pane === 'design' && design && active && design.table && !schemas?.[design.table] ? (
              <Waiting label="Loading schema…" />
            ) : pane === 'design' && design && active ? (
              <TableDesigner
                key={design.table ?? '+new'}
                backend={active.backend}
                current={
                  design.table && schemas?.[design.table]
                    ? { table: design.table, schema: schemas[design.table]! }
                    : null
                }
                defaultSchema="public"
                onSendToEditor={(text) =>
                  sendToEditor(text, design.table ? 'ALTER statements are in the editor — review them, then Run' : 'CREATE TABLE is in the editor — review it, then Run')
                }
                onClose={() => {
                  setDesign(null);
                  setPane('grid');
                }}
              />
            ) : pane === 'plan' && plan ? (
              <div className="flex h-full flex-col">
                {aiContext && !aiExplain && (
                  <div className="flex shrink-0 justify-end border-b border-border-hairline px-3 py-1">
                    <button
                      type="button"
                      onClick={() =>
                        setAiExplain((x) => ({
                          n: (x?.n ?? 0) + 1,
                          sql: editor.current?.selectionOrAll() ?? sql,
                          problem: { plan: planText(plan.roots) },
                        }))
                      }
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 font-sans text-2xs text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
                    >
                      <Sparkles size={10} /> Explain this plan with Claude
                    </button>
                  </div>
                )}
                <div className="min-h-0 flex-1 overflow-auto">
                  <PlanView roots={plan.roots} analyze={plan.analyze} onClose={() => setPane('grid')} />
                </div>
              </div>
            ) : result && result.columns.length > 0 ? (
              <div className="flex h-full flex-col">
                {trail.length > 0 && (
                  <div className="flex shrink-0 items-center gap-2 border-b border-border-hairline px-3 py-1 font-sans text-2xs text-fg-subtle">
                    <button
                      type="button"
                      onClick={() => void goBack()}
                      disabled={running}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
                    >
                      <ArrowLeft size={10} /> Back to {trail.at(-1)!.table}
                    </button>
                    <span className="truncate">{[...trail.map((b) => b.table), resultTable].join(' → ')}</span>
                  </div>
                )}
                <div className="min-h-0 flex-1">
                  <ResultGrid
                    result={result}
                    editing={editable ? { edits, onChange: setEdits, pk } : undefined}
                    readOnlyReason={readOnlyReason}
                    browsing={browse ? { browse, hasNext, onChange: (b) => void changeBrowse(b) } : undefined}
                    links={browse ? links : undefined}
                    copyAs={{ backend: active?.backend ?? 'postgres', table: resultTable }}
                  />
                </div>
              </div>
            ) : (
              <div className="flex h-32 flex-col items-center justify-center gap-2 font-sans text-xs text-fg-subtle">
                {running ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : browse ? (
                  <>
                    {Object.values(browse.filters).some((f) => f.trim())
                      ? `No rows in ${browse.table} match these filters.`
                      : `${browse.table} has no rows${browse.page > 0 ? ' on this page' : ''}.`}
                    <span className="flex gap-2">
                      {Object.values(browse.filters).some((f) => f.trim()) && (
                        <button
                          type="button"
                          onClick={() => void changeBrowse({ ...browse, filters: {}, page: 0 })}
                          className="text-fg-muted underline hover:text-fg-base"
                        >
                          Clear filters
                        </button>
                      )}
                      {trail.length > 0 && (
                        <button type="button" onClick={() => void goBack()} className="text-fg-muted underline hover:text-fg-base">
                          Back to {trail.at(-1)!.table}
                        </button>
                      )}
                    </span>
                  </>
                ) : result ? (
                  'Statement ran — no rows returned.'
                ) : connected ? (
                  'Run a query, or pick a table on the left.'
                ) : (
                  'Not connected.'
                )}
              </div>
            )}
          </div>
          </>
        )}
      </div>

      {panel && activeId && (
        <QueryPanel
          tab={panel}
          onTab={setPanel}
          history={history}
          saved={saved}
          onLoad={(text) => setSql(text)}
          onDeleteHistory={async (h) => {
            try {
              await dbHistoryDelete(h.id);
              setHistory((list) => list.filter((x) => x.id !== h.id));
            } catch (e) {
              toastError(String(e));
            }
          }}
          onClearHistory={async () => {
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
          onDeleteSaved={async (q) => {
            try {
              await dbSavedDelete(q.id);
              setSaved((list) => list.filter((x) => x.id !== q.id));
            } catch (e) {
              toastError(String(e));
            }
          }}
          onRenameSaved={async (q, name) => {
            try {
              await dbSavedUpsert({ id: q.id, connection_id: q.connection_id, name, sql: q.sql });
              await reloadSaved();
            } catch (e) {
              toastError(String(e));
            }
          }}
          onOverwriteSaved={async (q) => {
            if (!sql.trim()) return;
            try {
              await dbSavedUpsert({ id: q.id, connection_id: q.connection_id, name: q.name, sql });
              await reloadSaved();
              toast(`Updated “${q.name}”`);
            } catch (e) {
              toastError(String(e));
            }
          }}
          onClose={() => setPanel(null)}
        />
      )}

      {paramPrompt && active && (
        <QueryParamsDialog
          names={paramPrompt.names}
          initial={paramValues.current}
          onClose={() => setParamPrompt(null)}
          onRun={(values) => {
            paramValues.current = { ...paramValues.current, ...values };
            setParamPrompt(null);
            void run(bindParams(paramPrompt.sql, active.backend, values), true);
          }}
        />
      )}

      {importTable && activeId && (
        <ImportTableDialog
          connId={activeId}
          table={importTable}
          schema={schemas?.[importTable] ?? null}
          inTransaction={inTx}
          beforeImport={ensureTransaction}
          onClose={() => setImportTable(null)}
          onDone={(rows) => {
            setImportTable(null);
            toast(`Imported ${rows.toLocaleString()} row${rows === 1 ? '' : 's'} into ${importTable}`);
            void refreshCatalog(activeId);
            if (resultTable === importTable) void previewTable(importTable);
          }}
        />
      )}
    </div>
  );
}

function Waiting({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 font-sans text-xs text-fg-subtle">
      <Loader2 size={13} className="animate-spin" />
      {label}
    </div>
  );
}

/** The import dialog, once the table's schema is at hand. */
function ImportTableDialog({
  connId,
  table,
  schema,
  inTransaction,
  beforeImport,
  onClose,
  onDone,
}: {
  connId: string;
  table: string;
  schema: DbTableSchema | null;
  inTransaction: boolean;
  beforeImport: () => Promise<void>;
  onClose: () => void;
  onDone: (rows: number) => void;
}) {
  const [loaded, setLoaded] = useState<DbTableSchema | null>(schema);
  useEffect(() => {
    if (!loaded) void dbTableSchema(connId, table).then(setLoaded, (e) => toastError(String(e)));
  }, [connId, table, loaded]);
  if (!loaded) return null;
  return (
    <ImportCsvDialog
      connId={connId}
      table={table}
      schema={loaded}
      inTransaction={inTransaction}
      beforeImport={beforeImport}
      onClose={onClose}
      onDone={onDone}
    />
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

// ─── Connection form ─────────────────────────────────────────────────────────

const INPUT =
  'rounded-lg border border-border-subtle bg-bg-base/60 px-2.5 py-1.5 font-sans text-xs text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:outline-none';

function ConnectionForm({
  editing,
  onCancel,
  onSaved,
}: {
  /** The connection being edited, or null to add one. */
  editing: DbConnection | null;
  onCancel: () => void;
  onSaved: (conn: DbConnection) => void | Promise<void>;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [url, setUrl] = useState(editing?.url ?? '');
  const [password, setPassword] = useState('');
  const [useSsh, setUseSsh] = useState(!!editing?.ssh);
  const [sshHost, setSshHost] = useState(editing?.ssh?.host ?? '');
  const [sshPort, setSshPort] = useState(String(editing?.ssh?.port ?? 22));
  const [sshUser, setSshUser] = useState(editing?.ssh?.user ?? '');
  const [sshKey, setSshKey] = useState(editing?.ssh?.key_path ?? '');
  const [sshPassphrase, setSshPassphrase] = useState('');
  const [safety, setSafety] = useState<DbSafety>(editing?.safety ?? 'normal');
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
    const port = Number(sshPort);
    if (useSsh && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      setError('SSH port must be 1-65535');
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
        id: editing?.id ?? null,
        name: name.trim() || split.url,
        backend: detected,
        url: split.url,
        // Editing with the field left blank keeps the stored password.
        has_password: secret.length > 0 || !!editing?.has_password,
        ssh: useSsh
          ? { host: sshHost.trim(), port, user: sshUser.trim(), key_path: sshKey.trim() }
          : null,
        safety,
      });
      if (secret) await dbPasswordSet(conn.id, secret);
      if (useSsh && sshPassphrase) await dbSshPassphraseSet(conn.id, sshPassphrase);
      if (!useSsh && editing?.ssh) await dbSshPassphraseSet(conn.id, '');
      await onSaved(conn);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Enter') void save();
    if (e.key === 'Escape') onCancel();
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
          className={cn(INPUT, 'w-40 shrink-0')}
        />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={keys}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          className={cn(INPUT, 'min-w-0 flex-1 font-mono')}
        />
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={keys}
          placeholder={
            editing?.has_password
              ? 'Password (leave blank to keep the saved one)'
              : 'Password (optional — or paste it in the URL)'
          }
          autoComplete="off"
          className={cn(INPUT, 'min-w-0 flex-1')}
        />
        <label className="flex shrink-0 items-center gap-1.5 font-sans text-xs text-fg-muted">
          <input
            type="checkbox"
            checked={useSsh}
            onChange={(e) => setUseSsh(e.target.checked)}
            disabled={backend === 'sqlite'}
            className="h-3 w-3 accent-accent"
          />
          SSH tunnel
        </label>
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
      {useSsh && backend !== 'sqlite' && (
        <div className="space-y-2 rounded-lg border border-border-subtle px-2.5 py-2">
          <div className="flex items-center gap-2">
            <input
              value={sshUser}
              onChange={(e) => setSshUser(e.target.value)}
              onKeyDown={keys}
              placeholder="SSH user"
              spellCheck={false}
              className={cn(INPUT, 'w-28 shrink-0')}
            />
            <span className="font-sans text-xs text-fg-subtle">@</span>
            <input
              value={sshHost}
              onChange={(e) => setSshHost(e.target.value)}
              onKeyDown={keys}
              placeholder="bastion.example.com"
              spellCheck={false}
              className={cn(INPUT, 'min-w-0 flex-1 font-mono')}
            />
            <span className="font-sans text-xs text-fg-subtle">:</span>
            <input
              value={sshPort}
              onChange={(e) => setSshPort(e.target.value)}
              onKeyDown={keys}
              inputMode="numeric"
              className={cn(INPUT, 'w-16 shrink-0 font-mono')}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              value={sshKey}
              onChange={(e) => setSshKey(e.target.value)}
              onKeyDown={keys}
              placeholder="Private key path (~/.ssh/id_ed25519)"
              spellCheck={false}
              className={cn(INPUT, 'min-w-0 flex-1 font-mono')}
            />
            <button
              type="button"
              onClick={() => void fsPickFiles().then(([f]) => f && setSshKey(f))}
              className="shrink-0 rounded-lg px-2.5 py-1.5 font-sans text-xs text-fg-muted ring-1 ring-edge-2 transition hover:bg-surface-2 hover:text-fg-base"
            >
              Browse…
            </button>
            <input
              type="password"
              value={sshPassphrase}
              onChange={(e) => setSshPassphrase(e.target.value)}
              onKeyDown={keys}
              placeholder={editing?.ssh ? 'Key passphrase (blank keeps it)' : 'Key passphrase (if any)'}
              autoComplete="off"
              className={cn(INPUT, 'w-48 shrink-0')}
            />
          </div>
          <p className="font-sans text-2xs leading-relaxed text-fg-subtle">
            The URL&apos;s host and port are as seen from the SSH server — often{' '}
            <span className="font-mono">localhost</span>. Public-key auth only; the host key is
            checked against <span className="font-mono">~/.ssh/known_hosts</span>. TLS modes that
            verify the hostname (<span className="font-mono">verify-full</span>) won&apos;t match
            through the tunnel.
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1" role="radiogroup" aria-label="Safety">
        <span className="font-sans text-xs text-fg-muted">Safety</span>
        {SAFETY_LEVELS.map((s) => (
          <label key={s.id} className="flex items-center gap-1.5 font-sans text-xs text-fg-muted" title={s.hint}>
            <input
              type="radio"
              name="db-safety"
              checked={safety === s.id}
              onChange={() => setSafety(s.id)}
              className="h-3 w-3 accent-accent"
            />
            {s.label}
          </label>
        ))}
        <span className="font-sans text-2xs text-fg-subtle">
          {SAFETY_LEVELS.find((s) => s.id === safety)!.hint}
        </span>
      </div>
      <p className="font-sans text-2xs leading-relaxed text-fg-subtle">
        Passwords and passphrases are stored in your OS credential vault, never in ARC&apos;s
        database — the saved URL keeps only <span className="font-mono">user@host</span>.
      </p>
      {error && <p className="font-sans text-xs text-status-err">{error}</p>}
    </div>
  );
}
