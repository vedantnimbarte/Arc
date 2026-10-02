import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Ban, CornerDownLeft, Loader2, Pause, Play, Power, RefreshCw } from 'lucide-react';
import { dbStats, type DbBackend, type DbSafety } from '../../lib/tauri';
import {
  DIALECTS,
  formatBytes,
  formatCell,
  formatDuration,
  formatNumber,
  parseCounters,
  point,
  records,
  type ChartSpec,
  type Counters,
  type Maintenance,
  type Section,
} from '../../lib/dbAnalytics';
import { askConfirm } from '../../state/confirm';
import { toast, toastError } from '../../state/toast';
import { cn } from '../../lib/cn';

interface Props {
  connId: string;
  backend: DbBackend;
  safety: DbSafety;
  /** Put a statement in the query editor and switch to it. */
  onOpenSql: (sql: string) => void;
}

type Row = Record<string, string | null>;
type Loaded = { rows: Row[]; error: null } | { rows: null; error: string } | null;
type Sample = { t: number; c: Counters };
type TabKey = 'activity' | 'locks' | 'topQueries' | 'tables' | 'scanHeavy' | 'unusedIndexes';

/** Two minutes of history at the default 2s interval. */
const MAX_SAMPLES = 61;
const INTERVALS = [1000, 2000, 5000, 10000];
const TAB_ORDER: TabKey[] = ['activity', 'locks', 'topQueries', 'tables', 'scanHeavy', 'unusedIndexes'];
const TAB_LABELS: Record<TabKey, string> = {
  activity: 'Sessions',
  locks: 'Locks',
  topQueries: 'Top queries',
  tables: 'Largest tables',
  scanHeavy: 'Full scans',
  unusedIndexes: 'Unused indexes',
};
const NO_SECTIONS: Record<TabKey, Loaded> = {
  activity: null,
  locks: null,
  topQueries: null,
  tables: null,
  scanHeavy: null,
  unusedIndexes: null,
};

async function load(connId: string, section: Section | null): Promise<Loaded> {
  if (!section) return null;
  try {
    return { rows: records(await dbStats(connId, section.sql)), error: null };
  } catch {
    return { rows: null, error: section.unavailable };
  }
}

/** pgAdmin-style dashboard for the connected database. Live counters and
 *  sessions poll only while this view is on screen and not paused. */
export function DbAnalytics({ connId, backend, safety, onOpenSql }: Props) {
  const d = DIALECTS[backend];
  const root = useRef<HTMLDivElement>(null);
  const [intervalMs, setIntervalMs] = useState(2000);
  const [paused, setPaused] = useState(false);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [pollError, setPollError] = useState<string | null>(null);
  const [overview, setOverview] = useState<Row | null>(null);
  const [sections, setSections] = useState<Record<TabKey, Loaded>>(NO_SECTIONS);
  const tabs = TAB_ORDER.filter((k) => d[k]);
  const [tab, setTab] = useState<TabKey>(tabs[0] ?? 'tables');
  const [refreshing, setRefreshing] = useState(false);
  const [maintaining, setMaintaining] = useState<string | null>(null);

  /** The slow, mostly-static parts: overview, sizes, index and query stats. */
  const refreshStatic = useCallback(async () => {
    setRefreshing(true);
    const [ov, tables, unusedIndexes, topQueries, scanHeavy] = await Promise.all([
      dbStats(connId, d.overview).then(
        (r) => records(r)[0] ?? null,
        () => null,
      ),
      load(connId, d.tables),
      load(connId, d.unusedIndexes),
      load(connId, d.topQueries),
      load(connId, d.scanHeavy),
    ]);
    setOverview(ov);
    setSections((s) => ({ ...s, tables, unusedIndexes, topQueries, scanHeavy }));
    setRefreshing(false);
  }, [connId, d]);

  /** One live tick: counters for the charts, plus sessions and locks. */
  const poll = useCallback(async () => {
    const [counters, activity, locks] = await Promise.all([
      d.counters
        ? dbStats(connId, d.counters).then(
            (r) => parseCounters(backend, r),
            (e) => {
              setPollError(String(e));
              return null;
            },
          )
        : null,
      load(connId, d.activity),
      load(connId, d.locks),
    ]);
    if (counters) {
      setPollError(null);
      setSamples((s) => [...s.slice(-(MAX_SAMPLES - 1)), { t: Date.now(), c: counters }]);
    }
    setSections((s) => ({ ...s, activity, locks }));
  }, [connId, backend, d]);

  useEffect(() => {
    setSamples([]);
    void refreshStatic();
    void poll();
  }, [refreshStatic, poll]);

  // Poll on a timer, skipping ticks while the tab is hidden (the DB tab stays
  // mounted behind other tabs) and never overlapping a slow tick.
  useEffect(() => {
    if (paused || !d.counters) return;
    let busy = false;
    const id = window.setInterval(() => {
      if (busy || document.hidden || !root.current?.offsetParent) return;
      busy = true;
      void poll().finally(() => (busy = false));
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [paused, intervalMs, poll, d.counters]);

  const stop = async (pid: string, hard: boolean) => {
    if (!d.stop || !/^\d+$/.test(pid)) return;
    const ok = await askConfirm({
      title: hard ? `Terminate session ${pid}?` : `Cancel the query in session ${pid}?`,
      body: hard
        ? 'The connection is closed. Any open transaction in it is rolled back.'
        : 'The running statement stops with an error. The session stays connected.',
      confirmLabel: hard ? 'Terminate' : 'Cancel query',
      destructive: true,
    });
    if (!ok) return;
    try {
      await dbStats(connId, d.stop(Number(pid), hard));
      toast(hard ? `Terminated session ${pid}` : `Cancelled the query in session ${pid}`);
      void poll();
    } catch (e) {
      toastError(String(e));
    }
  };

  /** VACUUM / ANALYZE / OPTIMIZE one table. Production asks first. */
  const maintain = async (table: string, m: Maintenance) => {
    if (maintaining) return;
    const sql = m.sql(table);
    if (safety === 'production') {
      const ok = await askConfirm({
        title: `${m.label} ${table} on production?`,
        body: `${sql} — ${m.title.split(': ')[1] ?? m.title}.`,
        confirmLabel: m.label,
      });
      if (!ok) return;
    }
    setMaintaining(`${m.label}:${table}`);
    try {
      await dbStats(connId, sql);
      toast(`${m.label} finished on ${table}`);
      void refreshStatic();
    } catch (e) {
      toastError(String(e));
    } finally {
      setMaintaining(null);
    }
  };

  const rowActions = (row: Row): ReactNode => {
    if (tab === 'activity' && d.stop && row.pid && !isSelf(row)) {
      return (
        <>
          <button type="button" onClick={() => void stop(row.pid!, false)} title="Cancel the running query" className={ROW_BTN}>
            <Ban size={12} />
          </button>
          <button
            type="button"
            onClick={() => void stop(row.pid!, true)}
            title="Terminate the session"
            className="rounded p-1 text-fg-subtle transition hover:bg-status-err/15 hover:text-status-err"
          >
            <Power size={12} />
          </button>
        </>
      );
    }
    if (tab === 'topQueries' && row.query) {
      return (
        <button type="button" onClick={() => onOpenSql(row.query!)} title="Open in the query editor" className={ROW_BTN}>
          <CornerDownLeft size={12} />
        </button>
      );
    }
    if ((tab === 'tables' || tab === 'scanHeavy') && row.name && safety !== 'readonly') {
      return d.maintenance.map((m) => {
        const busy = maintaining === `${m.label}:${row.name}`;
        return (
          <button
            key={m.label}
            type="button"
            disabled={maintaining !== null}
            onClick={() => void maintain(row.name!, m)}
            title={m.title}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-fg-subtle transition hover:bg-surface-2 hover:text-fg-base disabled:opacity-40"
          >
            {busy && <Loader2 size={10} className="animate-spin" />}
            {m.label}
          </button>
        );
      });
    }
    return null;
  };

  const latest = samples.at(-1)?.c;
  const facts = useMemo(
    () => overviewFacts(backend, overview, latest),
    [backend, overview, latest],
  );

  return (
    <div ref={root} className="h-full overflow-auto">
      {/* Overview strip + live controls */}
      <div className="flex flex-wrap items-stretch gap-y-2 border-b border-border-hairline px-4 py-3">
        <dl className="flex min-w-0 flex-1 flex-wrap gap-x-6 gap-y-2">
          {facts.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="font-sans text-2xs text-fg-subtle">{label}</dt>
              <dd
                className="truncate font-sans text-base tabular-nums tracking-tight text-fg-base"
                title={value}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex items-center gap-1.5 self-center">
          {d.counters && (
            <>
              <span className="flex items-center gap-1.5 pr-1 font-sans text-xs text-fg-muted">
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    paused ? 'bg-fg-subtle' : 'bg-status-ok',
                  )}
                  aria-hidden
                />
                {paused ? 'Paused' : 'Live'}
              </span>
              <select
                value={intervalMs}
                onChange={(e) => setIntervalMs(Number(e.target.value))}
                title="Refresh interval"
                className="rounded-md bg-surface-1 px-1.5 py-0.5 font-sans text-xs text-fg-base ring-1 ring-border-hairline focus:outline-none focus:ring-accent/45"
              >
                {INTERVALS.map((ms) => (
                  <option key={ms} value={ms}>
                    every {ms / 1000}s
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setPaused((p) => !p)}
                title={paused ? 'Resume live updates' : 'Pause live updates'}
                className="flex h-6 w-6 items-center justify-center rounded-md text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
              >
                {paused ? <Play size={12} /> : <Pause size={12} />}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => {
              void refreshStatic();
              void poll();
            }}
            title="Refresh sizes and sessions now"
            className="flex h-6 w-6 items-center justify-center rounded-md text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
          >
            {refreshing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          </button>
        </div>
      </div>

      {/* Live charts */}
      {d.counters ? (
        pollError ? (
          <p className="border-b border-border-hairline px-4 py-3 font-sans text-xs text-status-err">
            Live stats failed: {pollError}
          </p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-px border-b border-border-hairline bg-border-hairline">
            {d.charts.map((spec) => (
              <LiveChart key={spec.title} spec={spec} samples={samples} />
            ))}
          </div>
        )
      ) : (
        <p className="border-b border-border-hairline px-4 py-3 font-sans text-xs text-fg-subtle">
          SQLite runs inside this app, so there are no server counters to chart. Sizes below are
          read from the file.
        </p>
      )}

      {/* Detail tables */}
      <div className="flex items-center gap-1 px-3 pt-2" role="tablist">
        {tabs.map((k) => {
          const rows = sections[k]?.rows;
          return (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 font-sans text-xs transition',
                tab === k
                  ? 'bg-surface-2 text-fg-base'
                  : 'text-fg-muted hover:bg-surface-1 hover:text-fg-base',
              )}
            >
              {TAB_LABELS[k]}
              {rows && (
                <span className="rounded-full bg-surface-2 px-1.5 font-sans text-[10px] leading-4 tabular-nums text-fg-subtle">
                  {rows.length}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <SectionTable section={d[tab]!} loaded={sections[tab]} actions={rowActions} />
    </div>
  );
}

function overviewFacts(
  backend: DbBackend,
  ov: Row | null,
  c: Counters | undefined,
): [string, string][] {
  const num = (v: string | null | undefined) => (v == null ? null : Number(v));
  const size = num(ov?.size_bytes);
  const facts: [string, string][] = [['Size', size == null ? '—' : formatBytes(size)]];
  if (backend === 'sqlite') {
    const free = num(ov?.free_bytes);
    facts.push(['Free pages', free == null ? '—' : formatBytes(free)]);
    facts.push(['Journal', ov?.journal_mode ?? '—']);
  } else {
    const hits = c?.cache_hits ?? 0;
    const total = hits + (c?.disk_reads ?? 0);
    facts.push(['Cache hit', total ? `${((hits / total) * 100).toFixed(1)}%` : '—']);
    facts.push([
      'Connections',
      c?.server_sessions != null ? `${c.server_sessions} of ${ov?.max_connections ?? '?'}` : '—',
    ]);
    const up = num(ov?.uptime_secs) ?? c?.uptime_secs;
    facts.push(['Uptime', up == null ? '—' : formatDuration(up)]);
  }
  facts.push(['Version', ov?.version?.split(/[ -]/)[0] ?? '—']);
  return facts;
}

const CHART_H = 112;
const PAD_TOP = 8;

/** One live line chart: fixed-width time window, new points enter at the
 *  right. Hover shows a crosshair with every series' value at that tick. */
function LiveChart({ spec, samples }: { spec: ChartSpec; samples: Sample[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(300);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const points = samples.map((s, i) =>
    point(spec, samples[i - 1]?.c ?? null, s.c, (s.t - (samples[i - 1]?.t ?? s.t)) / 1000),
  );
  const max = niceMax(Math.max(0, ...points.flatMap((p) => p ?? [])));
  const step = width / (MAX_SAMPLES - 1);
  const offset = MAX_SAMPLES - points.length;
  const x = (i: number) => (offset + i) * step;
  const y = (v: number) => PAD_TOP + (CHART_H - PAD_TOP) * (1 - v / max);
  const last = [...points].reverse().find((p) => p !== null) ?? null;
  const shown = hover !== null ? points[hover] : last;

  const paths = spec.series.map((_, si) => {
    let dStr = '';
    points.forEach((p, i) => {
      if (!p) return;
      dStr += `${dStr ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[si] ?? 0).toFixed(1)}`;
    });
    return dStr;
  });

  const onMove = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.round((e.clientX - rect.left) / step) - offset;
    setHover(i >= 0 && i < points.length && points[i] ? i : null);
  };

  return (
    <figure className="m-0 bg-bg-base px-4 pb-3 pt-2.5">
      <figcaption className="mb-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="font-sans text-xs text-fg-base">
          {spec.title}
          {spec.unit && <span className="text-fg-subtle"> per second</span>}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-x-2.5">
          {spec.series.map((s, si) => (
            <span key={s.key} className="flex items-center gap-1 font-sans text-2xs text-fg-muted">
              <span
                className="h-0.5 w-2.5 rounded-full"
                style={{ background: `var(--series-${si + 1})` }}
                aria-hidden
              />
              {s.label}
              <span className="tabular-nums text-fg-base">
                {shown ? formatNumber(shown[si] ?? 0) : '—'}
              </span>
            </span>
          ))}
        </span>
      </figcaption>
      <div ref={box} className="relative" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg
          width={width}
          height={CHART_H + 1}
          className="block overflow-visible"
          role="img"
          aria-label={`${spec.title}: ${spec.series
            .map((s, si) => `${s.label} ${last ? formatNumber(last[si] ?? 0) : 'no data yet'}`)
            .join(', ')}`}
        >
          {[0, 0.5, 1].map((f) => (
            <line
              key={f}
              x1={0}
              x2={width}
              y1={y(max * f) + 0.5}
              y2={y(max * f) + 0.5}
              className="stroke-border-strong"
              strokeWidth={1}
            />
          ))}
          <text
            x={0}
            y={PAD_TOP - 1}
            className="fill-fg-subtle font-sans text-[10px]"
            dominantBaseline="auto"
          >
            {formatNumber(max)}
          </text>
          {paths.map((dStr, si) => (
            <path
              key={si}
              d={dStr}
              fill="none"
              stroke={`var(--series-${si + 1})`}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {hover !== null && points[hover] && (
            <>
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={PAD_TOP}
                y2={CHART_H}
                className="stroke-fg-subtle"
                strokeWidth={1}
              />
              {points[hover]!.map((v, si) => (
                <circle
                  key={si}
                  cx={x(hover)}
                  cy={y(v)}
                  r={4}
                  fill={`var(--series-${si + 1})`}
                  className="stroke-bg-base"
                  strokeWidth={2}
                />
              ))}
            </>
          )}
        </svg>
        {hover !== null && (
          <span className="pointer-events-none absolute bottom-1 right-0 font-sans text-[10px] text-fg-subtle">
            {Math.round((Date.now() - samples[hover]!.t) / 1000)}s ago
          </span>
        )}
        {points.filter(Boolean).length < 2 && (
          <span className="absolute inset-0 flex items-center justify-center font-sans text-2xs text-fg-subtle">
            Collecting…
          </span>
        )}
      </div>
    </figure>
  );
}

/** Round up to 1, 2 or 5 × a power of ten so the top gridline reads cleanly. */
function niceMax(v: number): number {
  if (v <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= v)!;
}

const isSelf = (r: Row) => r.self === 't' || r.self === 'true' || r.self === '1';

const ROW_BTN = 'rounded p-1 text-fg-subtle transition hover:bg-surface-2 hover:text-fg-base';

function SectionTable({
  section,
  loaded,
  actions,
}: {
  section: Section;
  loaded: Loaded;
  /** Buttons shown on row hover. */
  actions?: (row: Row) => ReactNode;
}) {
  if (!loaded) return <p className="px-4 py-4 font-sans text-xs text-fg-subtle">Loading…</p>;
  if (loaded.rows === null)
    return <p className="px-4 py-4 font-sans text-xs text-fg-subtle">{loaded.error}</p>;
  if (loaded.rows.length === 0)
    return <p className="px-4 py-4 font-sans text-xs text-fg-subtle">Nothing to show.</p>;
  return (
    <div className="overflow-x-auto px-3 pb-4 pt-1">
      {section.hint && <p className="px-2 pb-1 font-sans text-xs text-fg-subtle">{section.hint}</p>}
      <table className="w-full border-collapse font-sans text-xs">
        <thead>
          <tr className="text-left text-fg-subtle">
            {section.columns.map((c) => (
              <th
                key={c.key}
                className={cn(
                  'whitespace-nowrap px-2 py-1.5 font-normal',
                  c.numeric && 'text-right',
                )}
              >
                {c.label}
              </th>
            ))}
            {actions && <th className="w-16" />}
          </tr>
        </thead>
        <tbody>
          {loaded.rows.map((r, i) => {
            const self = isSelf(r);
            return (
              <tr key={i} className="group border-t border-border-hairline hover:bg-surface-1">
                {section.columns.map((c) => (
                  <td
                    key={c.key}
                    title={c.key === 'query' ? (r[c.key] ?? undefined) : undefined}
                    className={cn(
                      'px-2 py-1.5 text-fg-base/85',
                      c.numeric
                        ? 'whitespace-nowrap text-right tabular-nums'
                        : 'max-w-[28rem] truncate',
                      (c.key === 'query' || c.key === 'name' || c.key === 'index_name') &&
                        'font-mono',
                      r[c.key] === 'waiting' && 'text-status-warn',
                    )}
                  >
                    {formatCell(r[c.key] ?? null, c.format)}
                    {c.key === 'pid' && self && (
                      <span className="ml-1.5 rounded-full bg-surface-2 px-1.5 text-[10px] text-fg-subtle">
                        this view
                      </span>
                    )}
                  </td>
                ))}
                {actions && (
                  <td className="whitespace-nowrap px-2 py-1 text-right">
                    <span className="invisible flex justify-end gap-1 group-focus-within:visible group-hover:visible">
                      {actions(r)}
                    </span>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
