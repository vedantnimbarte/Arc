import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Cpu,
  HardDrive,
  MemoryStick,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { systemSnapshot, type SystemSnapshot } from '../lib/tauri';
import { useWorkspace } from '../state/workspace';
import { formatBytes, formatRate } from '../lib/format';

const POPOVER_WIDTH = 340;
const POLL_MS = 1000;

type Tone = 'calm' | 'busy' | 'high';

/**
 * Topbar gauge. Click opens a compact popover styled as a mirror of the
 * detailed System Resources tab: gradient panels with hairline meters, tone
 * badges, an editorial header strip, and a footer CTA to the full view.
 */
export function SystemMonitorButton() {
  const openSystemMonitor = useWorkspace((s) => s.openSystemMonitor);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [snap, setSnap] = useState<SystemSnapshot | null>(null);
  const [lastTick, setLastTick] = useState<number | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const vw = window.innerWidth;
      setPos({
        top: r.bottom + 8,
        right: Math.max(8, vw - r.right),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (popRef.current?.contains(t)) return;
      if (btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const tick = () => {
      void systemSnapshot()
        .then((s) => {
          if (cancelled) return;
          setSnap(s);
          setLastTick(Date.now());
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [open]);

  const ramPct = snap && snap.ram_total_bytes > 0
    ? (snap.ram_used_bytes / snap.ram_total_bytes) * 100
    : 0;
  const diskPct = snap && snap.disk_total_bytes > 0
    ? (snap.disk_used_bytes / snap.disk_total_bytes) * 100
    : 0;

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        className="group flex h-8 w-8 items-center justify-center rounded-md text-fg-muted transition-all duration-200 ease-apple hover:bg-white/[0.08] hover:text-fg-base active:bg-white/[0.12] aria-expanded:bg-white/[0.08] aria-expanded:text-fg-base"
        aria-label="System resources"
        aria-expanded={open}
        aria-haspopup="dialog"
        title="System resources"
      >
        <Activity size={13} strokeWidth={1.9} />
      </button>

      {open && pos && typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label="System resources"
            style={{
              position: 'fixed',
              top: pos.top,
              right: pos.right,
              width: POPOVER_WIDTH,
              zIndex: 1000,
            }}
            className={cn(
              'material-sheet rounded-window overflow-hidden',
              'ring-1 ring-white/[0.10] shadow-sheet',
              'animate-popover-in',
            )}
          >
            {/* Inset top highlight — matches the metric panels in the tab. */}
            <span
              className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.16] to-transparent"
              aria-hidden
            />

            {/* ── Editorial header ───────────────────────────────────── */}
            <div className="flex items-center gap-3 px-4 pt-3.5 pb-3">
              <span className="font-display text-[10px] font-medium uppercase tracking-widest2 text-fg-subtle">
                Activity
              </span>
              <span className="h-px flex-1 bg-gradient-to-r from-border-strong via-border-subtle to-transparent" />
              <span className="flex items-center gap-1.5 font-display text-[10px] uppercase tracking-widest2 text-fg-subtle">
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    lastTick ? 'bg-status-ok animate-pulse-soft' : 'bg-fg-subtle/40',
                  )}
                />
                <span>{lastTick ? 'Live' : 'Idle'}</span>
              </span>
            </div>

            {/* ── Metric grid ────────────────────────────────────────── */}
            <div className="grid grid-cols-2 gap-2 px-3 pb-3">
              <MiniPanel
                icon={<Cpu size={11} strokeWidth={1.8} />}
                label="CPU"
                primary={snap ? snap.cpu_percent.toFixed(0) : '—'}
                unit="%"
                secondary={snap && snap.cpu_count > 0 ? `${snap.cpu_count} cores` : ''}
                ratio={snap ? snap.cpu_percent / 100 : 0}
                tone={pickTone(snap?.cpu_percent ?? 0, 70, 88)}
              />
              <MiniPanel
                icon={<MemoryStick size={11} strokeWidth={1.8} />}
                label="Memory"
                primary={snap ? ramPct.toFixed(0) : '—'}
                unit="%"
                secondary={
                  snap
                    ? `${formatBytes(snap.ram_used_bytes)} / ${formatBytes(snap.ram_total_bytes)}`
                    : ''
                }
                ratio={ramPct / 100}
                tone={pickTone(ramPct, 75, 90)}
              />
              <MiniPanel
                icon={<HardDrive size={11} strokeWidth={1.8} />}
                label="Storage"
                primary={snap ? diskPct.toFixed(0) : '—'}
                unit="%"
                secondary={
                  snap
                    ? `${formatBytes(snap.disk_used_bytes)} / ${formatBytes(snap.disk_total_bytes)}`
                    : ''
                }
                ratio={diskPct / 100}
                tone={pickTone(diskPct, 80, 92)}
              />
              <NetworkMiniPanel
                rx={snap?.net_rx_bytes_per_sec ?? 0}
                tx={snap?.net_tx_bytes_per_sec ?? 0}
                empty={!snap}
              />
            </div>

            {/* ── Footer CTA ─────────────────────────────────────────── */}
            <button
              onClick={() => {
                openSystemMonitor();
                setOpen(false);
              }}
              className={cn(
                'group flex w-full items-center justify-between',
                'border-t border-white/[0.06] bg-white/[0.015]',
                'px-4 py-2.5 text-left transition-colors duration-200 ease-apple',
                'hover:bg-white/[0.05]',
              )}
            >
              <span className="flex items-center gap-2">
                <span className="font-display text-[10px] font-medium uppercase tracking-widest2 text-fg-subtle">
                  View
                </span>
                <span className="font-display text-[12.5px] tracking-tight text-fg-base">
                  Detailed resources
                </span>
              </span>
              <ArrowRight
                size={12}
                strokeWidth={2}
                className="text-fg-subtle transition-transform duration-300 ease-apple group-hover:translate-x-0.5 group-hover:text-fg-base"
              />
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

// ─── Mini panels ──────────────────────────────────────────────────────

interface MiniPanelProps {
  icon: React.ReactNode;
  label: string;
  primary: string;
  unit: string;
  secondary: string;
  ratio: number;
  tone: Tone;
}

function MiniPanel({ icon, label, primary, unit, secondary, ratio, tone }: MiniPanelProps) {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-squircle',
        'bg-gradient-to-b from-white/[0.04] to-white/[0.015]',
        'ring-1 ring-inset ring-white/[0.06]',
      )}
    >
      <span
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.10] to-transparent"
        aria-hidden
      />
      <div className="flex items-center justify-between px-3 pt-2.5">
        <span className="flex items-center gap-1.5 text-fg-subtle">
          <span className="text-fg-muted">{icon}</span>
          <span className="font-display text-[9.5px] font-medium uppercase tracking-widest2">
            {label}
          </span>
        </span>
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            tone === 'high'
              ? 'bg-status-err shadow-[0_0_6px_rgba(255,82,82,0.5)]'
              : tone === 'busy'
              ? 'bg-status-warn'
              : 'bg-fg-subtle/30',
          )}
          aria-hidden
        />
      </div>

      <div className="flex items-baseline gap-1 px-3 pt-1.5">
        <span className="font-display text-[22px] font-medium leading-none tracking-tight tabular-nums text-fg-base">
          {primary}
        </span>
        <span className="font-display text-[11px] font-medium tracking-tight text-fg-muted">
          {unit}
        </span>
      </div>

      <div className="px-3 pt-2">
        <div className="relative h-[2px] overflow-hidden rounded-full bg-white/[0.05]">
          <div
            className={cn(
              'absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-apple',
              toneFill(tone),
            )}
            style={{ width: `${pct}%` }}
          />
          <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-bg-base/40" aria-hidden />
        </div>
      </div>

      <div className="truncate px-3 pb-2.5 pt-1.5 font-mono text-[9.5px] tabular-nums text-fg-subtle/80">
        {secondary || ' '}
      </div>
    </div>
  );
}

function NetworkMiniPanel({ rx, tx, empty }: { rx: number; tx: number; empty: boolean }) {
  const [rxValue, rxUnit] = splitRate(empty ? '—' : formatRate(rx));
  const [txValue, txUnit] = splitRate(empty ? '—' : formatRate(tx));
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-squircle',
        'bg-gradient-to-b from-white/[0.04] to-white/[0.015]',
        'ring-1 ring-inset ring-white/[0.06]',
      )}
    >
      <span
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.10] to-transparent"
        aria-hidden
      />
      <div className="flex items-center justify-between px-3 pt-2.5">
        <span className="font-display text-[9.5px] font-medium uppercase tracking-widest2 text-fg-subtle">
          Network
        </span>
        <span className="font-mono text-[8.5px] uppercase tracking-widest2 text-fg-subtle/70">
          rate
        </span>
      </div>

      <div className="space-y-1.5 px-3 pb-2.5 pt-2">
        <NetMiniRow
          icon={<ArrowDownRight size={9} strokeWidth={2} />}
          color="text-status-ok"
          value={rxValue}
          unit={rxUnit}
        />
        <div className="h-px bg-border-subtle/50" />
        <NetMiniRow
          icon={<ArrowUpRight size={9} strokeWidth={2} />}
          color="text-status-info"
          value={txValue}
          unit={txUnit}
        />
      </div>
    </div>
  );
}

function NetMiniRow({
  icon,
  color,
  value,
  unit,
}: {
  icon: React.ReactNode;
  color: string;
  value: string;
  unit: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className={cn('shrink-0', color)}>{icon}</span>
      <span className="flex items-baseline gap-1 truncate">
        <span className="font-display text-[13px] font-medium leading-none tracking-tight tabular-nums text-fg-base">
          {value}
        </span>
        <span className="font-display text-[9px] uppercase tracking-widest2 text-fg-subtle">
          {unit}
        </span>
      </span>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

function pickTone(value: number, busyAt: number, highAt: number): Tone {
  if (value >= highAt) return 'high';
  if (value >= busyAt) return 'busy';
  return 'calm';
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
  if (display === '—') return ['—', ''];
  const m = display.match(/^(\S+)\s+(.+)$/);
  if (!m) return [display, ''];
  return [m[1]!, m[2]!];
}
