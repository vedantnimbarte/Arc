import {
  FolderTree,
  GitBranch,
  ListTree,
  Search,
  Server,
  type LucideIcon,
} from 'lucide-react';
import type { SidebarView } from '../state/files';
import type { ActionId } from '../state/shortcuts';

/**
 * Single source of truth for the sidebar activity rail. Both the horizontal
 * rail (expanded) and the vertical mini-rail (collapsed) render from this
 * list, so adding a view is one entry here plus a branch in `Sidebar`'s body
 * switch.
 */
export interface SidebarViewDef {
  id: SidebarView;
  label: string;
  Icon: LucideIcon;
  /** Action whose binding reveals this view — surfaced in tooltips. Optional;
   *  views without a global shortcut just tooltip their label. */
  shortcut?: ActionId;
}

/** The full catalogue, in default order. User order/visibility is layered on
 *  top by the sidebar layout store. */
export const SIDEBAR_VIEWS: SidebarViewDef[] = [
  { id: 'files', label: 'Explorer', Icon: FolderTree, shortcut: 'show-explorer' },
  { id: 'git', label: 'Source Control', Icon: GitBranch, shortcut: 'show-source-control' },
  { id: 'search', label: 'Search', Icon: Search },
  { id: 'outline', label: 'Outline', Icon: ListTree },
  { id: 'ssh', label: 'SSH', Icon: Server, shortcut: 'toggle-ssh-panel' },
];

/** Lookup by id — convenient for the body switch / customization UI. */
export const SIDEBAR_VIEW_BY_ID: Record<SidebarView, SidebarViewDef> = Object.fromEntries(
  SIDEBAR_VIEWS.map((v) => [v.id, v]),
) as Record<SidebarView, SidebarViewDef>;
