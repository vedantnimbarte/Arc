import {
  Bot,
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
  { id: 'agents', label: 'Agents', Icon: Bot },
  { id: 'ssh', label: 'SSH', Icon: Server, shortcut: 'toggle-ssh-panel' },
];

/** Lookup by id — convenient for the body switch / customization UI. */
export const SIDEBAR_VIEW_BY_ID: Record<SidebarView, SidebarViewDef> = Object.fromEntries(
  SIDEBAR_VIEWS.map((v) => [v.id, v]),
) as Record<SidebarView, SidebarViewDef>;

/** Explorer is the home view and can't be hidden — there must always be a
 *  fallback the rail/body can show. */
export const PINNED_VIEW: SidebarView = 'files';

// ── Customization helpers (pure — see lib/__tests__/sidebarViews.test.ts) ────

/**
 * Reconcile a persisted order with the live catalogue: keep known ids in the
 * saved order (de-duped), then append any catalogue views the saved order
 * doesn't mention yet (e.g. a newly-shipped view), in their default order.
 */
export function normalizeOrder(order: SidebarView[]): SidebarView[] {
  const known = new Set<SidebarView>(SIDEBAR_VIEWS.map((v) => v.id));
  const seen = new Set<SidebarView>();
  const result: SidebarView[] = [];
  for (const id of order) {
    if (known.has(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  for (const v of SIDEBAR_VIEWS) {
    if (!seen.has(v.id)) result.push(v.id);
  }
  return result;
}

/** The ordered, visible rail views: normalized order minus hidden (Explorer
 *  is always kept). */
export function resolveRailViews(
  order: SidebarView[],
  hidden: SidebarView[],
): SidebarViewDef[] {
  const hiddenSet = new Set(hidden.filter((id) => id !== PINNED_VIEW));
  return normalizeOrder(order)
    .filter((id) => !hiddenSet.has(id))
    .map((id) => SIDEBAR_VIEW_BY_ID[id]);
}

/** Move `id` one slot earlier (-1) or later (+1) within the normalized order. */
export function moveView(
  order: SidebarView[],
  id: SidebarView,
  dir: -1 | 1,
): SidebarView[] {
  const next = normalizeOrder(order);
  const i = next.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= next.length) return next;
  const a = next[i];
  const b = next[j];
  if (a === undefined || b === undefined) return next;
  next[i] = b;
  next[j] = a;
  return next;
}
