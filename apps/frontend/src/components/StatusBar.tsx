import { Suspense, lazy, useState } from 'react';
import {
  BellRing,
  CircleDollarSign,
  Radio,
  Gauge,
  Command as CommandIcon,
  FolderOpen,
  type LucideIcon,
} from 'lucide-react';
import type { BranchPickerAnchor } from './BranchPicker';
import { useFiles } from '../state/files';
import { useSettings } from '../state/settings';
import { useWorkspace } from '../state/workspace';
import { useUsage } from '../state/usage';
import type { PlanLimit } from '../lib/usage';
import { runCommand } from '../state/commands';
import { formatBinding, getBinding } from '../state/shortcuts';
import { cn } from '../lib/cn';

const UsagePopover = lazy(() =>
  import('./UsagePopover').then((m) => ({ default: m.UsagePopover })),
);

/**
 * Thin strip along the bottom of the window: which folder you're in, what
 * wants your attention, and a permanent pointer at ⌘K.
 *
 * ARC used to carry a much heavier status bar (breadcrumbs, shell picker,
 * branch switcher — see commit a9e77ed) and it was removed for good reason.
 * This is deliberately not that: it is the app's only always-visible surface
 * that answers "where am I", and every item is a shortcut to the sidebar view
 * that owns it, so it teaches the layout rather than duplicating it.
 */
export function StatusBar() {
  const root = useFiles((s) => s.root);
  const showSidebarView = useFiles((s) => s.showSidebarView);
  const paletteKbd = formatBinding(getBinding('open-command-palette'));
  const broadcastInput = useWorkspace((s) => s.broadcastInput);
  const waitingCount = useWorkspace((s) => Object.keys(s.agentWaiting).length);
  const waitingTitle = useWorkspace((s) =>
    Object.keys(s.agentWaiting)
      .map((id) => s.tabs.find((t) => t.id === id)?.title)
      .filter(Boolean)
      .join(', '),
  );
  const usageAgents = useSettings((s) => s.usageAgents);
  const usageSelectedId = useUsage((s) => s.selectedId);
  const usageResults = useUsage((s) => s.results);
  const [usageAnchor, setUsageAnchor] = useState<BranchPickerAnchor | null>(null);
  const usageAgent = usageAgents.find((a) => a.id === usageSelectedId) ?? usageAgents[0] ?? null;
  const usageResult = usageAgent ? usageResults[usageAgent.id] : undefined;
  const usageCost = usageResult?.summary?.rows.find((r) => /cost/i.test(r.label))?.value;
  // The limit closest to full is the one that will stop you first.
  const topLimit = usageResult?.limits?.reduce<PlanLimit | undefined>(
    (top, l) => (!top || l.percent > top.percent ? l : top),
    undefined,
  );

  return (
    <footer className="material-toolbar flex h-6 shrink-0 items-center gap-1 border-t border-border-hairline px-2 font-display text-2xs text-fg-muted">
      {/* Folder — the answer to "what am I even looking at". With no root
          picked yet this is the call to action instead. */}
      <Item
        icon={FolderOpen}
        onClick={() => (root ? showSidebarView('files') : void runCommand('workspace.open-folder'))}
        label={root ? basename(root) : 'Open a folder…'}
        title={root ?? 'Choose the folder to work in'}
        accent={!root}
      />

      <div className="flex-1" />

      {/* Agents that stopped and want you. Clicking walks to the one that has
          waited longest; typing into it clears it. */}
      {waitingCount > 0 && (
        <Item
          icon={BellRing}
          onClick={() => void runCommand('shortcut.next-waiting-agent')}
          label={`${waitingCount} waiting`}
          title={`Waiting on you: ${waitingTitle}`}
          accent
        />
      )}

      {/* Loud on purpose: typing into every terminal at once is exactly the
          mode you must not forget you're in. */}
      {broadcastInput && (
        <Item
          icon={Radio}
          onClick={() => useWorkspace.getState().toggleBroadcastInput()}
          label="Broadcasting"
          title="Keystrokes go to every terminal in this workspace — click to stop"
          danger
        />
      )}

      {usageAgents.length > 0 && (
        <Item
          icon={topLimit ? Gauge : CircleDollarSign}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setUsageAnchor({ x: r.left, y: r.top, placement: 'above' });
          }}
          label={topLimit ? `${Math.round(topLimit.percent)}%` : (usageCost ?? 'Usage')}
          title={topLimit ? `${topLimit.label}: ${Math.round(topLimit.percent)}% used` : 'Agent token & credit usage'}
          warn={topLimit?.severity === 'warning'}
          danger={topLimit?.severity === 'critical'}
        />
      )}

      {/* The one thing every new user needs to know. Deliberately spelled out
          rather than left as a bare glyph. */}
      <Item
        icon={CommandIcon}
        onClick={() => void runCommand('shortcut.open-command-palette')}
        label="Commands"
        title="Search every action in ARC"
      >
        <kbd className="font-mono text-fg-subtle">{paletteKbd}</kbd>
      </Item>

      <Suspense fallback={null}>
        {usageAnchor && <UsagePopover anchor={usageAnchor} onClose={() => setUsageAnchor(null)} />}
      </Suspense>
    </footer>
  );
}

/** Last path segment of a path, forward or back slashes. */
function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function Item({
  icon: Icon,
  label,
  title,
  onClick,
  accent,
  danger,
  warn,
  children,
}: {
  icon: LucideIcon;
  label: string;
  title: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** Draw attention — used for the "no folder yet" call to action. */
  accent?: boolean;
  /** Tint the whole pill for something that needs attention now — e.g. an
   *  unresolved merge conflict. No extra width, unlike a text badge. */
  danger?: boolean;
  /** Softer than `danger` — something approaching a limit. */
  warn?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex h-[18px] max-w-[240px] items-center gap-1.5 rounded px-1.5 transition-colors',
        'hover:bg-surface-2 hover:text-fg-base',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
        danger ? 'text-status-err' : warn ? 'text-status-warn' : accent && 'text-accent-bright',
      )}
    >
      <Icon size={11} strokeWidth={2} className="shrink-0" />
      {/* min-w-0: a flex child's default min-width is its content's intrinsic
          width, which defeats `truncate` entirely — this is what let a long
          branch name shove the sibling badge into wrapping instead of
          ellipsizing. */}
      <span className="min-w-0 truncate">{label}</span>
      {children}
    </button>
  );
}
