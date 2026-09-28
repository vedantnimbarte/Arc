import { useMemo, useState } from 'react';
import { Check, Pencil, Save, Trash2, X } from 'lucide-react';
import type { DbQueryHistoryEntry, DbSavedQuery } from '../../lib/tauri';
import { cn } from '../../lib/cn';

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

const ICON_BTN =
  'flex h-5 w-5 items-center justify-center rounded text-fg-muted transition hover:bg-surface-2 hover:text-fg-base';

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
    <div className="flex w-72 shrink-0 flex-col border-l border-border-hairline bg-bg-panel/40">
      <div className="flex items-center gap-1 px-2 py-1.5">
        {(['history', 'saved'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onTab(t)}
            className={cn(
              'rounded px-2 py-0.5 font-sans text-2xs uppercase tracking-widest transition',
              tab === t ? 'bg-surface-2 text-fg-base' : 'text-fg-subtle/70 hover:text-fg-base',
            )}
          >
            {t === 'history' ? 'History' : `Saved${saved.length ? ` · ${saved.length}` : ''}`}
          </button>
        ))}
        <span className="flex-1" />
        {tab === 'history' && history.length > 0 && (
          <button type="button" onClick={props.onClearHistory} title="Clear history" className={cn(ICON_BTN, 'hover:text-status-err')}>
            <Trash2 size={11} />
          </button>
        )}
        <button type="button" onClick={onClose} title="Close" className={ICON_BTN}>
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
        {tab === 'history' ? (
          <>
            {shownHistory.length === 0 && (
              <p className="px-3 py-2 font-sans text-xs text-fg-subtle">
                {history.length === 0 ? 'No queries run yet.' : 'No matches.'}
              </p>
            )}
            {shownHistory.map((h) => (
              <div key={h.id} className="group flex items-start gap-2 px-3 py-1.5 hover:bg-surface-1">
                <button
                  type="button"
                  onClick={() => props.onLoad(h.sql)}
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
                  onClick={() => props.onDeleteHistory(h)}
                  title="Delete"
                  className="mt-0.5 shrink-0 text-fg-subtle opacity-0 transition hover:text-status-err group-hover:opacity-100"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </>
        ) : (
          <>
            {shownSaved.length === 0 && (
              <p className="px-3 py-2 font-sans text-xs leading-relaxed text-fg-subtle">
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
    <div className="group flex items-start gap-1.5 px-3 py-1.5 hover:bg-surface-1">
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
            className="min-w-0 flex-1 rounded border border-accent/45 bg-bg-base px-1.5 py-0.5 font-sans text-xs text-fg-base focus:outline-none"
          />
          <Check size={11} className="shrink-0 text-fg-subtle" />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onLoad(query.sql)}
          title="Load into the editor"
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate font-sans text-xs text-fg-base">{query.name}</span>
          <span className="line-clamp-2 break-all font-mono text-2xs text-fg-subtle/80">{query.sql}</span>
        </button>
      )}
      {!renaming && (
        <span className="flex shrink-0 gap-0.5 opacity-0 transition group-hover:opacity-100">
          <button type="button" onClick={() => setRenaming(true)} title="Rename" className={ICON_BTN}>
            <Pencil size={10} />
          </button>
          <button
            type="button"
            onClick={() => onOverwriteSaved(query)}
            title="Replace with the editor's SQL"
            className={ICON_BTN}
          >
            <Save size={10} />
          </button>
          <button
            type="button"
            onClick={() => onDeleteSaved(query)}
            title="Delete"
            className={cn(ICON_BTN, 'hover:text-status-err')}
          >
            <Trash2 size={10} />
          </button>
        </span>
      )}
    </div>
  );
}
