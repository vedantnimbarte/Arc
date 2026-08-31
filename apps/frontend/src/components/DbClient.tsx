import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Database,
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
  dbPasswordSet,
  dbPreview,
  dbQuery,
  dbTables,
  isTauri,
  type DbBackend,
  type DbConnection,
  type DbQueryResult,
} from '../lib/tauri';
import { useWorkspace } from '../state/workspace';
import { askConfirm } from '../state/confirm';
import { toastError } from '../state/toast';
import { cn } from '../lib/cn';

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
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

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

  // Queries are serialized by `running`, so a slow one can't have its results
  // overwritten by a fast one started after it.
  const run = useCallback(
    async (text: string) => {
      if (!activeId || !connected || running) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      setRunning(true);
      setError(null);
      try {
        setResult(await dbQuery(activeId, trimmed));
      } catch (e) {
        setResult(null);
        setError(String(e));
      } finally {
        setRunning(false);
      }
    },
    [activeId, connected, running],
  );

  const previewTable = useCallback(
    async (table: string) => {
      if (!activeId || running) return;
      setRunning(true);
      setError(null);
      // Show the query we ran, so the next edit starts from something real.
      setSql(`SELECT * FROM ${table} LIMIT 200`);
      try {
        setResult(await dbPreview(activeId, table, 200));
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
                <button
                  key={t}
                  type="button"
                  onClick={() => void previewTable(t)}
                  className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-surface-1"
                >
                  <Table2 size={11} className="shrink-0 text-fg-subtle" />
                  <span className="truncate font-mono text-xs text-fg-base/85">{t}</span>
                </button>
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
            {result && (
              <span className="font-sans text-xs text-fg-subtle">
                {result.columns.length > 0
                  ? `${result.rows.length} row${result.rows.length === 1 ? '' : 's'}`
                  : `${result.rows_affected} row${result.rows_affected === 1 ? '' : 's'} affected`}
                {' · '}
                {result.duration_ms} ms
                {result.truncated && ' · truncated'}
              </span>
            )}
          </div>
        </div>

        {/* ── Results grid ── */}
        <div className="min-h-0 flex-1 overflow-auto">
          {result && result.columns.length > 0 ? (
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
