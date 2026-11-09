import { useEffect, useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import { summarize, useUsageLog } from '../state/usageLog';
import { cn } from '../lib/cn';

const WINDOW_DAYS = 30;

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

const formatCost = (cost: number | null) => (cost === null ? '—' : `$${cost.toFixed(2)}`);

/**
 * Agent usage at a glance: totals, a 30-day activity strip, spend by model and
 * the heaviest sessions. Cost comes only from turns ARC recorded itself;
 * imported Claude Code history carries tokens but no price.
 */
export function UsageDashboard() {
  const { log, loaded, importing, importError } = useUsageLog();
  useEffect(() => {
    void useUsageLog.getState().load();
  }, []);
  const summary = useMemo(() => summarize(log, WINDOW_DAYS, Date.now()), [log]);
  const peakDay = Math.max(1, ...summary.byDay.map((d) => d.tokens));
  const peakModel = Math.max(1, summary.byModel[0]?.tokens ?? 0);

  return (
    <div className="h-full overflow-y-auto bg-bg-base p-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-xl font-semibold tracking-tight text-fg-base">Usage</h1>
            <p className="text-xs text-fg-muted">
              Claude Code turns recorded by ARC
              {log.historyImportedAt ? ', plus imported Claude Code history' : ''}.
            </p>
          </div>
          <button
            onClick={() => void useUsageLog.getState().importClaudeHistory()}
            disabled={importing}
            className="flex items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base disabled:opacity-50"
          >
            <RefreshCw size={12} strokeWidth={2} className={cn(importing && 'animate-spin')} />
            {log.historyImportedAt ? 'Re-import Claude history' : 'Import Claude history'}
          </button>
        </header>

        {importError && (
          <p className="rounded-md border border-status-err/40 px-3 py-2 text-xs text-status-err">
            Import failed: {importError}
          </p>
        )}

        {!loaded ? (
          <p className="text-sm text-fg-muted">Loading usage…</p>
        ) : log.buckets.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No usage yet. It's recorded as you use Claude Code in ARC, or import your past Claude
            Code history above.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Stat label="Total tokens" value={formatTokens(summary.totalTokens)} />
              <Stat label="Input" value={formatTokens(summary.input)} />
              <Stat label="Output" value={formatTokens(summary.output)} />
              <Stat label="Sessions" value={String(summary.sessions)} />
              <Stat label="Recorded cost" value={formatCost(summary.costUsd)} />
            </div>

            <Section title={`Activity · last ${WINDOW_DAYS} days`}>
              <div className="flex h-28 items-end gap-1">
                {summary.byDay.map((d) => (
                  <div
                    key={d.day}
                    title={`${d.day}: ${formatTokens(d.tokens)} tokens`}
                    className={cn('flex-1 rounded-sm', d.tokens > 0 ? 'bg-fg-base/70' : 'bg-surface-2')}
                    style={{ height: `${Math.max(2, (d.tokens / peakDay) * 100)}%` }}
                  />
                ))}
              </div>
            </Section>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Section title="By model">
                {summary.byModel.map((m) => (
                  <div key={m.model} className="flex flex-col gap-1">
                    <div className="flex justify-between text-xs">
                      <span className="truncate text-fg-base">{m.model}</span>
                      <span className="text-fg-muted">
                        {formatTokens(m.tokens)} · {formatCost(m.costUsd)}
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full bg-fg-base/70"
                        style={{ width: `${Math.max(1, (m.tokens / peakModel) * 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </Section>
              <Section title="Top sessions">
                {summary.topSessions.map((s) => (
                  <div key={s.sessionId} className="flex justify-between gap-3 text-xs">
                    <span className="truncate text-fg-base" title={s.cwd}>
                      {s.cwd.split(/[\\/]/).filter(Boolean).pop() || s.sessionId.slice(0, 8)}
                    </span>
                    <span className="shrink-0 text-fg-muted">
                      {formatTokens(s.tokens)} · {formatCost(s.costUsd)}
                    </span>
                  </div>
                ))}
              </Section>
            </div>

            <p className="text-2xs text-fg-subtle">
              Wingman spend is tracked by the Wingman daemon and shown in its panel.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface-1 p-3">
      <div className="text-2xs text-fg-subtle">{label}</div>
      <div className="font-display text-lg font-semibold tracking-tight text-fg-base">{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-surface-1 p-4">
      <div className="text-2xs font-semibold uppercase tracking-[0.14em] text-fg-subtle">{title}</div>
      {children}
    </section>
  );
}
