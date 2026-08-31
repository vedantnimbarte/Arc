import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Pencil,
  RefreshCw,
  X,
} from 'lucide-react';
import { fsReadFile, fsWriteFile, gitStage } from '../lib/tauri';
import { useGit } from '../state/git';
import { toast, toastError } from '../state/toast';
import {
  applyChoices,
  conflictCount,
  detectEol,
  parseConflicts,
  resolveSegment,
  type Choice,
  type ConflictSegment,
  type Segment,
} from '../lib/mergeConflict';
import { cn } from '../lib/cn';

interface Props {
  /** Absolute path of the conflicted file. */
  filePath: string;
  /** Repository root — needed to stage the file once it's resolved. */
  mergeRoot: string;
}

/** Context runs longer than this collapse to a summary row. A merge is about
 *  the conflicts; the 400 unchanged lines between two of them are noise. */
const CONTEXT_PEEK = 6;

/**
 * Three-way merge view for one conflicted file.
 *
 * Source Control's `--ours` / `--theirs` resolve an entire file one way,
 * which is only ever right when a single side touched it. This resolves a
 * conflict at a time: take one side, take both, or hand-edit the result.
 *
 * Nothing is written until Save. The file on disk keeps its conflict markers
 * throughout, so closing the tab mid-merge loses a few clicks and nothing
 * else.
 */
export function MergeView({ filePath, mergeRoot }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<Record<number, Choice | undefined>>({});
  const refreshGit = useGit((s) => s.refresh);

  const relativePath = useMemo(() => {
    const norm = filePath.replace(/\\/g, '/');
    const root = mergeRoot.replace(/\\/g, '/').replace(/\/$/, '');
    return norm.startsWith(`${root}/`) ? norm.slice(root.length + 1) : norm;
  }, [filePath, mergeRoot]);

  // Guard against a slow read for a previous file landing after a newer one.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const raw = await fsReadFile(filePath);
      if (seq !== loadSeq.current) return;
      setText(raw);
      // Re-reading means the file changed underneath us; prior choices point
      // at conflict indices that may no longer mean the same thing.
      setChoices({});
    } catch (e) {
      if (seq === loadSeq.current) setError(String(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [filePath]);

  useEffect(() => {
    void load();
  }, [load]);

  const segments = useMemo<Segment[]>(
    () => (text == null ? [] : parseConflicts(text)),
    [text],
  );
  const total = conflictCount(segments);
  const resolved = Object.values(choices).filter(Boolean).length;
  const allResolved = total > 0 && resolved === total;

  const choose = useCallback((index: number, choice: Choice) => {
    setChoices((prev) => ({ ...prev, [index]: choice }));
  }, []);

  const clear = useCallback((index: number) => {
    setChoices((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    if (text == null || busy || !allResolved) return;
    setBusy(true);
    setError(null);
    try {
      await fsWriteFile(filePath, applyChoices(segments, choices, detectEol(text)));
      // Staging is what actually tells git the conflict is settled — a
      // marker-free file that's still unmerged blocks the commit either way.
      await gitStage(mergeRoot, [relativePath]);
      toast(`Resolved ${relativePath}`);
      void refreshGit(mergeRoot, { background: true });
      await load();
    } catch (e) {
      const msg = String(e);
      setError(msg);
      toastError(`Could not resolve: ${msg}`);
    } finally {
      setBusy(false);
    }
  }, [
    allResolved,
    busy,
    choices,
    filePath,
    load,
    mergeRoot,
    refreshGit,
    relativePath,
    segments,
    text,
  ]);

  const fileName = relativePath.split('/').pop() ?? relativePath;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg-base text-sm">
      {/* ── Header ── */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-hairline px-3 py-1.5">
        <span className="truncate font-mono text-sm text-fg-base">{fileName}</span>
        <span className="ml-1 shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-sans text-2xs text-fg-subtle">
          Merge
        </span>
        {total > 0 && (
          <span
            className={cn(
              'shrink-0 font-sans text-xs',
              allResolved ? 'text-status-ok' : 'text-fg-muted',
            )}
          >
            {resolved} of {total} resolved
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void save()}
            disabled={!allResolved || busy}
            title={
              allResolved
                ? 'Write the merged file and stage it'
                : 'Resolve every conflict first'
            }
            className="flex items-center gap-1 rounded-lg bg-accent-soft px-2.5 py-1 font-sans text-xs text-fg-base ring-1 ring-accent/45 transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Check size={11} strokeWidth={2.5} />
            Save &amp; stage
          </button>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading || busy}
            title="Re-read the file from disk"
            className="flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-all hover:bg-surface-2 hover:text-fg-base disabled:opacity-40"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin-slow' : ''} />
          </button>
        </div>
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border-hairline bg-status-err/10 px-3 py-1.5 font-sans text-xs text-status-err">
          <span className="flex-1 truncate">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="shrink-0 hover:opacity-70"
          >
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

        {!loading && text != null && total === 0 && (
          <div className="flex h-32 flex-col items-center justify-center gap-1 font-sans text-xs text-fg-subtle">
            <span>No conflict markers in this file.</span>
            <span className="text-fg-subtle/70">
              It may already be resolved — stage it from Source Control.
            </span>
          </div>
        )}

        {!loading &&
          segments.map((seg, i) =>
            seg.kind === 'context' ? (
              <ContextBlock key={`c${i}`} lines={seg.lines} />
            ) : (
              <ConflictBlock
                key={`x${seg.index}`}
                seg={seg}
                choice={choices[seg.index]}
                onChoose={(c) => choose(seg.index, c)}
                onClear={() => clear(seg.index)}
              />
            ),
          )}
      </div>
    </div>
  );
}

// ─── Context ─────────────────────────────────────────────────────────────────

function ContextBlock({ lines }: { lines: string[] }) {
  const collapsible = lines.length > CONTEXT_PEEK * 2 + 1;
  const [expanded, setExpanded] = useState(!collapsible);

  if (!collapsible || expanded) {
    return (
      <div>
        {collapsible && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="flex w-full items-center gap-1.5 bg-surface-1 px-2 py-0.5 font-sans text-2xs text-fg-subtle hover:text-fg-base"
          >
            <ChevronDown size={10} strokeWidth={2} />
            collapse {lines.length} unchanged lines
          </button>
        )}
        {lines.map((l, i) => (
          <Line key={i} text={l} />
        ))}
      </div>
    );
  }

  const hidden = lines.length - CONTEXT_PEEK * 2;
  return (
    <div>
      {lines.slice(0, CONTEXT_PEEK).map((l, i) => (
        <Line key={`h${i}`} text={l} />
      ))}
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="flex w-full items-center gap-1.5 bg-surface-1 px-2 py-0.5 font-sans text-2xs text-fg-subtle hover:text-fg-base"
      >
        <ChevronRight size={10} strokeWidth={2} />
        {hidden} unchanged lines
      </button>
      {lines.slice(-CONTEXT_PEEK).map((l, i) => (
        <Line key={`t${i}`} text={l} />
      ))}
    </div>
  );
}

/** The two sides are told apart by a background wash, not by ink colour — a
 *  fixed light-on-dark text colour would disappear on the light themes. */
function Line({ text, tone }: { text: string; tone?: 'ours' | 'theirs' }) {
  return (
    <div
      className={cn(
        'min-h-[19px] whitespace-pre-wrap break-all px-3 font-mono text-sm leading-[19px] text-fg-base/85',
        tone === 'ours' && 'bg-sky-500/[0.12]',
        tone === 'theirs' && 'bg-amber-500/[0.12]',
      )}
    >
      {text || ' '}
    </div>
  );
}

// ─── Conflict ────────────────────────────────────────────────────────────────

interface ConflictProps {
  seg: ConflictSegment;
  choice: Choice | undefined;
  onChoose: (choice: Choice) => void;
  onClear: () => void;
}

function ConflictBlock({ seg, choice, onChoose, onClear }: ConflictProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const startEditing = () => {
    // Seed the editor with whatever the current pick produces, so "edit" is a
    // refinement of a choice rather than a blank page.
    const base = choice ? resolveSegment(seg, choice) : [...seg.ours, ...seg.theirs];
    setDraft(base.join('\n'));
    setEditing(true);
  };

  const commitEdit = () => {
    onChoose({ kind: 'custom', lines: draft.split('\n') });
    setEditing(false);
  };

  return (
    <div className="border-y border-border-hairline">
      {/* Action bar */}
      <div className="flex items-center gap-1.5 bg-surface-2 px-2 py-1">
        {choice ? (
          <Check size={11} strokeWidth={2.5} className="shrink-0 text-status-ok" />
        ) : (
          <AlertTriangle size={11} strokeWidth={2} className="shrink-0 text-status-warn" />
        )}
        <span className="flex-1 truncate font-mono text-xs text-fg-subtle/70">
          conflict {seg.index + 1}
          {choice && ` — kept ${describe(choice)}`}
        </span>
        <Pick label="Ours" active={choice?.kind === 'ours'} onClick={() => onChoose({ kind: 'ours' })} />
        <Pick
          label="Theirs"
          active={choice?.kind === 'theirs'}
          onClick={() => onChoose({ kind: 'theirs' })}
        />
        <Pick label="Both" active={choice?.kind === 'both'} onClick={() => onChoose({ kind: 'both' })} />
        <button
          type="button"
          onClick={startEditing}
          title="Edit the merged result by hand"
          className={cn(
            'flex items-center gap-1 rounded px-2 py-0.5 font-sans text-2xs transition',
            choice?.kind === 'custom'
              ? 'bg-accent/20 text-fg-base ring-1 ring-accent/45'
              : 'text-fg-muted hover:bg-surface-3 hover:text-fg-base',
          )}
        >
          <Pencil size={9} strokeWidth={2} />
          Edit
        </button>
        {choice && (
          <button
            type="button"
            onClick={onClear}
            title="Undo this resolution"
            className="rounded px-1.5 py-0.5 font-sans text-2xs text-fg-muted transition hover:bg-surface-3 hover:text-fg-base"
          >
            Undo
          </button>
        )}
      </div>

      {editing ? (
        <div className="p-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            rows={Math.min(24, Math.max(4, draft.split('\n').length + 1))}
            className="w-full resize-y rounded border border-border-subtle bg-bg-base px-2 py-1.5 font-mono text-sm leading-[19px] text-fg-base focus:border-accent/45 focus:outline-none"
          />
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              type="button"
              onClick={commitEdit}
              className="rounded px-2 py-0.5 font-sans text-2xs text-accent transition hover:bg-accent/10"
            >
              Use this
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded px-2 py-0.5 font-sans text-2xs text-fg-muted transition hover:bg-surface-3 hover:text-fg-base"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : choice ? (
        // Once resolved, show the result rather than the two sides — the
        // question has been answered and the answer is what matters.
        resolveSegment(seg, choice).map((l, i) => <Line key={i} text={l} />)
      ) : (
        <div className="flex">
          <Side label={seg.ourLabel} lines={seg.ours} tone="ours" />
          <div className="w-px shrink-0 bg-border-hairline" />
          <Side label={seg.theirLabel} lines={seg.theirs} tone="theirs" />
        </div>
      )}

      {/* The ancestor is context for the decision, not a candidate for it —
          so it sits below, collapsed, rather than as a third column. */}
      {!choice && !editing && seg.base && <BaseBlock lines={seg.base} />}
    </div>
  );
}

function describe(choice: Choice): string {
  switch (choice.kind) {
    case 'ours':
      return 'ours';
    case 'theirs':
      return 'theirs';
    case 'both':
      return 'both sides';
    case 'custom':
      return 'an edit';
  }
}

function Pick({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded px-2 py-0.5 font-sans text-2xs transition',
        active
          ? 'bg-accent/20 text-fg-base ring-1 ring-accent/45'
          : 'text-fg-muted hover:bg-surface-3 hover:text-fg-base',
      )}
    >
      {label}
    </button>
  );
}

function Side({
  label,
  lines,
  tone,
}: {
  label: string;
  lines: string[];
  tone: 'ours' | 'theirs';
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="truncate px-3 py-1 font-sans text-2xs uppercase tracking-widest text-fg-subtle/60">
        {tone === 'ours' ? 'ours' : 'theirs'} · {label}
      </div>
      {lines.length === 0 ? (
        <div className="px-3 py-1 font-sans text-2xs italic text-fg-subtle/60">
          (nothing on this side)
        </div>
      ) : (
        lines.map((l, i) => <Line key={i} text={l} tone={tone} />)
      )}
    </div>
  );
}

function BaseBlock({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-border-hairline">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 bg-surface-1 px-2 py-0.5 font-sans text-2xs text-fg-subtle hover:text-fg-base"
      >
        {open ? <ChevronDown size={10} strokeWidth={2} /> : <ChevronRight size={10} strokeWidth={2} />}
        common ancestor ({lines.length} {lines.length === 1 ? 'line' : 'lines'})
      </button>
      {open && lines.map((l, i) => <Line key={i} text={l} />)}
    </div>
  );
}
