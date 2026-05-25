import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Copy,
  FileText,
  Filter,
  Hash,
  Type,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/cn';
import type { ProcessInfo } from '../lib/tauri';
import { formatBytes } from '../lib/format';

interface Props {
  /** Anchor coords — `e.clientX/Y` from the contextmenu event. */
  x: number;
  y: number;
  proc: ProcessInfo;
  onClose: () => void;
  onEnd: () => void;
  onFilter: (name: string) => void;
}

const MENU_WIDTH = 248;

/**
 * Right-click menu for a process row. Identity header at the top doubles
 * as a quick read-out of the process's vitals so the menu itself is
 * informational — you don't have to remember which row you clicked on.
 */
export function ProcessContextMenu({ x, y, proc, onClose, onEnd, onFilter }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  // Clamp inside the viewport. Measured after mount so a menu near the
  // bottom-right edge flips back to fit.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (nx + r.width > window.innerWidth - 8) {
      nx = Math.max(8, window.innerWidth - r.width - 8);
    }
    if (ny + r.height > window.innerHeight - 8) {
      ny = Math.max(8, window.innerHeight - r.height - 8);
    }
    setPos({ left: nx, top: ny });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (rootRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Also dismiss on a second right-click anywhere — the parent will mount
    // a fresh menu at the new coords.
    const onContext = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (rootRef.current?.contains(t!)) return;
      onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('contextmenu', onContext, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('contextmenu', onContext, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* Clipboard API can refuse in dev frames; the menu still closes. */
    }
  };

  const details = `${proc.pid}\t${proc.name}\t${proc.cpu_percent.toFixed(1)}%\t${formatBytes(proc.memory_bytes)}`;

  return createPortal(
    <div
      ref={rootRef}
      role="menu"
      aria-label={`Actions for ${proc.name}`}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        width: MENU_WIDTH,
        zIndex: 9999,
      }}
      className={cn(
        'material-sheet rounded-window overflow-hidden',
        'ring-1 ring-white/[0.10] shadow-sheet',
        'animate-popover-in',
      )}
    >
      {/* Identity header — mirrors the editorial Activity strip from the
          detailed-view tab so the menu reads as part of the same surface. */}
      <div className="relative px-3.5 pt-3 pb-2.5">
        <span
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.12] to-transparent"
          aria-hidden
        />
        <div className="flex items-baseline gap-2">
          <span className="font-display text-[9.5px] font-medium uppercase tracking-widest2 text-fg-subtle">
            Process
          </span>
          <span className="font-mono text-[10px] tabular-nums text-fg-subtle/70">
            #{proc.pid}
          </span>
          <span className="ml-auto font-mono text-[10px] tabular-nums text-fg-subtle/70">
            {proc.cpu_percent.toFixed(1)}% · {formatBytes(proc.memory_bytes)}
          </span>
        </div>
        <div
          className="mt-1 truncate font-display text-[13px] font-medium tracking-tight text-fg-base"
          title={proc.name}
        >
          {proc.name}
        </div>
      </div>

      <div className="h-px bg-gradient-to-r from-transparent via-border-subtle to-transparent" />

      <div className="p-1">
        <MenuItem
          icon={Filter}
          label="Filter to this process"
          onClick={() => {
            onFilter(proc.name);
            onClose();
          }}
        />
        <MenuItem
          icon={Hash}
          label="Copy PID"
          shortcut={String(proc.pid)}
          onClick={() => {
            void copy(String(proc.pid));
            onClose();
          }}
        />
        <MenuItem
          icon={Type}
          label="Copy name"
          onClick={() => {
            void copy(proc.name);
            onClose();
          }}
        />
        <MenuItem
          icon={FileText}
          label="Copy details"
          onClick={() => {
            void copy(details);
            onClose();
          }}
        />
        <MenuItem
          icon={Copy}
          label="Copy as JSON"
          onClick={() => {
            void copy(JSON.stringify(proc, null, 2));
            onClose();
          }}
        />
      </div>

      <div className="h-px bg-gradient-to-r from-transparent via-border-subtle to-transparent" />

      <div className="p-1">
        <MenuItem
          icon={XCircle}
          label="End process"
          danger
          onClick={() => {
            onEnd();
            onClose();
          }}
        />
      </div>
    </div>,
    document.body,
  );
}

function MenuItem({
  icon: Icon,
  label,
  shortcut,
  onClick,
  danger,
}: {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'group flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left',
        'font-display text-[12px] tracking-tight transition-colors duration-150 ease-apple',
        danger
          ? 'text-fg-base hover:bg-status-err/[0.12] hover:text-status-err'
          : 'text-fg-base hover:bg-white/[0.06]',
        'focus-visible:bg-white/[0.06] focus:outline-none',
      )}
    >
      <Icon
        size={12}
        strokeWidth={2}
        className={cn(
          'shrink-0',
          danger ? 'text-status-err/80 group-hover:text-status-err' : 'text-fg-muted',
        )}
      />
      <span className="flex-1 truncate">{label}</span>
      {shortcut && (
        <span className="font-mono text-[10px] tabular-nums text-fg-subtle/70 group-hover:text-fg-subtle">
          {shortcut}
        </span>
      )}
    </button>
  );
}
