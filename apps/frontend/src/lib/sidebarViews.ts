import { FolderTree, GitBranch, Server, type LucideIcon } from 'lucide-react';
import type { SidebarView } from '../state/files';
import type { ActionId } from '../state/shortcuts';

/**
 * Single source of truth for the sidebar activity rail. Both the horizontal
 * rail (expanded) and the vertical mini-rail (collapsed) render from this
 * list, so a future view — Search, Outline, an Agents panel — only needs a
 * new entry here plus a branch in `Sidebar`'s body switch.
 */
export interface SidebarViewDef {
  id: SidebarView;
  label: string;
  Icon: LucideIcon;
  /** Action whose binding reveals this view — surfaced in tooltips. */
  shortcut: ActionId;
}

export const SIDEBAR_VIEWS: SidebarViewDef[] = [
  { id: 'files', label: 'Explorer', Icon: FolderTree, shortcut: 'show-explorer' },
  { id: 'git', label: 'Source Control', Icon: GitBranch, shortcut: 'show-source-control' },
  { id: 'ssh', label: 'SSH', Icon: Server, shortcut: 'toggle-ssh-panel' },
];
