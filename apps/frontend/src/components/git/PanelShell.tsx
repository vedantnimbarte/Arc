import type { ReactNode } from 'react';

/**
 * Chrome for the worktree / rebase panels. They render as a centred modal in
 * the standalone git window, and as a plain section when embedded in the
 * source control sidebar — same body either way, only the frame changes.
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
      <div className="flex min-h-0 flex-1 flex-col border-b border-border-hairline bg-surface-1/40">
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
