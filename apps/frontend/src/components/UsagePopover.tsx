import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ChevronRight, Code, Loader2, RotateCcw } from 'lucide-react';
import { popoverPosition, type BranchPickerAnchor } from './BranchPicker';
import { Select, type SelectOption } from './Select';
import { useSettings } from '../state/settings';
import { isClaudeAgent, useUsage } from '../state/usage';
import { formatReset, type PlanLimit, type UsageSummary } from '../lib/usage';
import { cn } from '../lib/cn';

interface Props {
  anchor: BranchPickerAnchor;
  onClose: () => void;
}

const WIDTH = 320;

/**
 * Status bar's usage popup: pick a configured agent, run its usage command,
 * show whatever comes back. Layout follows the established popover pattern
 * (portalled material sheet) — see `BranchPicker` for the model this copies.
 */
export function UsagePopover({ anchor, onClose }: Props) {
  const agents = useSettings((s) => s.usageAgents);
  const selectedId = useUsage((s) => s.selectedId);
  const loading = useUsage((s) => s.loading);
  const results = useUsage((s) => s.results);
  const select = useUsage((s) => s.select);
  const refresh = useUsage((s) => s.refresh);
  const [showRaw, setShowRaw] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const agent = agents.find((a) => a.id === selectedId) ?? agents[0] ?? null;
  const result = agent ? results[agent.id] : undefined;

  // Fetch on open only when nothing is cached yet for the selected agent —
  // the refresh button is the only other trigger, per the "no polling" design.
  useEffect(() => {
    if (agent && !results[agent.id]) void refresh(agent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const options: SelectOption<string>[] = agents.map((a) => ({ value: a.id, label: a.name }));
  const isLoading = !!agent && loading === agent.id;
  const pos = popoverPosition(anchor, window.innerWidth, window.innerHeight);

  return createPortal(
    <div className="fixed inset-0 z-[60]" onMouseDown={onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{ position: 'fixed', width: WIDTH, ...pos }}
        className="material-sheet flex max-w-[92vw] animate-popover-in flex-col overflow-hidden rounded-md shadow-sheet ring-1 ring-edge-2"
      >
        {/* Header — agent picker + refresh */}
        <div className="flex items-center gap-2 border-b border-border-hairline px-3 py-2">
          {agent ? (
            <Select
              value={agent.id}
              options={options}
              onChange={select}
              ariaLabel="Usage agent"
              size="compact"
              className="flex-1"
            />
          ) : (
            <span className="flex-1 font-display text-xs text-fg-subtle">No agents configured</span>
          )}
          <button
            type="button"
            onClick={() => agent && void refresh(agent)}
            disabled={!agent || isLoading}
            title="Refresh"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base disabled:cursor-not-allowed disabled:opacity-45"
          >
            <RotateCcw size={12} strokeWidth={2.2} className={cn(isLoading && 'animate-spin')} />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[min(420px,60vh)] overflow-y-auto px-3.5 py-3">
          {!agent && (
            <p className="font-display text-xs text-fg-subtle">
              Add an agent in Settings → Tools → Usage.
            </p>
          )}

          {agent && isClaudeAgent(agent) ? (
            <div className="space-y-3">
              <Limits
                limits={result?.limits}
                error={result?.limitsError}
                loading={isLoading}
              />
              <div className="border-t border-border-hairline pt-2">
                <button
                  type="button"
                  onClick={() => setShowDetails(!showDetails)}
                  aria-expanded={showDetails}
                  className="flex w-full items-center gap-1 font-display text-2xs text-fg-subtle transition-colors hover:text-fg-base"
                >
                  <ChevronRight
                    size={11}
                    strokeWidth={2.2}
                    className={cn('transition-transform motion-reduce:transition-none', showDetails && 'rotate-90')}
                  />
                  Tokens and cost
                  <span className="ml-auto font-mono tabular-nums">
                    {result?.summary?.rows.find((r) => /cost/i.test(r.label))?.value}
                  </span>
                </button>
                {showDetails && (
                  <div className="pt-2.5">
                    <CommandOutput
                      agentName={agent.name}
                      loading={isLoading}
                      summary={result?.summary}
                      error={result?.error}
                      showRaw={showRaw}
                      onToggleRaw={setShowRaw}
                    />
                  </div>
                )}
              </div>
            </div>
          ) : (
            agent && (
              <CommandOutput
                agentName={agent.name}
                loading={isLoading}
                summary={result?.summary}
                error={result?.error}
                showRaw={showRaw}
                onToggleRaw={setShowRaw}
              />
            )
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CommandOutput({
  agentName,
  loading,
  summary,
  error,
  showRaw,
  onToggleRaw,
}: {
  agentName: string;
  loading: boolean;
  summary: UsageSummary | null | undefined;
  error: string | null | undefined;
  showRaw: boolean;
  onToggleRaw: (v: boolean) => void;
}) {
  if (summary) return <UsageBody summary={summary} showRaw={showRaw} onToggleRaw={onToggleRaw} />;
  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-md bg-status-err/[0.08] px-2.5 py-2 font-display text-xs text-status-err/90">
        <AlertTriangle size={11} strokeWidth={2.1} className="mt-[1px] shrink-0" />
        <span className="break-words">{error}</span>
      </div>
    );
  }
  if (!loading) return null;
  return (
    <div className="flex items-center justify-center gap-2 py-6 font-display text-xs text-fg-subtle">
      <Loader2 size={13} className="animate-spin" />
      running {agentName}…
    </div>
  );
}

const SEVERITY_FILL: Record<PlanLimit['severity'], string> = {
  normal: 'bg-accent',
  warning: 'bg-status-warn',
  critical: 'bg-status-err',
};

const SEVERITY_TEXT: Record<PlanLimit['severity'], string> = {
  normal: 'text-fg-base',
  warning: 'text-status-warn',
  critical: 'text-status-err',
};

function Limits({
  limits,
  error,
  loading,
}: {
  limits: PlanLimit[] | undefined;
  error: string | undefined;
  loading: boolean;
}) {
  if (error) {
    return (
      <p className="flex items-start gap-2 font-display text-xs text-fg-muted">
        <AlertTriangle size={11} strokeWidth={2.1} className="mt-[2px] shrink-0 text-status-warn" />
        <span className="break-words">{error}</span>
      </p>
    );
  }
  if (!limits) {
    return loading ? (
      <div className="flex items-center justify-center gap-2 py-4 font-display text-xs text-fg-subtle">
        <Loader2 size={13} className="animate-spin" />
        Checking plan limits…
      </div>
    ) : null;
  }
  if (limits.length === 0) {
    return <p className="font-display text-xs text-fg-subtle">Your plan reported no usage limits.</p>;
  }
  return (
    <div className="space-y-3.5">
      {limits.map((l) => (
        <LimitMeter key={l.label} limit={l} />
      ))}
    </div>
  );
}

/**
 * One limit: how much is used, and — as a hairline tick on the track — how
 * much of the window has passed. Fill ahead of the tick means you're burning
 * faster than the window refills.
 */
function LimitMeter({ limit }: { limit: PlanLimit }) {
  // Grow from zero on open: the one bit of motion in the popover, so the
  // eye lands on the bars first.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const { label, percent, severity, resetsAt, windowMs } = limit;
  const elapsed =
    resetsAt !== null && windowMs
      ? Math.max(0, Math.min(100, 100 - ((resetsAt - Date.now()) / windowMs) * 100))
      : null;
  const pct = Math.round(percent);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-display text-xs text-fg-muted">{label}</span>
        <span className={cn('font-mono text-xs tabular-nums', SEVERITY_TEXT[severity])}>
          {pct}%
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        title={
          elapsed === null
            ? `${pct}% used`
            : `${pct}% used, ${Math.round(elapsed)}% of the window has passed`
        }
        className="relative mt-1.5 h-1.5 rounded-full bg-surface-3"
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none',
            SEVERITY_FILL[severity],
          )}
          style={{ width: `${shown ? percent : 0}%` }}
        />
        {elapsed !== null && (
          <div
            className="absolute -top-[3px] -bottom-[3px] w-px bg-fg-base/50"
            style={{ left: `${elapsed}%` }}
          />
        )}
      </div>
      {resetsAt !== null && (
        <div className="mt-1 font-display text-2xs text-fg-subtle">{formatReset(resetsAt)}</div>
      )}
    </div>
  );
}

function UsageBody({
  summary,
  showRaw,
  onToggleRaw,
}: {
  summary: UsageSummary;
  showRaw: boolean;
  onToggleRaw: (v: boolean) => void;
}) {
  // Non-JSON output has nothing to render but the raw text — no toggle needed,
  // there's only one view.
  if (!summary.json) {
    return <RawBlock text={summary.raw} />;
  }

  if (showRaw) {
    return (
      <div className="space-y-2">
        <RawToggle showRaw={showRaw} onToggle={onToggleRaw} />
        <RawBlock text={summary.raw} />
      </div>
    );
  }

  const empty = summary.rows.length === 0 && summary.groups.length === 0;

  return (
    <div className="space-y-3">
      {empty && (
        <p className="font-display text-xs text-fg-subtle">No numeric fields in the output.</p>
      )}
      {summary.rows.length > 0 && <RowList rows={summary.rows} />}
      {summary.groups.map((g) => (
        <div key={g.title}>
          <div className="mb-1 font-display text-2xs uppercase tracking-widest2 text-fg-subtle/80">
            {g.title}
          </div>
          <RowList rows={g.rows} />
        </div>
      ))}
      <RawToggle showRaw={showRaw} onToggle={onToggleRaw} />
    </div>
  );
}

function RowList({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline justify-between gap-3">
          <span className="font-display text-xs text-fg-muted">{r.label}</span>
          <span className="font-mono text-xs tabular-nums text-fg-base">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function RawToggle({ showRaw, onToggle }: { showRaw: boolean; onToggle: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!showRaw)}
      className="flex items-center gap-1.5 font-display text-2xs text-fg-subtle transition-colors hover:text-fg-base"
    >
      <Code size={10} strokeWidth={2.2} />
      {showRaw ? 'Hide raw output' : 'Show raw output'}
    </button>
  );
}

function RawBlock({ text }: { text: string }) {
  return (
    <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-base/50 p-2 font-mono text-2xs text-fg-muted">
      {text.trim() || '(empty output)'}
    </pre>
  );
}
