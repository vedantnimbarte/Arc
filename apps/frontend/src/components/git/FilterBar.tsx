import { GitCommit, GitGraph, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { GitAuthorInfo } from '../../lib/tauri';
import { authorKey } from './AuthorsSidebar';

export type ViewMode = 'flat' | 'graph';

export interface DateRange {
  /** ISO yyyy-mm-dd or null. */
  from: string | null;
  to: string | null;
  /** Identifier of the active preset, if any. */
  preset: PresetId | null;
}

export type PresetId = 'today' | '7d' | '30d' | '90d' | 'year' | 'all';

const PRESETS: { id: PresetId; label: string; days: number | null }[] = [
  { id: 'today', label: 'Today', days: 0 },
  { id: '7d', label: '7d', days: 7 },
  { id: '30d', label: '30d', days: 30 },
  { id: '90d', label: '90d', days: 90 },
  { id: 'year', label: 'Year', days: 365 },
  { id: 'all', label: 'All', days: null },
];

interface Props {
  selectedAuthors: GitAuthorInfo[];
  onRemoveAuthor: (a: GitAuthorInfo) => void;

  range: DateRange;
  onRangeChange: (r: DateRange) => void;

  view: ViewMode;
  onViewChange: (v: ViewMode) => void;

  /** Number of commits currently shown (post-filter). */
  count: number;
  loading: boolean;
}

export function FilterBar({
  selectedAuthors,
  onRemoveAuthor,
  range,
  onRangeChange,
  view,
  onViewChange,
  count,
  loading,
}: Props) {
  const setPreset = (id: PresetId) => {
    const def = PRESETS.find((p) => p.id === id);
    if (!def) return;
    if (def.days === null) {
      onRangeChange({ from: null, to: null, preset: 'all' });
      return;
    }
    const now = new Date();
    const todayIso = now.toISOString().slice(0, 10);
    const past = new Date(now.getTime() - def.days * 24 * 60 * 60 * 1000);
    onRangeChange({ from: past.toISOString().slice(0, 10), to: todayIso, preset: id });
  };

  const setCustomFrom = (v: string) => {
    onRangeChange({ ...range, from: v || null, preset: null });
  };
  const setCustomTo = (v: string) => {
    onRangeChange({ ...range, to: v || null, preset: null });
  };

  return (
    <div className="relative flex shrink-0 flex-col gap-2.5 border-b border-border-subtle px-4 py-3 bg-gradient-to-b from-white/[0.015] to-transparent">
      {/* Row 1 — author chips + view toggle */}
      <div className="flex flex-wrap items-center gap-1.5">
        {selectedAuthors.length === 0 ? (
          <span className="inline-flex items-center gap-1.5 font-display text-[10.5px] uppercase tracking-widest2 text-fg-subtle/80">
            <span className="h-1 w-1 rounded-full bg-fg-subtle/50" />
            All authors
          </span>
        ) : (
          selectedAuthors.map((a) => (
            <span
              key={authorKey(a)}
              className="group inline-flex items-center gap-1.5 rounded-full bg-gradient-to-b from-white/[0.07] to-white/[0.03] py-[3px] pl-2.5 pr-1 font-display text-[11px] text-fg-base ring-1 ring-inset ring-white/[0.06] shadow-control animate-fade-in"
              title={`${a.name} <${a.email}>`}
            >
              <span className="max-w-[160px] truncate">{a.name || a.email}</span>
              <span className="font-mono text-[9.5px] text-fg-subtle">{a.commits}</span>
              <button
                onClick={() => onRemoveAuthor(a)}
                className="flex h-4 w-4 items-center justify-center rounded-full text-fg-subtle transition-all duration-150 hover:bg-white/10 hover:text-fg-base active:scale-90"
                aria-label={`Remove filter ${a.name}`}
              >
                <X size={9} strokeWidth={2.4} />
              </button>
            </span>
          ))
        )}

        <span className="ml-auto inline-flex shrink-0 items-center gap-px rounded-full bg-black/[0.22] p-[3px] ring-1 ring-inset ring-white/[0.04] shadow-control">
          <ToggleSegment
            active={view === 'flat'}
            onClick={() => onViewChange('flat')}
            icon={<GitCommit size={11} strokeWidth={2.1} />}
            label="Flat"
          />
          <ToggleSegment
            active={view === 'graph'}
            onClick={() => onViewChange('graph')}
            icon={<GitGraph size={11} strokeWidth={2.1} />}
            label="Graph"
          />
        </span>
      </div>

      {/* Row 2 — date presets + custom range + count */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="inline-flex items-center gap-px rounded-full bg-black/[0.18] p-[3px] ring-1 ring-inset ring-white/[0.04]">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPreset(p.id)}
              className={cn(
                'rounded-full px-2.5 py-[2px] font-display text-[10.5px] transition-all duration-200',
                range.preset === p.id
                  ? 'bg-gradient-to-b from-white/[0.14] to-white/[0.06] text-fg-base shadow-control'
                  : 'text-fg-muted hover:text-fg-base',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        <span className="mx-1 h-3 w-px bg-border-subtle" />

        <DateInput value={range.from ?? ''} onChange={setCustomFrom} label="from" />
        <span className="font-display text-[10.5px] text-fg-subtle">→</span>
        <DateInput value={range.to ?? ''} onChange={setCustomTo} label="to" />

        <span
          className={cn(
            'ml-auto inline-flex items-center gap-1.5 rounded-full bg-white/[0.03] px-2.5 py-[2px] font-display text-[10.5px] tabular-nums text-fg-muted ring-1 ring-inset ring-white/[0.04]',
            loading && 'animate-pulse-soft',
          )}
        >
          {loading ? (
            <>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-bright" />
              <span>loading…</span>
            </>
          ) : (
            <>
              <span className="font-mono text-fg-base">{count}</span>
              <span className="text-fg-subtle">{count === 1 ? 'commit' : 'commits'}</span>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

function ToggleSegment({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-full px-2.5 py-[3px] font-display text-[11px] transition-all duration-200',
        active
          ? 'bg-gradient-to-b from-white/[0.14] to-white/[0.06] text-fg-base shadow-control'
          : 'text-fg-muted hover:text-fg-base',
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function DateInput({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <input
      type="date"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      className={cn(
        'h-[24px] rounded-full bg-black/[0.18] px-2.5 font-display text-[10.5px] text-fg-base ring-1 ring-inset ring-white/[0.05] transition-all duration-200',
        'placeholder:text-fg-subtle/70 hover:bg-black/[0.24] focus:ring-accent/40 focus:outline-none',
      )}
    />
  );
}
