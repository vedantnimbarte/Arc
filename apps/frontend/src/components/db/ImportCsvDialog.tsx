import { useEffect, useMemo, useState } from 'react';
import { FileUp, Loader2, X } from 'lucide-react';
import {
  dbCsvPreview,
  dbImportCsv,
  dbJobCancel,
  fsPickFiles,
  type DbCsvPreview,
  type DbTableSchema,
} from '../../lib/tauri';
import { cn } from '../../lib/cn';
import { ObjIcon, ToolButton, primaryBtn, textBtn } from './chrome';

interface Props {
  connId: string;
  table: string;
  schema: DbTableSchema;
  /** A manual transaction is open: the rows join it instead of committing. */
  inTransaction: boolean;
  /** Runs first — opens the manual transaction when auto-commit is off. */
  beforeImport: () => Promise<void>;
  onClose: () => void;
  onDone: (rows: number) => void;
}

const SKIP = -1;

/**
 * Load a CSV file into one table: pick the file, map its fields onto the
 * table's columns (matched by header name to start with), check a preview,
 * then import all-or-nothing with progress and cancel.
 */
export function ImportCsvDialog({ connId, table, schema, inTransaction, beforeImport, onClose, onDone }: Props) {
  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<DbCsvPreview | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  /** Table column → CSV field index (or SKIP). */
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<{ id: string; rows: number } | null>(null);

  const header = preview?.rows[0] ?? [];
  const width = Math.max(0, ...(preview?.rows.map((r) => r.length) ?? [0]));
  const fieldLabel = (i: number) =>
    hasHeader && header[i] ? `${header[i]}` : `Field ${i + 1}`;

  // Re-match by name whenever the file or the header setting changes.
  useEffect(() => {
    if (!preview) return;
    const byName = new Map<string, number>();
    if (hasHeader) header.forEach((h, i) => h && byName.set(h.trim().toLowerCase(), i));
    const next: Record<string, number> = {};
    schema.columns.forEach((c, ci) => {
      next[c.name] = hasHeader ? (byName.get(c.name.toLowerCase()) ?? SKIP) : ci < width ? ci : SKIP;
    });
    setMapping(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, hasHeader, schema]);

  const pick = async () => {
    setError(null);
    try {
      const [file] = await fsPickFiles();
      if (!file) return;
      setPath(file);
      setPreview(await dbCsvPreview(file, 8));
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    void pick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mapped = useMemo(
    () => schema.columns.filter((c) => (mapping[c.name] ?? SKIP) !== SKIP),
    [schema, mapping],
  );
  const dataRows = preview ? preview.rows.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + 5) : [];
  const total = preview ? preview.total_rows - (hasHeader ? 1 : 0) : 0;

  const run = async () => {
    if (!path || mapped.length === 0 || job) return;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setJob({ id, rows: 0 });
    setError(null);
    try {
      await beforeImport();
      const rows = await dbImportCsv(
        connId,
        path,
        {
          table,
          columns: mapped.map((c) => c.name),
          sources: mapped.map((c) => mapping[c.name]!),
          has_header: hasHeader,
        },
        id,
        (n) => setJob((j) => (j ? { ...j, rows: n } : j)),
      );
      onDone(rows);
    } catch (e) {
      setError(String(e));
    } finally {
      setJob(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-scrim-2 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && !job && onClose()}
    >
      <div
        className="material-sheet mt-[10vh] flex max-h-[80vh] w-[640px] max-w-[94vw] animate-sheet-in flex-col overflow-hidden rounded-window shadow-sheet ring-1 ring-edge-2"
        onKeyDown={(e) => e.key === 'Escape' && !job && onClose()}
      >
        <div className="flex h-9 items-center gap-2 border-b border-edge-1 bg-surface-1 px-3">
          <FileUp size={13} className="text-accent-bright" />
          <span className="flex min-w-0 items-center gap-1.5 font-display text-xs font-semibold text-fg-base">
            Import CSV into <ObjIcon kind="table" /> <span className="truncate font-mono">{table}</span>
          </span>
          <span className="ml-auto">
            <ToolButton icon={X} label="Close" onClick={onClose} disabled={!!job} />
          </span>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void pick()}
              disabled={!!job}
              className={cn(textBtn, 'ring-1 ring-inset ring-edge-2')}
            >
              {path ? 'Choose another file…' : 'Choose CSV file…'}
            </button>
            <span className="truncate font-mono text-2xs text-fg-subtle" title={path ?? ''}>
              {path ?? 'No file chosen'}
            </span>
          </div>

          {preview && (
            <>
              <div className="flex items-center gap-3 font-display text-xs text-fg-muted">
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={hasHeader}
                    onChange={(e) => setHasHeader(e.target.checked)}
                    className="h-3 w-3 accent-accent"
                  />
                  First row is a header
                </label>
                <span className="text-fg-subtle">
                  {total.toLocaleString()} row{total === 1 ? '' : 's'} · empty unquoted fields load as NULL
                </span>
              </div>

              <div>
                <div className="pb-1.5 font-display text-2xs font-semibold text-fg-muted">Map columns</div>
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1">
                  {schema.columns.map((c) => (
                    <label key={c.name} className="contents">
                      <span className="flex items-center gap-1.5 truncate font-mono text-xs text-fg-base/85">
                        <ObjIcon kind={c.primary_key ? 'pk' : 'column'} size={11} />
                        {c.name}
                        <span className="text-2xs text-fg-subtle/70">{c.data_type}</span>
                      </span>
                      <select
                        value={mapping[c.name] ?? SKIP}
                        onChange={(e) => setMapping((m) => ({ ...m, [c.name]: Number(e.target.value) }))}
                        disabled={!!job}
                        className="h-6 rounded bg-surface-1 px-1.5 font-mono text-xs text-fg-base ring-1 ring-inset ring-edge-2 focus:outline-none focus:ring-accent/60"
                      >
                        <option value={SKIP}>— skip (default) —</option>
                        {Array.from({ length: width }, (_, i) => (
                          <option key={i} value={i}>
                            {fieldLabel(i)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </div>

              {mapped.length > 0 && dataRows.length > 0 && (
                <div>
                  <div className="pb-1.5 font-display text-2xs font-semibold text-fg-muted">Preview</div>
                  <div className="overflow-auto rounded ring-1 ring-edge-1">
                    <table className="w-max min-w-full border-collapse text-left">
                      <thead className="bg-bg-chrome">
                        <tr>
                          {mapped.map((c) => (
                            <th key={c.name} className="whitespace-nowrap border-b border-r border-edge-1 px-2 py-0.5 font-mono text-2xs font-semibold text-fg-base">
                              {c.name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {dataRows.map((r, ri) => (
                          <tr key={ri}>
                            {mapped.map((c) => {
                              const v = r[mapping[c.name]!] ?? null;
                              return (
                                <td key={c.name} className="h-6 max-w-[12rem] truncate border-b border-r border-edge-1 px-2 font-mono text-2xs text-fg-base/85">
                                  {v === null ? <span className="italic text-fg-subtle/60">&lt;null&gt;</span> : v}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
          {inTransaction && (
            <p className="font-display text-xs text-status-warn">
              A transaction is open: the rows join it and are only kept when you commit.
            </p>
          )}
          {error && <p className="whitespace-pre-wrap break-words font-mono text-xs text-status-err">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-1.5 border-t border-edge-1 bg-surface-1 px-3 py-2">
          {job ? (
            <>
              <span className="mr-auto flex items-center gap-1.5 font-display text-xs tabular-nums text-fg-subtle">
                <Loader2 size={11} className="animate-spin" />
                Imported {job.rows.toLocaleString()} of {total.toLocaleString()}…
              </span>
              <button
                type="button"
                onClick={() => void dbJobCancel(job.id)}
                className={textBtn}
              >
                Cancel import
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={onClose} className={textBtn}>
                Close
              </button>
              <button
                type="button"
                onClick={() => void run()}
                disabled={!path || mapped.length === 0}
                className={primaryBtn}
              >
                Import {total > 0 ? `${total.toLocaleString()} rows` : ''}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
