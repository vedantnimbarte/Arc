import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Chrome for the worktree / rebase panels. They render as a centred modal in
 * the standalone git window, and as a plain section when embedded in the
 * source control sidebar, where it is one capped-height collapsible section
 * among the others — same body either way, only the frame changes.
 */
export function PanelShell({
  inline,
  width,
  onClose,
  children,
}: {
  inline: boolean;
  /** Sheet width in the modal form; ignored inline (the sidebar sets it). */
  width: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (inline) {
    return (
      <div className="flex max-h-64 min-h-0 shrink-0 flex-col border-t border-border-hairline bg-surface-1/40">
        {children}
      </div>
    );
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-scrim-2 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width }}
        className="material-sheet mt-[8vh] flex max-w-[94vw] animate-sheet-in flex-col overflow-hidden rounded-window shadow-sheet ring-1 ring-edge-2"
      >
        {children}
      </div>
    </div>
  );
}

/**
 * A panel's title. Inline it doubles as the section's collapse control, so an
 * open git tool closes the same way stash / tags / remotes do — click the row,
 * not a close button off in the corner.
 */
export function PanelHeading({
  inline,
  onCollapse,
  children,
}: {
  inline: boolean;
  onCollapse: () => void;
  children: ReactNode;
}) {
  if (!inline) {
    return (
      <div className="flex items-center gap-2 font-display text-sm font-semibold tracking-tight text-fg-base">
        {children}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onCollapse}
      aria-expanded
      title="Collapse"
      className="-ml-0.5 flex min-w-0 flex-1 items-center gap-1.5 rounded py-0.5 text-left font-sans text-xs tracking-tight text-fg-muted transition-colors hover:text-fg-base"
    >
      <ChevronDown size={10} strokeWidth={2} className="shrink-0 text-fg-subtle" />
      {children}
    </button>
  );
}
