import type { ReactNode } from 'react';
import {
  Columns3,
  Eye,
  FolderTree,
  KeyRound,
  ListTree,
  Table2,
  type LucideIcon,
} from 'lucide-react';
import type { DbSafety } from '../../lib/tauri';
import { cn } from '../../lib/cn';

/**
 * Shared chrome for the database client, in an IDE's vocabulary: dense tool
 * windows, icon toolbars split into groups, typed object icons, a status bar.
 *
 * The one loud thing is the environment colour. A production connection paints
 * its toolbar stripe, console tabs and status dot red; read-only paints them
 * amber; a normal one stays neutral. That colour is what stops a `DELETE` in
 * the wrong window, so it's the only saturated chrome here.
 */

export interface Env {
  color: string;
  label: string;
}

/** The connection's environment colour, derived from its safety level. */
export function envOf(safety: DbSafety | undefined): Env | null {
  if (safety === 'production') return { color: '#ff5252', label: 'Production' };
  if (safety === 'readonly') return { color: '#f0a958', label: 'Read-only' };
  return null;
}

// ─── Toolbar ──────────────────────────────────────────────────────────────────

export function ToolButton({
  icon: Icon,
  label,
  onClick,
  active,
  disabled,
  tone,
  children,
  spin,
}: {
  icon: LucideIcon;
  /** Tooltip and accessible name. */
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  /** `run` is the green ▶, `stop` the red ■. */
  tone?: 'run' | 'stop';
  /** Optional visible text after the icon. */
  children?: ReactNode;
  spin?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={children ? undefined : label}
      aria-pressed={active}
      className={cn(
        'flex h-6 shrink-0 items-center gap-1 rounded font-display text-xs transition-colors',
        children ? 'px-1.5' : 'w-6 justify-center',
        'focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none disabled:opacity-35',
        active ? 'bg-surface-3 text-fg-base' : 'text-fg-muted hover:bg-surface-2 hover:text-fg-base',
      )}
    >
      <Icon
        size={13}
        strokeWidth={tone ? 2.4 : 2}
        className={cn(
          'shrink-0',
          tone === 'run' && 'fill-status-ok/80 text-status-ok',
          tone === 'stop' && 'fill-status-err/80 text-status-err',
          spin && 'animate-spin',
        )}
      />
      {children}
    </button>
  );
}

export function ToolSep() {
  return <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-edge-2" />;
}

/** A thin bar of tool buttons. `env` paints the stripe along its top edge. */
export function Toolbar({ children, env, className }: { children: ReactNode; env?: Env | null; className?: string }) {
  return (
    <div
      className={cn('relative flex h-9 shrink-0 items-center gap-0.5 border-b border-edge-1 px-2', className)}
      style={env ? { boxShadow: `inset 0 2px 0 ${env.color}` } : undefined}
    >
      {children}
    </div>
  );
}

// ─── Tool windows ─────────────────────────────────────────────────────────────

/** A tool window's title row: tabs or a title on the left, actions right. */
export function ToolWindowHeader({
  children,
  actions,
  className,
}: {
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex h-8 shrink-0 items-center gap-1 border-b border-edge-1 bg-surface-1 px-2',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">{children}</div>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}

/** A tab inside a tool window header. */
export function ToolTab({
  icon: Icon,
  active,
  onClick,
  children,
  count,
}: {
  icon?: LucideIcon;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'relative flex h-8 shrink-0 items-center gap-1.5 px-2.5 font-display text-xs transition-colors',
        'focus-visible:outline-none focus-visible:shadow-focus',
        active ? 'text-fg-base' : 'text-fg-subtle hover:text-fg-muted',
      )}
    >
      {Icon && <Icon size={12} strokeWidth={2} className={active ? 'text-accent-bright' : undefined} />}
      {children}
      {count != null && <span className="font-mono text-2xs tabular-nums text-fg-subtle">{count}</span>}
      <span
        aria-hidden
        className={cn('absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-accent', active ? 'opacity-100' : 'opacity-0')}
      />
    </button>
  );
}

/** A tool window title (no tabs): icon, name in mono, a muted subtitle. */
export function ToolTitle({ icon: Icon, title, subtitle }: { icon: LucideIcon; title: ReactNode; subtitle?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 px-1">
      <Icon size={12} strokeWidth={2} className="shrink-0 text-fg-subtle" />
      <span className="truncate font-mono text-xs font-medium text-fg-base">{title}</span>
      {subtitle && <span className="truncate font-display text-2xs text-fg-subtle">{subtitle}</span>}
    </span>
  );
}

// ─── Objects ──────────────────────────────────────────────────────────────────

export type ObjKind = 'schema' | 'table' | 'view' | 'column' | 'pk' | 'fk' | 'index';

const OBJ: Record<ObjKind, { icon: LucideIcon; color: string }> = {
  schema: { icon: FolderTree, color: '#9aa3b2' },
  table: { icon: Table2, color: '#5ea4ff' },
  view: { icon: Eye, color: '#62c99a' },
  column: { icon: Columns3, color: '#9aa3b2' },
  pk: { icon: KeyRound, color: '#e8b339' },
  fk: { icon: KeyRound, color: '#a493ff' },
  index: { icon: ListTree, color: '#3ec6c0' },
};

/** The icon a database IDE would draw for this kind of object. */
export function ObjIcon({ kind, size = 12 }: { kind: ObjKind; size?: number }) {
  const { icon: Icon, color } = OBJ[kind];
  return <Icon size={size} strokeWidth={2} className="shrink-0" style={{ color }} aria-hidden />;
}

// ─── Status bar ───────────────────────────────────────────────────────────────

export function StatusBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-6 shrink-0 items-center gap-3 overflow-hidden border-t border-edge-1 bg-surface-1 px-3 font-display text-2xs text-fg-subtle">
      {children}
    </div>
  );
}

/** A coloured dot: the environment, or a neutral one when there's none. */
export function EnvDot({ env, on = true }: { env: Env | null; on?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn('h-2 w-2 shrink-0 rounded-full', !env && (on ? 'bg-status-ok' : 'bg-fg-subtle'))}
      style={env ? { backgroundColor: env.color, opacity: on ? 1 : 0.5 } : undefined}
    />
  );
}

/** A small rounded badge in the environment colour. */
export function EnvBadge({ env }: { env: Env }) {
  return (
    <span
      className="shrink-0 rounded px-1 font-display text-[10px] font-semibold leading-4"
      style={{ color: env.color, backgroundColor: `${env.color}22`, boxShadow: `inset 0 0 0 1px ${env.color}44` }}
    >
      {env.label}
    </span>
  );
}

/** Empty or loading centre of a tool window. */
export function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-[8rem] flex-col items-center justify-center gap-2 px-6 text-center font-display text-xs text-fg-subtle">
      {children}
    </div>
  );
}

/** Text buttons used in tool windows, matching the toolbar's weight. */
export const textBtn =
  'flex h-6 shrink-0 items-center gap-1 rounded px-2 font-display text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none disabled:opacity-35';
export const primaryBtn =
  'flex h-6 shrink-0 items-center gap-1 rounded bg-accent px-2.5 font-display text-xs font-semibold text-bg-base transition-colors hover:bg-accent-bright focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none disabled:opacity-35';
export const inputCls =
  'h-7 rounded bg-surface-1 px-2 font-mono text-xs text-fg-base ring-1 ring-inset ring-edge-2 placeholder:text-fg-subtle/70 focus:outline-none focus:ring-accent/60';
