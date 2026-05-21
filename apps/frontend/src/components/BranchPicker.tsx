import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Cloud,
  CornerDownLeft,
  GitBranch,
  Loader2,
  Search,
} from 'lucide-react';
import {
  gitBranches,
  gitCheckout,
  isTauri,
  type GitBranchInfo,
} from '../lib/tauri';
import { useFiles } from '../state/files';
import { cn } from '../lib/cn';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after a successful checkout so the status bar can refresh. */
  onCheckedOut?: (branch: string) => void;
}

/**
 * Branch switcher invoked by clicking the StatusBar branch chip.
 *
 * Lists every local + remote branch in the current workspace repo, with a
 * fuzzy filter input pinned at the top and a quiet "tip-of-branch" preview
 * line under each row. Picking a remote branch ("origin/x") creates a local
 * tracking branch automatically.
 *
 * Layout follows the established CommandPalette / SearchPalette pattern
 * (centered material sheet, sheet-in animation, kbd hint footer) but adds:
 *
 *   - Pinned current branch row with a luminous accent pip
 *   - Sectioned grouping (Local / Remote) with quiet category labels
 *   - Per-row subject + relative-time meta in the right rail
 *   - Inline "switching…" + error states
 */
export function BranchPicker({ open, onClose, onCheckedOut }: Props) {
  const root = useFiles((s) => s.root);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<GitBranchInfo[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch on open + after a successful checkout (which closes & re-opens
  // the modal via the parent).
  useEffect(() => {
    if (!open) return;
    if (!isTauri || !root) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void gitBranches(root)
      .then((b) => {
        if (!cancelled) {
          setRows(b);
          setSelected(0);
        }
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, root]);

  // Focus + reset transient state on open / close.
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery('');
      setSelected(0);
      setError(null);
      setSwitching(null);
    }
  }, [open]);

  // Filtered + grouped view. The current branch is always pinned to the
  // top regardless of sort/filter, so the user has a clear anchor.
  const { current, locals, remotes, flat } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (b: GitBranchInfo) =>
      q === '' ||
      b.name.toLowerCase().includes(q) ||
      (b.subject?.toLowerCase().includes(q) ?? false);

    const cur = rows.find((b) => b.current) ?? null;
    const filtered = rows.filter((b) => b !== cur && matches(b));
    const ls = filtered.filter((b) => !b.remote);
    const rs = filtered.filter((b) => b.remote);

    // Flat order = the order rows are rendered in, used for keyboard nav.
    const flat: GitBranchInfo[] = [];
    if (cur && matches(cur)) flat.push(cur);
    flat.push(...ls, ...rs);
    return { current: cur, locals: ls, remotes: rs, flat };
  }, [rows, query]);

  const doCheckout = useCallback(
    async (b: GitBranchInfo) => {
      if (!root || b.current || switching) return;
      setSwitching(b.name);
      setError(null);
      try {
        const res = await gitCheckout(root, b.name);
        onCheckedOut?.(res.branch ?? b.name);
        onClose();
      } catch (err) {
        setError(typeof err === 'string' ? err : String(err));
      } finally {
        setSwitching(null);
      }
    },
    [root, switching, onClose, onCheckedOut],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = flat[selected];
      if (pick) void doCheckout(pick);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, Math.max(flat.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    }
  };

  if (!open) return null;

  // Compute a flat index for a given row so highlighting matches keyboard.
  const indexOf = (b: GitBranchInfo) => flat.indexOf(b);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="material-sheet mt-[12vh] flex w-[640px] max-w-[92vw] animate-sheet-in flex-col overflow-hidden rounded-window shadow-sheet ring-1 ring-white/10"
      >
        {/* Header — search input */}
        <div className="flex items-center gap-2 border-b border-border-hairline px-3.5 py-2.5">
          <GitBranch size={13} strokeWidth={2.1} className="text-fg-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="switch branch…"
            className="flex-1 bg-transparent font-display text-[13px] text-fg-base placeholder:text-fg-subtle focus:outline-none"
            autoComplete="off"
            spellCheck={false}
            disabled={!!switching}
          />
          {loading && (
            <Loader2 size={11} className="animate-spin text-fg-subtle" />
          )}
          <kbd className="font-mono text-[10px] text-fg-subtle">esc</kbd>
        </div>

        {/* Error tray (only visible on a failed checkout) */}
        {error && (
          <div className="flex items-start gap-2 border-b border-border-hairline bg-status-err/[0.08] px-3.5 py-2 font-display text-[11px] text-status-err/90">
            <AlertTriangle size={11} strokeWidth={2.1} className="mt-[1px] shrink-0" />
            <span className="line-clamp-2 break-words">{error}</span>
          </div>
        )}

        {/* Body — sectioned branch list */}
        <div className="max-h-[440px] overflow-y-auto py-1">
          {!isTauri && (
            <EmptyState text="branch list is unavailable in web preview" />
          )}

          {isTauri && !root && (
            <EmptyState text="open a folder to switch branches" />
          )}

          {isTauri && root && !loading && rows.length === 0 && (
            <EmptyState text="not a git repository" />
          )}

          {isTauri && root && rows.length > 0 && flat.length === 0 && (
            <EmptyState
              text={`no branches match “${query}”`}
              icon={<Search size={11} strokeWidth={2} />}
            />
          )}

          {/* Pinned current branch (when it survives the filter). */}
          {current && flat.includes(current) && (
            <>
              <SectionLabel label="current" />
              <BranchRow
                branch={current}
                isSelected={indexOf(current) === selected}
                switching={switching === current.name}
                onHover={() => setSelected(indexOf(current))}
                onPick={() => void doCheckout(current)}
              />
            </>
          )}

          {locals.length > 0 && (
            <>
              <SectionLabel label="local" count={locals.length} />
              {locals.map((b) => (
                <BranchRow
                  key={b.name}
                  branch={b}
                  isSelected={indexOf(b) === selected}
                  switching={switching === b.name}
                  onHover={() => setSelected(indexOf(b))}
                  onPick={() => void doCheckout(b)}
                />
              ))}
            </>
          )}

          {remotes.length > 0 && (
            <>
              <SectionLabel label="remote" count={remotes.length} />
              {remotes.map((b) => (
                <BranchRow
                  key={b.name}
                  branch={b}
                  isSelected={indexOf(b) === selected}
                  switching={switching === b.name}
                  onHover={() => setSelected(indexOf(b))}
                  onPick={() => void doCheckout(b)}
                />
              ))}
            </>
          )}
        </div>

        {/* Footer — kbd hints + total count */}
        <div className="flex items-center justify-between border-t border-border-hairline px-3.5 py-1.5 font-display text-[10px] text-fg-subtle">
          <span>
            <kbd className="font-mono">↑↓</kbd> select ·{' '}
            <kbd className="font-mono">return</kbd> checkout ·{' '}
            <kbd className="font-mono">esc</kbd> close
          </span>
          <span className="tabular-nums">
            {rows.length} {rows.length === 1 ? 'branch' : 'branches'}
          </span>
        </div>
      </div>
    </div>
  );
}

// ----- subcomponents -------------------------------------------------------

function SectionLabel({ label, count }: { label: string; count?: number }) {
  return (
    <div className="flex items-center gap-1.5 px-3.5 pb-1 pt-2 font-display text-[9.5px] uppercase tracking-widest2 text-fg-subtle/80">
      <span className="h-px flex-1 bg-border-hairline/60" />
      <span>{label}</span>
      {count !== undefined && (
        <span className="tabular-nums text-fg-subtle/60">· {count}</span>
      )}
      <span className="h-px w-3 bg-border-hairline/60" />
    </div>
  );
}

interface RowProps {
  branch: GitBranchInfo;
  isSelected: boolean;
  switching: boolean;
  onHover: () => void;
  onPick: () => void;
}

function BranchRow({ branch, isSelected, switching, onHover, onPick }: RowProps) {
  const Icon = branch.remote ? Cloud : GitBranch;
  const remotePrefix = branch.remote ? branch.name.split('/')[0] : null;
  const localName = branch.remote
    ? branch.name.slice((remotePrefix?.length ?? 0) + 1)
    : branch.name;

  return (
    <button
      onMouseEnter={onHover}
      onClick={onPick}
      disabled={switching || branch.current}
      className={cn(
        'flex w-full items-center gap-3 px-3.5 py-2 text-left transition-colors',
        isSelected
          ? 'bg-accent-soft ring-1 ring-inset ring-border-strong'
          : 'hover:bg-white/[0.045]',
        (switching || branch.current) && 'cursor-default',
      )}
    >
      {/* Leading pip — luminous on the current branch, hairline otherwise. */}
      <span
        className={cn(
          'relative inline-flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full',
          branch.current
            ? 'bg-accent-soft text-fg-base shadow-[inset_0_0_0_1px_rgba(220,224,232,0.22)]'
            : 'text-fg-subtle',
        )}
      >
        <Icon size={11} strokeWidth={2.1} />
        {branch.current && (
          <span
            className="absolute -right-[1px] -top-[1px] h-[6px] w-[6px] rounded-full bg-accent-bright shadow-[0_0_8px_rgba(220,224,232,0.7)]"
            aria-label="current"
          />
        )}
      </span>

      {/* Name + subject column */}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          {remotePrefix && (
            <span className="font-mono text-[11px] text-fg-subtle">
              {remotePrefix}/
            </span>
          )}
          <span
            className={cn(
              'truncate font-mono text-[12.5px]',
              branch.current ? 'text-fg-base' : 'text-fg-base/90',
            )}
          >
            {localName}
          </span>
          {branch.current && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-accent-soft px-1.5 py-[1px] font-display text-[9px] uppercase tracking-widest2 text-fg-muted">
              <Check size={8} strokeWidth={2.5} />
              on
            </span>
          )}
          {branch.upstream && !branch.remote && !branch.current && (
            <span className="truncate font-mono text-[10px] text-fg-subtle/80">
              → {branch.upstream}
            </span>
          )}
        </div>
        {branch.subject && (
          <div className="mt-0.5 truncate font-display text-[10.5px] text-fg-subtle">
            {branch.subject}
          </div>
        )}
      </div>

      {/* Trailing meta column */}
      <div className="flex shrink-0 items-center gap-2.5 font-mono text-[10px] text-fg-subtle tabular-nums">
        {branch.head_short && <span>{branch.head_short}</span>}
        <span className="w-[36px] text-right">{formatAge(branch.time * 1000)}</span>
        {isSelected && !switching && !branch.current && (
          <CornerDownLeft size={11} strokeWidth={2.1} className="text-fg-muted" />
        )}
        {switching && (
          <Loader2 size={11} className="animate-spin text-fg-muted" />
        )}
      </div>
    </button>
  );
}

function EmptyState({ text, icon }: { text: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center gap-1.5 px-4 py-8 font-display text-[11.5px] italic text-fg-subtle">
      {icon}
      {text}
    </div>
  );
}

/** "5s", "12m", "3h", "2d", "4w" — short relative time markers. */
function formatAge(unixMs: number): string {
  const delta = Math.max(0, Date.now() - unixMs);
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 52) return `${w}w`;
  const y = Math.floor(d / 365);
  return `${y}y`;
}
