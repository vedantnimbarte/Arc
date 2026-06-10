import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Braces,
  FunctionSquare,
  Hash,
  List,
  RefreshCw,
  Shapes,
  Type as TypeIcon,
  type LucideIcon,
} from 'lucide-react';
import { pathToLanguageId } from '@arc/editor';
import { fsReadFile, isTauri } from '../lib/tauri';
import { useWorkspace } from '../state/workspace';
import { extractOutline, type OutlineKind, type OutlineSymbol } from '../lib/outline';
import { cn } from '../lib/cn';

const KIND_ICON: Record<OutlineKind, LucideIcon> = {
  function: FunctionSquare,
  method: FunctionSquare,
  class: Box,
  struct: Box,
  interface: Shapes,
  trait: Shapes,
  type: TypeIcon,
  enum: List,
  heading: Hash,
  section: Braces,
};

function basename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/**
 * Symbol outline for the active editor file. Reads from disk (line/regex
 * extraction in lib/outline.ts) rather than the live CodeMirror buffer, so it
 * reflects the last save; a refresh button re-reads on demand. Clicking a
 * symbol jumps the editor to its line.
 */
export function OutlineView() {
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const openFile = useWorkspace((s) => s.openFile);

  // Track the most recent *editor* file so focusing a terminal/SSH tab doesn't
  // blank the outline.
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const liveFile =
    activeTab?.kind === 'editor' && activeTab.filePath ? activeTab.filePath : null;
  const [filePath, setFilePath] = useState<string | null>(liveFile);
  useEffect(() => {
    if (liveFile) setFilePath(liveFile);
  }, [liveFile]);

  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const reqId = useRef(0);

  const load = useCallback(async (path: string | null) => {
    if (!path || !isTauri) {
      setText('');
      setError(null);
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const content = await fsReadFile(path);
      if (id === reqId.current) setText(content);
    } catch (e) {
      if (id === reqId.current) {
        setText('');
        setError(String(e));
      }
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(filePath);
  }, [filePath, load]);

  const symbols = useMemo<OutlineSymbol[]>(
    () => (filePath ? extractOutline(text, pathToLanguageId(filePath)) : []),
    [text, filePath],
  );

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return symbols;
    return symbols.filter((s) => s.name.toLowerCase().includes(q));
  }, [symbols, filter]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Header */}
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border-hairline px-2.5">
        <span
          className="min-w-0 flex-1 truncate font-display text-[12px] font-medium tracking-tight text-fg-base/90"
          title={filePath ?? ''}
        >
          {filePath ? basename(filePath) : 'Outline'}
        </span>
        {symbols.length > 0 && (
          <span className="shrink-0 rounded-full bg-white/[0.05] px-1.5 font-mono text-[9.5px] tabular-nums text-fg-muted">
            {symbols.length}
          </span>
        )}
        <button
          type="button"
          onClick={() => void load(filePath)}
          disabled={!filePath || loading}
          aria-label="Refresh outline"
          title="Refresh"
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-md text-fg-muted transition-all duration-150 ease-apple',
            'hover:bg-white/[0.08] hover:text-fg-base active:scale-[0.92]',
            'disabled:opacity-40 disabled:hover:bg-transparent',
          )}
        >
          <RefreshCw size={12} strokeWidth={2.1} className={loading ? 'animate-spin-slow' : ''} />
        </button>
      </div>

      {/* Filter */}
      {symbols.length > 0 && (
        <div className="shrink-0 border-b border-border-hairline px-2.5 py-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter symbols"
            className="selectable w-full rounded-md border border-white/[0.05] bg-black/[0.22] px-2 py-1 font-display text-[12px] tracking-tight text-fg-base placeholder:text-fg-subtle focus:border-accent/40 focus:shadow-focus focus:outline-none"
          />
        </div>
      )}

      {/* Symbols */}
      <div className="selectable flex-1 overflow-auto px-1.5 py-1.5">
        {!isTauri && (
          <p className="px-2 py-1.5 font-display text-[10.5px] leading-relaxed text-fg-subtle">
            <span className="text-status-warn">web preview</span> — outline needs the
            desktop app.
          </p>
        )}
        {isTauri && !filePath && (
          <p className="px-2 py-1.5 font-display text-[11px] leading-relaxed text-fg-subtle">
            Open a file to see its outline.
          </p>
        )}
        {error && (
          <p className="px-2 py-1.5 font-display text-[10.5px] leading-relaxed text-status-err/90">
            {error}
          </p>
        )}
        {filePath && !error && !loading && symbols.length === 0 && (
          <p className="px-2 py-1.5 font-display text-[11px] leading-relaxed text-fg-subtle">
            No symbols found in this file.
          </p>
        )}
        {visible.map((sym, i) => {
          const Icon = KIND_ICON[sym.kind];
          return (
            <button
              key={`${sym.line}-${sym.name}-${i}`}
              type="button"
              onClick={() => filePath && openFile(filePath, undefined, { line: sym.line })}
              className="group flex h-[26px] w-full items-center gap-1.5 rounded-md pr-2 font-display text-[12.5px] tracking-tight transition-colors duration-100 hover:bg-white/[0.045]"
              style={{ paddingLeft: 8 + Math.min(sym.depth, 6) * 12 }}
              title={`${sym.kind} · line ${sym.line}`}
            >
              <Icon size={12} strokeWidth={1.9} className="shrink-0 text-fg-subtle" />
              <span className="truncate text-fg-base/85 group-hover:text-fg-base">{sym.name}</span>
              <span className="ml-auto shrink-0 font-mono text-[9.5px] tabular-nums text-fg-subtle/70">
                {sym.line}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
