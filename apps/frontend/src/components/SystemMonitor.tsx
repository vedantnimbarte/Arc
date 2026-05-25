import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowDownRight,
  ArrowUp,
  ArrowUpRight,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
  Search,
  XCircle,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { useWorkspace } from '../state/workspace';
import {
  systemProcessesList,
  systemProcessKill,
  systemSnapshot,
  type ProcessInfo,
  type SystemSnapshot,
} from '../lib/tauri';
import { formatBytes, formatRate } from '../lib/format';
import { ProcessContextMenu } from './ProcessContextMenu';

interface Props {
  tabId: string;
}

type SortKey = 'cpu' | 'memory' | 'pid' | 'name';
type SortDir = 'asc' | 'desc';

const POLL_MS = 2000;
const ARM_TIMEOUT_MS = 3000;

/**
 * Full-tab System Resources view. Designed as an "instrument cluster":
 * four oversized live readouts sit above an editorial process table.
 *
 * Polling pauses when the tab isn't the active leaf so a backgrounded view
 * doesn't burn CPU sampling sysinfo for nobody to read.
 */
export function SystemMonitor({ tabId }: Props) {
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const isVisible = activeTabId === tabId;

  const [snap, setSnap] = useState<SystemSnapshot | null>(null);
  const [procs, setProcs] = useState<ProcessInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastTick, setLastTick] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('cpu');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [armedPid, setArmedPid] = useState<number | null>(null);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [killing, setKilling] = useState<number | null>(null);
  // Right-click context menu state. `proc` snapshots the row at click time
  // so the menu identity doesn't shift if the row's stats update mid-open.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; proc: ProcessInfo } | null>(
    null,
  );

  useEffect(() => {
    if (!isVisible) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const [s, p] = await Promise.all([systemSnapshot(), systemProcessesList()]);
        if (cancelled) return;
        setSnap(s);
        setProcs(p);
        setLastTick(Date.now());
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isVisible]);

  useEffect(() => {
    return () => {
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const rows = needle
      ? procs.filter(
          (p) => p.name.toLowerCase().includes(needle) || String(p.pid).includes(needle),
        )
      : procs.slice();
    rows.sort((a, b) => compareProcs(a, b, sortKey, sortDir));
    return rows;
  }, [procs, filter, sortKey, sortDir]);

  // Per-row visual ranking against the *currently visible* set so the
  // inline bars stay meaningful as the user filters and sorts. Cap at p99
  // to keep one stray process from flattening the rest of the column.
  const ranks = useMemo(() => {
    if (filtered.length === 0) return { cpuMax: 1, memMax: 1 };
    const cpus = filtered.map((p) => p.cpu_percent).sort((a, b) => a - b);
    const mems = filtered.map((p) => p.memory_bytes).sort((a, b) => a - b);
    const p = (xs: number[]) => xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.99))] ?? 1;
    return { cpuMax: Math.max(1, p(cpus)), memMax: Math.max(1, p(mems)) };
  }, [filtered]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  };

  const executeKill = (pid: number) => {
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    setArmedPid(null);
    setKilling(pid);
    systemProcessKill(pid)
      .then(() => {
        setProcs((rows) => rows.filter((r) => r.pid !== pid));
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setKilling(null));
  };

  const armKill = (pid: number) => {
    if (armedPid === pid) {
      executeKill(pid);
      return;
    }
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    setArmedPid(pid);
    armTimerRef.current = setTimeout(() => {
      setArmedPid(null);
      armTimerRef.current = null;
    }, ARM_TIMEOUT_MS);
  };

  const ramPct = snap && snap.ram_total_bytes > 0
    ? (snap.ram_used_bytes / snap.ram_total_bytes) * 100
    : 0;
  const diskPct = snap && snap.disk_total_bytes > 0
    ? (snap.disk_used_bytes / snap.disk_total_bytes) * 100
    : 0;

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-bg-base text-fg-base">
      {/* Atmospheric backdrop — the same dot-grid the terminal uses, plus a
          single soft platinum wash to give the page depth. Pointer-events
          off so it never blocks the table. */}
      <div className="dot-grid pointer-events-none absolute inset-0" aria-hidden />
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden
        style={{
          background:
            'radial-gradient(60% 50% at 18% -10%, rgba(200, 210, 225, 0.06) 0%, transparent 60%),' +
            'radial-gradient(50% 50% at 92% 0%, rgba(168, 178, 196, 0.05) 0%, transparent 65%)',
        }}
      />

      <div className="relative z-10 flex h-full flex-col overflow-hidden">
        {/* ── Title bar ─────────────────────────────────────────────── */}
        <header className="flex items-center gap-4 border-b border-border-subtle px-8 pt-7 pb-5">
          <div className="flex flex-1 items-baseline gap-3">
            <span className="font-display text-[10px] font-medium uppercase tracking-widest2 text-fg-subtle">
              Activity
            </span>
            <span className="h-px flex-1 bg-gradient-to-r from-border-strong via-border-subtle to-transparent" />
          </div>
          <div className="flex items-center gap-5 font-display text-[10.5px] uppercase tracking-widest2 text-fg-subtle">
            <span className="flex items-center gap-1.5">
              <span className={cn(
                'h-1.5 w-1.5 rounded-full',
                lastTick ? 'bg-status-ok animate-pulse-soft' : 'bg-fg-subtle/40',
              )} />
              <span>{lastTick ? 'Live' : 'Idle'}</span>
            </span>
            {snap && (
              <span className="tabular-nums">
                {snap.process_count.toLocaleString()} processes
              </span>
            )}
            <span className="tabular-nums">{POLL_MS / 1000}s cadence</span>
          </div>
        </header>

        <h1 className="px-8 pt-2 pb-6 font-display text-[28px] font-medium leading-none tracking-tight text-fg-base">
          System Resources
        </h1>

        {/* ── Instrument cluster ────────────────────────────────────── */}
        <section className="grid grid-cols-1 gap-4 px-8 pb-8 md:grid-cols-2 xl:grid-cols-4">
          <MetricPanel
            icon={<Cpu size={14} strokeWidth={1.8} />}
            label="Processor"
            primary={snap ? `${snap.cpu_percent.toFixed(1)}` : '—'}
            unit="%"
            secondary={snap ? `${snap.cpu_count} logical cores` : ''}
            ratio={snap ? snap.cpu_percent / 100 : 0}
            tone={pickTone(snap?.cpu_percent ?? 0, 70, 88)}
          />
          <MetricPanel
            icon={<MemoryStick size={14} strokeWidth={1.8} />}
            label="Memory"
            primary={snap ? `${ramPct.toFixed(1)}` : '—'}
            unit="%"
            secondary={
              snap
                ? `${formatBytes(snap.ram_used_bytes)} of ${formatBytes(snap.ram_total_bytes)}`
                : ''
            }
            ratio={ramPct / 100}
            tone={pickTone(ramPct, 75, 90)}
          />
          <MetricPanel
            icon={<HardDrive size={14} strokeWidth={1.8} />}
            label="Storage"
            primary={snap ? `${diskPct.toFixed(1)}` : '—'}
            unit="%"
            secondary={
              snap
                ? `${formatBytes(snap.disk_used_bytes)} of ${formatBytes(snap.disk_total_bytes)}`
                : ''
            }
            ratio={diskPct / 100}
            tone={pickTone(diskPct, 80, 92)}
          />
          <NetworkPanel
            rx={snap?.net_rx_bytes_per_sec ?? 0}
            tx={snap?.net_tx_bytes_per_sec ?? 0}
            empty={!snap}
          />
        </section>

        {/* ── Section divider ───────────────────────────────────────── */}
        <div className="flex items-center gap-3 border-t border-border-subtle bg-bg-base/30 px-8 pt-6 pb-3">
          <span className="font-display text-[10px] font-medium uppercase tracking-widest2 text-fg-subtle">
            Processes
          </span>
          <span className="font-mono text-[10.5px] tabular-nums text-fg-subtle/60">
            {filtered.length.toLocaleString()}
          </span>
          <span className="h-px flex-1 bg-gradient-to-r from-border-subtle via-border-subtle/40 to-transparent" />
          <div className="relative w-72">
            <Search
              size={11}
              strokeWidth={2}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle"
            />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name or PID"
              spellCheck={false}
              className={cn(
                'w-full rounded-full bg-white/[0.03] py-1.5 pl-8 pr-3',
                'font-display text-[12px] text-fg-base placeholder:text-fg-subtle/60',
                'ring-1 ring-inset ring-white/[0.06]',
                'transition-all duration-200 ease-apple',
                'focus:bg-white/[0.06] focus:outline-none focus:ring-white/[0.14] focus:shadow-glow-sm',
              )}
            />
          </div>
        </div>

        {error && (
          <div className="mx-8 -mb-2 mt-3 rounded-md bg-red-500/[0.06] px-3 py-2 font-mono text-[11px] text-status-err ring-1 ring-red-400/20">
            {error}
          </div>
        )}

        {/* ── Process table ─────────────────────────────────────────── */}
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-6">
          <table className="w-full border-separate border-spacing-0 text-left font-display text-[12.5px]">
            <thead className="sticky top-0 z-10">
              <tr className="text-[10px] uppercase tracking-widest2 text-fg-subtle">
                <HeaderCell
                  label="PID"
                  active={sortKey === 'pid'}
                  dir={sortDir}
                  onClick={() => toggleSort('pid')}
                  className="w-24 px-4 pb-3 pt-2 text-right"
                  align="right"
                />
                <HeaderCell
                  label="Process"
                  active={sortKey === 'name'}
                  dir={sortDir}
                  onClick={() => toggleSort('name')}
                  className="px-4 pb-3 pt-2"
                  align="left"
                />
                <HeaderCell
                  label="CPU"
                  active={sortKey === 'cpu'}
                  dir={sortDir}
                  onClick={() => toggleSort('cpu')}
                  className="w-44 px-4 pb-3 pt-2 text-right"
                  align="right"
                />
                <HeaderCell
                  label="Memory"
                  active={sortKey === 'memory'}
                  dir={sortDir}
                  onClick={() => toggleSort('memory')}
                  className="w-52 px-4 pb-3 pt-2 text-right"
                  align="right"
                />
                <th className="w-36 px-4 pb-3 pt-2 font-medium text-fg-subtle/80">User</th>
                <th className="w-32 px-4 pb-3 pt-2 text-right font-medium text-fg-subtle/80">
                  Action
                </th>
              </tr>
              <tr aria-hidden>
                <td colSpan={6} className="p-0">
                  <div className="h-px bg-gradient-to-r from-transparent via-border-subtle to-transparent" />
                </td>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-16 text-center font-display text-[12px] text-fg-subtle"
                  >
                    {procs.length === 0 ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="h-1 w-1 animate-pulse-soft rounded-full bg-accent" />
                        <span className="h-1 w-1 animate-pulse-soft rounded-full bg-accent" style={{ animationDelay: '0.2s' }} />
                        <span className="h-1 w-1 animate-pulse-soft rounded-full bg-accent" style={{ animationDelay: '0.4s' }} />
                        <span className="ml-2 tracking-widest2 uppercase text-[10px]">Sampling</span>
                      </span>
                    ) : (
                      <span className="tracking-widest2 uppercase text-[10px]">No matches</span>
                    )}
                  </td>
                </tr>
              ) : (
                filtered.map((p) => (
                  <ProcessRow
                    key={p.pid}
                    proc={p}
                    cpuMax={ranks.cpuMax}
                    memMax={ranks.memMax}
                    armed={armedPid === p.pid}
                    killing={killing === p.pid}
                    onKill={() => armKill(p.pid)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setCtxMenu({ x: e.clientX, y: e.clientY, proc: p });
                    }}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {ctxMenu && (
        <ProcessContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          proc={ctxMenu.proc}
          onClose={() => setCtxMenu(null)}
          onEnd={() => executeKill(ctxMenu.proc.pid)}
          onFilter={(name) => setFilter(name)}
        />
      )}
    </div>
  );
}

// ─── Metric panels ────────────────────────────────────────────────────

interface MetricPanelProps {
  icon: React.ReactNode;
  label: string;
  /** The big number, e.g. "42.1". Unit rendered separately so it can be smaller. */
  primary: string;
  unit: string;
  secondary: string;
  /** 0..1 — drives the meter fill width. */
  ratio: number;
  /** Color tone for the meter when load is healthy / busy / critical. */
  tone: Tone;
}

function MetricPanel({ icon, label, primary, unit, secondary, ratio, tone }: MetricPanelProps) {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-window',
        'bg-gradient-to-b from-white/[0.04] to-white/[0.015]',
        'ring-1 ring-inset ring-white/[0.06]',
        'shadow-soft',
        'transition-all duration-300 ease-apple',
        'hover:ring-white/[0.10]',
      )}
    >
      {/* Inset top highlight — same trick the Apple chrome uses. */}
      <span
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.12] to-transparent"
        aria-hidden
      />
      <div className="flex items-center justify-between px-5 pt-5">
        <span className="flex items-center gap-2 text-fg-subtle">
          <span className="text-fg-muted">{icon}</span>
          <span className="font-display text-[10px] font-medium uppercase tracking-widest2">
            {label}
          </span>
        </span>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-widest2',
            toneBadge(tone),
          )}
        >
          {toneLabel(tone)}
        </span>
      </div>

      <div className="flex items-baseline gap-1.5 px-5 pt-4">
        <span className="font-display text-[44px] font-medium leading-none tracking-tight tabular-nums text-fg-base">
          {primary}
        </span>
        <span className="font-display text-[16px] font-medium tracking-tight text-fg-muted">
          {unit}
        </span>
      </div>

      {/* Meter bar — thin and elegant. The track is a hairline; the fill
          is a soft gradient that picks up the tone color. */}
      <div className="mt-5 px-5">
        <div className="relative h-[3px] overflow-hidden rounded-full bg-white/[0.05]">
          <div
            className={cn(
              'absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-apple',
              toneFill(tone),
            )}
            style={{ width: `${pct}%` }}
          />
          {/* Tick marks — a row of faint hairlines at 25 / 50 / 75% to give
              the bar a sense of scale without competing with the fill. */}
          <div className="pointer-events-none absolute inset-y-0 left-1/4 w-px bg-bg-base/40" aria-hidden />
          <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-bg-base/40" aria-hidden />
          <div className="pointer-events-none absolute inset-y-0 left-3/4 w-px bg-bg-base/40" aria-hidden />
        </div>
      </div>

      <div className="flex items-center justify-between px-5 pb-5 pt-3 font-mono text-[10.5px] tabular-nums text-fg-subtle">
        <span className="truncate">{secondary || '—'}</span>
      </div>
    </div>
  );
}

function NetworkPanel({ rx, tx, empty }: { rx: number; tx: number; empty: boolean }) {
  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-window',
        'bg-gradient-to-b from-white/[0.04] to-white/[0.015]',
        'ring-1 ring-inset ring-white/[0.06]',
        'shadow-soft',
        'transition-all duration-300 ease-apple',
        'hover:ring-white/[0.10]',
      )}
    >
      <span
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.12] to-transparent"
        aria-hidden
      />
      <div className="flex items-center justify-between px-5 pt-5">
        <span className="flex items-center gap-2 text-fg-subtle">
          <span className="text-fg-muted">
            <Network size={14} strokeWidth={1.8} />
          </span>
          <span className="font-display text-[10px] font-medium uppercase tracking-widest2">
            Network
          </span>
        </span>
        <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fg-subtle/70">
          throughput
        </span>
      </div>

      {/* Two-stack readout: download on top, upload below. Each row pairs a
          big monospaced number with a small directional glyph. */}
      <div className="mt-3 space-y-2.5 px-5 pb-5">
        <NetRow
          icon={<ArrowDownRight size={11} strokeWidth={2} />}
          label="Down"
          rate={empty ? null : rx}
          color="text-status-ok"
        />
        <div className="h-px bg-border-subtle/60" />
        <NetRow
          icon={<ArrowUpRight size={11} strokeWidth={2} />}
          label="Up"
          rate={empty ? null : tx}
          color="text-status-info"
        />
      </div>
    </div>
  );
}

function NetRow({
  icon,
  label,
  rate,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  rate: number | null;
  color: string;
}) {
  const display = rate == null ? '—' : formatRate(rate);
  const [value, unit] = splitRate(display);
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-1.5 font-display text-[10px] uppercase tracking-widest2 text-fg-subtle">
        <span className={color}>{icon}</span>
        {label}
      </span>
      <span className="flex items-baseline gap-1">
        <span className="font-display text-[20px] font-medium leading-none tracking-tight tabular-nums text-fg-base">
          {value}
        </span>
        <span className="font-display text-[10.5px] uppercase tracking-widest2 text-fg-subtle">
          {unit}
        </span>
      </span>
    </div>
  );
}

// ─── Process row ──────────────────────────────────────────────────────

interface ProcessRowProps {
  proc: ProcessInfo;
  cpuMax: number;
  memMax: number;
  armed: boolean;
  killing: boolean;
  onKill: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

function ProcessRow({
  proc,
  cpuMax,
  memMax,
  armed,
  killing,
  onKill,
  onContextMenu,
}: ProcessRowProps) {
  const cpuRatio = cpuMax > 0 ? Math.min(1, proc.cpu_percent / cpuMax) : 0;
  const memRatio = memMax > 0 ? Math.min(1, proc.memory_bytes / memMax) : 0;

  return (
    <tr className="group relative" onContextMenu={onContextMenu}>
      <td className="relative whitespace-nowrap px-4 py-3 text-right font-mono text-[11px] tabular-nums text-fg-subtle">
        {/* Left-edge accent on hover — instrument-panel feel. */}
        <span
          className="pointer-events-none absolute left-0 top-1/2 h-6 w-px -translate-y-1/2 scale-y-0 bg-accent/70 transition-transform duration-300 ease-apple group-hover:scale-y-100"
          aria-hidden
        />
        {proc.pid}
      </td>
      <td className="max-w-0 truncate px-4 py-3 font-display text-fg-base group-hover:text-fg-base">
        <div className="flex items-center gap-2.5">
          <ProcessGlyph name={proc.name} />
          <span className="truncate">{proc.name}</span>
        </div>
      </td>
      <td className="px-4 py-3 text-right">
        <InlineMeter value={`${proc.cpu_percent.toFixed(1)}%`} ratio={cpuRatio} />
      </td>
      <td className="px-4 py-3 text-right">
        <InlineMeter value={formatBytes(proc.memory_bytes)} ratio={memRatio} />
      </td>
      <td className="truncate px-4 py-3 font-mono text-[11px] text-fg-subtle">
        {proc.user ?? '—'}
      </td>
      <td className="px-4 py-3 text-right">
        <button
          onClick={onKill}
          disabled={killing}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-display text-[10.5px]',
            'ring-1 ring-inset transition-all duration-200 ease-apple',
            armed
              ? 'bg-red-500/[0.14] text-red-200 ring-red-400/40 shadow-[0_0_0_4px_rgba(239,68,68,0.12)]'
              : 'text-fg-subtle ring-transparent hover:bg-white/[0.05] hover:text-fg-base hover:ring-white/[0.08]',
            killing && 'opacity-50',
          )}
          title={armed ? 'Click again to confirm' : 'End process'}
        >
          <XCircle size={10.5} strokeWidth={2} />
          <span className="tracking-tight">
            {killing ? 'Ending…' : armed ? 'Confirm' : 'End'}
          </span>
        </button>
      </td>
    </tr>
  );
}

function InlineMeter({ value, ratio }: { value: string; ratio: number }) {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <div className="flex items-center justify-end gap-3">
      {/* Right-anchored bar so it visually points at the value. The
          value sits to the right in tabular numerics for easy scanning. */}
      <div className="relative h-[2px] w-20 overflow-hidden rounded-full bg-white/[0.05]">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-accent/70 transition-[width] duration-500 ease-apple"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-20 font-mono text-[11px] tabular-nums text-fg-muted">{value}</span>
    </div>
  );
}

/**
 * A deterministic 2-letter monogram derived from the process name. Saves us
 * from shipping per-process icons but still gives each row visual anchoring.
 * The hue is hashed from the name so the same process keeps the same chip
 * color across refreshes.
 */
function ProcessGlyph({ name }: { name: string }) {
  const cleaned = name.replace(/\.exe$/i, '');
  const initials = cleaned
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('') || cleaned.slice(0, 2).toUpperCase();

  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  // Desaturated, low-luminance — keeps the chips in the platinum family.
  const bg = `hsla(${hue}, 22%, 62%, 0.10)`;
  const fg = `hsla(${hue}, 28%, 78%, 0.92)`;

  return (
    <span
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md ring-1 ring-inset ring-white/[0.05] font-display text-[9.5px] font-medium tracking-tight"
      style={{ background: bg, color: fg }}
    >
      {initials}
    </span>
  );
}

// ─── Header cell ──────────────────────────────────────────────────────

interface HeaderCellProps {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  className?: string;
  align: 'left' | 'right';
}

function HeaderCell({ label, active, dir, onClick, className, align }: HeaderCellProps) {
  return (
    <th className={cn('font-medium', className)}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'inline-flex items-center gap-1.5 transition-colors duration-200 ease-apple hover:text-fg-base',
          active ? 'text-fg-base' : 'text-fg-subtle/80',
          align === 'right' && 'flex-row-reverse',
        )}
      >
        <span className="tracking-widest2">{label}</span>
        {active && (
          <span className="text-accent">
            {dir === 'asc' ? (
              <ArrowUp size={9} strokeWidth={2.5} />
            ) : (
              <ArrowDown size={9} strokeWidth={2.5} />
            )}
          </span>
        )}
      </button>
    </th>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

type Tone = 'calm' | 'busy' | 'high';

function pickTone(value: number, busyAt: number, highAt: number): Tone {
  if (value >= highAt) return 'high';
  if (value >= busyAt) return 'busy';
  return 'calm';
}

function toneLabel(tone: Tone): string {
  switch (tone) {
    case 'high':
      return 'High';
    case 'busy':
      return 'Busy';
    case 'calm':
      return 'Nominal';
  }
}

function toneBadge(tone: Tone): string {
  switch (tone) {
    case 'high':
      return 'bg-status-err/[0.12] text-status-err ring-1 ring-inset ring-status-err/30';
    case 'busy':
      return 'bg-status-warn/[0.10] text-status-warn ring-1 ring-inset ring-status-warn/25';
    case 'calm':
      return 'bg-white/[0.04] text-fg-subtle ring-1 ring-inset ring-white/[0.05]';
  }
}

function toneFill(tone: Tone): string {
  switch (tone) {
    case 'high':
      return 'bg-gradient-to-r from-status-err/70 to-status-err';
    case 'busy':
      return 'bg-gradient-to-r from-status-warn/70 to-status-warn';
    case 'calm':
      return 'bg-gradient-to-r from-accent-muted to-accent-bright';
  }
}

function splitRate(display: string): [string, string] {
  // formatRate gives e.g. "1.20 MB/s" — split the unit so the number can
  // dominate visually and the unit sits small next to it.
  const m = display.match(/^(\S+)\s+(.+)$/);
  if (!m) return [display, ''];
  return [m[1]!, m[2]!];
}

function compareProcs(a: ProcessInfo, b: ProcessInfo, key: SortKey, dir: SortDir): number {
  let cmp = 0;
  switch (key) {
    case 'cpu':
      cmp = a.cpu_percent - b.cpu_percent;
      break;
    case 'memory':
      cmp = a.memory_bytes - b.memory_bytes;
      break;
    case 'pid':
      cmp = a.pid - b.pid;
      break;
    case 'name':
      cmp = a.name.localeCompare(b.name);
      break;
  }
  return dir === 'asc' ? cmp : -cmp;
}
