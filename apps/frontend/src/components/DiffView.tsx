import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, RefreshCw, X } from 'lucide-react';
import { gitApply, gitDiff, type GitDiffScope } from '../lib/tauri';
import { cn } from '../lib/cn';

interface Props {
  filePath: string;
  diffRoot: string;
  diffScope: GitDiffScope;
}

// ─── Diff parser ─────────────────────────────────────────────────────────────

type CellType = 'context' | 'added' | 'removed' | 'empty';

interface SideCell {
  lineNum: number | null;
  content: string;
  type: CellType;
}

interface DiffRow {
  left: SideCell;
  right: SideCell;
}

interface DiffHunk {
  header: string;
  rows: DiffRow[];
  /** Minimal patch (file header + this hunk) for git apply. */
  rawPatch: string;
}

interface ParsedFileDiff {
  hunks: DiffHunk[];
}

function parseDiff(text: string): ParsedFileDiff[] {
  const result: ParsedFileDiff[] = [];
  const fileChunks = text.split(/(?=^diff --git )/m).filter((s) => s.trim());

  for (const chunk of fileChunks) {
    const lines = chunk.split('\n');

    // File header: everything before the first @@ line
    let hunkStart = lines.findIndex((l) => l.startsWith('@@'));
    if (hunkStart === -1) hunkStart = lines.length;
    const fileHeader = lines.slice(0, hunkStart).join('\n');

    // Split into individual hunks on @@ boundaries
    const hunkLines = lines.slice(hunkStart);
    const rawHunks: string[][] = [];
    let cur: string[] = [];
    for (const line of hunkLines) {
      if (line.startsWith('@@') && cur.length > 0) {
        rawHunks.push(cur);
        cur = [];
      }
      if (line !== '') cur.push(line);
    }
    if (cur.length > 0) rawHunks.push(cur);

    const hunks: DiffHunk[] = [];
    for (const raw of rawHunks) {
      const headerLine = raw[0] ?? '';
      const m = headerLine.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      if (!m) continue;

      let oldLine = parseInt(m[1] ?? '1', 10);
      let newLine = parseInt(m[2] ?? '1', 10);
      const hunkContext = (m[3] ?? '').trim();

      // Parse each diff line
      const parsed: Array<{ type: 'context' | 'added' | 'removed'; content: string; oldNum: number | null; newNum: number | null }> = [];
      for (const line of raw.slice(1)) {
        if (!line || line.startsWith('\\ ')) continue;
        const prefix = line[0] ?? '';
        const content = line.slice(1);
        if (prefix === ' ') {
          parsed.push({ type: 'context', content, oldNum: oldLine++, newNum: newLine++ });
        } else if (prefix === '-') {
          parsed.push({ type: 'removed', content, oldNum: oldLine++, newNum: null });
        } else if (prefix === '+') {
          parsed.push({ type: 'added', content, oldNum: null, newNum: newLine++ });
        }
      }

      const rows = alignRows(parsed);
      const rawPatch = fileHeader + '\n' + raw.join('\n') + '\n';
      hunks.push({ header: hunkContext, rows, rawPatch });
    }

    if (hunks.length > 0) result.push({ hunks });
  }

  return result;
}

type ParsedLine = { type: 'context' | 'added' | 'removed'; content: string; oldNum: number | null; newNum: number | null };

function alignRows(lines: ParsedLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line) break;

    if (line.type === 'context') {
      rows.push({
        left: { lineNum: line.oldNum, content: line.content, type: 'context' },
        right: { lineNum: line.newNum, content: line.content, type: 'context' },
      });
      i++;
      continue;
    }

    // Collect a contiguous block of removed then added lines
    const removed: ParsedLine[] = [];
    while (i < lines.length && lines[i]?.type === 'removed') {
      const l = lines[i++];
      if (l) removed.push(l);
    }
    const added: ParsedLine[] = [];
    while (i < lines.length && lines[i]?.type === 'added') {
      const l = lines[i++];
      if (l) added.push(l);
    }

    const len = Math.max(removed.length, added.length);
    for (let j = 0; j < len; j++) {
      const r = removed[j];
      const a = added[j];
      rows.push({
        left: r
          ? { lineNum: r.oldNum, content: r.content, type: 'removed' }
          : { lineNum: null, content: '', type: 'empty' },
        right: a
          ? { lineNum: a.newNum, content: a.content, type: 'added' }
          : { lineNum: null, content: '', type: 'empty' },
      });
    }
  }

  return rows;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function DiffView({ filePath, diffRoot, diffScope }: Props) {
  const [diffText, setDiffText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  // Make path relative for display and for git diff path filter
  const relativePath = (() => {
    const norm = filePath.replace(/\\/g, '/');
    const root = diffRoot.replace(/\\/g, '/').replace(/\/$/, '');
    return norm.startsWith(root + '/') ? norm.slice(root.length + 1) : norm;
  })();

  const fileName = relativePath.split('/').pop() ?? relativePath;

  // Token so a slow gitDiff for a previous file/scope can't overwrite the
  // diff of the one the user switched to (or write into an unmounted view).
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const text = await gitDiff(diffRoot, diffScope, relativePath);
      if (seq !== loadSeq.current) return;
      setDiffText(text);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(String(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [diffRoot, diffScope, relativePath]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyHunk = useCallback(
    async (patch: string, cached: boolean, reverse: boolean) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await gitApply(diffRoot, patch, cached, reverse);
        const label = cached && !reverse ? 'Staged' : !cached && reverse ? 'Discarded' : 'Unstaged';
        setFlash(label);
        setTimeout(() => setFlash(null), 1800);
        await load();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, diffRoot, load],
  );

  const parsed = diffText != null ? parseDiff(diffText) : [];

  const scopeLabel =
    diffScope === 'staged'
      ? 'Staged'
      : diffScope === 'worktree'
        ? 'Working Tree'
        : 'HEAD';

  const colHeaders =
    diffScope === 'staged'
      ? ['HEAD', 'Staged']
      : diffScope === 'worktree'
        ? ['Index', 'Working Tree']
        : ['Parent', 'HEAD'];

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg-base text-[12px]">
      {/* ── File header ── */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-hairline px-3 py-1.5">
        <span className="truncate font-mono text-[12px] text-fg-base">{fileName}</span>
        {fileName !== relativePath && (
          <span className="truncate text-[11px] text-fg-subtle/70">{relativePath.slice(0, relativePath.lastIndexOf('/'))}</span>
        )}
        <span className="ml-1 shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-sans text-fg-subtle">
          {scopeLabel}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {flash && (
            <span className="flex items-center gap-1 font-sans text-[11px] text-accent">
              <Check size={11} strokeWidth={2.5} />
              {flash}
            </span>
          )}
          <button
            onClick={() => void load()}
            disabled={loading || busy}
            title="Refresh diff"
            className="flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-all hover:bg-white/[0.08] hover:text-fg-base disabled:opacity-40"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin-slow' : ''} />
          </button>
        </div>
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border-hairline bg-red-900/20 px-3 py-1.5 font-sans text-[11px] text-red-400">
          <span className="flex-1 truncate">{error}</span>
          <button onClick={() => setError(null)} className="shrink-0 hover:text-red-300">
            <X size={12} />
          </button>
        </div>
      )}

      {/* ── Body ── */}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex h-32 items-center justify-center text-fg-subtle">
            <RefreshCw size={14} className="animate-spin-slow" />
          </div>
        )}

        {!loading && parsed.length === 0 && !error && (
          <div className="flex h-32 items-center justify-center font-sans text-[11px] text-fg-subtle">
            No changes
          </div>
        )}

        {!loading && parsed.length > 0 && (
          <>
            {/* Column headers */}
            <div className="flex border-b border-border-hairline bg-white/[0.02]">
              <div className="w-1/2 border-r border-border-hairline px-3 py-1 font-sans text-[10px] uppercase tracking-widest text-fg-subtle/60">
                {colHeaders[0]}
              </div>
              <div className="w-1/2 px-3 py-1 font-sans text-[10px] uppercase tracking-widest text-fg-subtle/60">
                {colHeaders[1]}
              </div>
            </div>

            {parsed.map((file, fi) =>
              file.hunks.map((hunk, hi) => (
                <HunkBlock
                  key={`${fi}-${hi}`}
                  hunk={hunk}
                  scope={diffScope}
                  busy={busy}
                  onApply={applyHunk}
                />
              )),
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── HunkBlock ───────────────────────────────────────────────────────────────

interface HunkBlockProps {
  hunk: DiffHunk;
  scope: GitDiffScope;
  busy: boolean;
  onApply: (patch: string, cached: boolean, reverse: boolean) => void;
}

function HunkBlock({ hunk, scope, busy, onApply }: HunkBlockProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="border-b border-border-hairline last:border-0">
      {/* Hunk separator / action bar */}
      <div className="flex items-center gap-1.5 bg-[#1e1e2a] px-2 py-1">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center text-fg-subtle hover:text-fg-base"
        >
          {collapsed ? <ChevronRight size={11} strokeWidth={2} /> : <ChevronDown size={11} strokeWidth={2} />}
        </button>
        <span className="flex-1 truncate font-mono text-[11px] text-fg-subtle/70">
          {hunk.header || '…'}
        </span>

        {/* Per-scope action buttons */}
        {scope === 'worktree' && (
          <>
            <button
              type="button"
              onClick={() => onApply(hunk.rawPatch, true, false)}
              disabled={busy}
              title="Stage this hunk"
              className="rounded px-2 py-0.5 font-sans text-[10px] text-accent transition hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Stage
            </button>
            <button
              type="button"
              onClick={() => onApply(hunk.rawPatch, false, true)}
              disabled={busy}
              title="Discard this hunk"
              className="rounded px-2 py-0.5 font-sans text-[10px] text-fg-muted transition hover:bg-white/[0.07] hover:text-fg-base disabled:cursor-not-allowed disabled:opacity-40"
            >
              Discard
            </button>
          </>
        )}
        {scope === 'staged' && (
          <button
            type="button"
            onClick={() => onApply(hunk.rawPatch, true, true)}
            disabled={busy}
            title="Unstage this hunk"
            className="rounded px-2 py-0.5 font-sans text-[10px] text-fg-muted transition hover:bg-white/[0.07] hover:text-fg-base disabled:cursor-not-allowed disabled:opacity-40"
          >
            Unstage
          </button>
        )}
      </div>

      {/* Side-by-side rows */}
      {!collapsed && (
        <div className="flex">
          <div className="w-1/2 border-r border-border-hairline">
            {hunk.rows.map((row, ri) => (
              <LineCell key={ri} cell={row.left} />
            ))}
          </div>
          <div className="w-1/2">
            {hunk.rows.map((row, ri) => (
              <LineCell key={ri} cell={row.right} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── LineCell ─────────────────────────────────────────────────────────────────

function LineCell({ cell }: { cell: SideCell }) {
  const rowBg =
    cell.type === 'removed'
      ? 'bg-red-500/[0.12]'
      : cell.type === 'added'
        ? 'bg-green-500/[0.12]'
        : cell.type === 'empty'
          ? 'bg-white/[0.015]'
          : '';

  const numColor =
    cell.type === 'removed'
      ? 'text-red-400/60'
      : cell.type === 'added'
        ? 'text-green-400/60'
        : 'text-fg-subtle/40';

  const textColor =
    cell.type === 'removed'
      ? 'text-red-200/90'
      : cell.type === 'added'
        ? 'text-green-200/90'
        : 'text-fg-base/85';

  const marker =
    cell.type === 'removed' ? '-' : cell.type === 'added' ? '+' : ' ';

  return (
    <div className={cn('flex min-h-[19px] items-start', rowBg)}>
      {/* Line number */}
      <span
        className={cn(
          'w-9 shrink-0 select-none pr-2 text-right font-mono text-[11px] leading-[19px]',
          numColor,
        )}
      >
        {cell.lineNum ?? ''}
      </span>
      {/* +/- marker */}
      <span
        className={cn(
          'w-3 shrink-0 select-none text-center font-mono text-[11px] leading-[19px]',
          cell.type === 'removed'
            ? 'text-red-400/80'
            : cell.type === 'added'
              ? 'text-green-400/80'
              : 'text-transparent',
        )}
      >
        {marker}
      </span>
      {/* Content */}
      <span
        className={cn(
          'flex-1 whitespace-pre-wrap break-all font-mono text-[12px] leading-[19px]',
          textColor,
          cell.type === 'empty' && 'invisible',
        )}
      >
        {cell.content || ' '}
      </span>
    </div>
  );
}
