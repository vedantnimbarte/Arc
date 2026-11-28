import { SIDEBAR_VIEW_BY_ID } from '../lib/sidebarViews';
import type { SidebarView } from '../state/files';
import { cn } from '../lib/cn';

/**
 * The name of a sidebar view, drawn the same way in every panel: the view's
 * rail icon plus its rail label, straight from `SIDEBAR_VIEWS` so the panel
 * header and the rail can never disagree.
 *
 * Explorer and Outline deliberately don't use this — their headers name the
 * folder / file on screen, which is more use than a static label.
 */
export function PanelTitle({ view, className }: { view: SidebarView; className?: string }) {
  const { label, Icon } = SIDEBAR_VIEW_BY_ID[view];
  return (
    <span
      className={cn(
        'flex min-w-0 flex-1 select-none items-center gap-2 font-display text-sm font-semibold text-fg-base',
        className,
      )}
    >
      <Icon size={14} strokeWidth={1.9} className="shrink-0 text-fg-muted" />
      <span className="truncate">{label}</span>
    </span>
  );
}
