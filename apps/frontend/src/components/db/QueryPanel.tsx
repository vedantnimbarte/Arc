import { useMemo, useState } from 'react';
import { Bookmark, Check, History, Pencil, Save, Search, Trash2, X } from 'lucide-react';
import type { DbQueryHistoryEntry, DbSavedQuery } from '../../lib/tauri';
import { cn } from '../../lib/cn';
import { ToolButton, ToolTab, ToolWindowHeader, inputCls } from './chrome';

export type QueryPanelTab = 'history' | 'saved';

interface Props {
  tab: QueryPanelTab;
  onTab: (tab: QueryPanelTab) => void;
  history: DbQueryHistoryEntry[];
  saved: DbSavedQuery[];
  onLoad: (sql: string) => void;
  onDeleteHistory: (h: DbQueryHistoryEntry) => void;
  onClearHistory: () => void;
  onDeleteSaved: (q: DbSavedQuery) => void;
  onRenameSaved: (q: DbSavedQuery, name: string) => void;
  /** Replace the saved query's SQL with what's in the editor now. */
  onOverwriteSaved: (q: DbSavedQuery) => void;
  onClose: () => void;
}

/** The connection's query history and saved queries. Click one to load it. */
export function QueryPanel(props: Props) {
  const { tab, onTab, history, saved, onClose } = props;
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shownHistory = useMemo(
    () => (q ? history.filter((h) => h.sql.toLowerCase().includes(q)) : history),
    [history, q],
  );
  const shownSaved = useMemo(
    () => (q ? saved.filter((s) => s.name.toLowerCase().includes(q) || s.sql.toLowerCase().includes(q)) : saved),
    [saved, q],
  );

  return (
    <div className="flex w-72 shrink-0 flex-col border-l border-edge-1 bg-bg-panel/40">
      <ToolWindowHeader
        actions={
          <>
            {tab === 'history' && history.length > 0 && (
              <ToolButton icon={Trash2} label="Clear history" onClick={props.onClearHistory} />
            )}
            <ToolButton icon={X} label="Close" onClick={onClose} />
          </>
        }
      >
        <ToolTab icon={History} active={tab === 'history'} onClick={() => onTab('history')} count={history.length || undefined}>
          History
        </ToolTab>
        <ToolTab icon={Bookmark} active={tab === 'saved'} onClick={() => onTab('saved')} count={saved.length || undefined}>
          Saved
        </ToolTab>
      </ToolWindowHeader>
      <div className="border-b border-edge-1 p-2">
        <label className="flex h-6 items-center gap-1.5 rounded bg-surface-1 px-2 ring-1 ring-inset ring-edge-1 focus-within:ring-accent/50">
          <Search size={11} className="shrink-0 text-fg-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search queries"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-fg-base placeholder:font-display placeholder:text-fg-subtle/70 focus:outline-none"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {tab === 'history' ? (
          <>
            {shownHistory.length === 0 && (
              <p className="px-3 py-3 font-display text-xs text-fg-subtle">
                {history.length === 0 ? 'No queries run yet.' : 'No matches.'}
              </p>
            )}
            {shownHistory.map((h) => (
              <div key={h.id} className="group relative flex items-start gap-1 border-b border-edge-1 px-3 py-1.5 hover:bg-surface-1">
                {h.error && <span aria-hidden className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-status-err" />}
                <button
                  type="button"
                  onClick={() => props.onLoad(h.sql)}
                  title={h.error ?? 'Load into the editor'}
                  className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:shadow-focus"
                >
                  <span className="line-clamp-2 break-all font-mono text-xs text-fg-base/85">{h.sql}</span>
                  <span className="mt-0.5 flex gap-2 font-mono text-2xs tabular-nums text-fg-subtle">
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
                <span className="shrink-0 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
                  <ToolButton icon={X} label="Delete" onClick={() => props.onDeleteHistory(h)} />
                </span>
              </div>
            ))}
          </>
        ) : (
          <>
            {shownSaved.length === 0 && (
              <p className="px-3 py-3 font-display text-xs leading-relaxed text-fg-subtle">
                {saved.length === 0
                  ? 'No saved queries. Use Save in the editor toolbar to keep one here.'
                  : 'No matches.'}
              </p>
            )}
            {shownSaved.map((s) => (
              <SavedRow key={s.id} query={s} {...props} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function SavedRow({
  query,
  onLoad,
  onDeleteSaved,
  onRenameSaved,
  onOverwriteSaved,
}: Props & { query: DbSavedQuery }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(query.name);
  const commit = () => {
    setRenaming(false);
    const n = name.trim();
    if (n && n !== query.name) onRenameSaved(query, n);
    else setName(query.name);
  };
  return (
    <div className="group flex items-start gap-1 border-b border-edge-1 px-3 py-1.5 hover:bg-surface-1">
      {renaming ? (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                setName(query.name);
                setRenaming(false);
              }
            }}
            onBlur={commit}
            aria-label="Saved query name"
            className={cn(inputCls, 'h-6 min-w-0 flex-1 font-display')}
          />
          <Check size={11} className="shrink-0 text-fg-subtle" />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onLoad(query.sql)}
          title="Load into the editor"
          className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:shadow-focus"
        >
          <span className="flex items-center gap-1.5">
            <Bookmark size={11} className="shrink-0 text-accent-bright" />
            <span className="truncate font-display text-xs font-medium text-fg-base">{query.name}</span>
          </span>
          <span className="mt-0.5 line-clamp-2 break-all font-mono text-2xs text-fg-subtle">{query.sql}</span>
        </button>
      )}
      {!renaming && (
        <span className="flex shrink-0 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
          <ToolButton icon={Pencil} label="Rename" onClick={() => setRenaming(true)} />
          <ToolButton icon={Save} label="Replace with the editor's SQL" onClick={() => onOverwriteSaved(query)} />
          <ToolButton icon={Trash2} label="Delete" onClick={() => onDeleteSaved(query)} />
        </span>
      )}
    </div>
  );
}
