import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ChevronRight,
  FileCode,
  GitCompare,
  Monitor,
  Send,
  Server,
  Terminal as TerminalIcon,
  X,
  type LucideIcon,
} from 'lucide-react';
import { findLeaf, useWorkspace, type Tab, type TabGroup } from '../state/workspace';
import { cn } from '../lib/cn';
import { TabContextMenu, type GroupOption } from './TabContextMenu';
import { TabGroupMenu } from './TabGroupMenu';
import { groupColorTokens, type GroupColorTokens } from '../lib/tabGroups';

interface Props {
  paneId: string;
  /** Visual variant. `leaf` (default) is the per-pane strip with a border
   *  and chrome backdrop. `topbar` is a transparent inline strip used when
   *  the tabs live in the application toolbar. */
  variant?: 'leaf' | 'topbar';
}

/** Per-kind glyph. Each tab kind gets a distinct icon so the strip is
 *  scannable at a glance — terminals, editors, previews, API clients, SSH
 *  sessions and diffs all read differently. */
function iconForKind(kind: Tab['kind']): LucideIcon {
  switch (kind) {
    case 'terminal':
      return TerminalIcon;
    case 'preview':
      return Monitor;
    case 'apiclient':
      return Send;
    case 'ssh':
      return Server;
    case 'diff':
      return GitCompare;
    default:
      return FileCode;
  }
}

/** One render unit in the strip: either a free tab or a run of tabs that
 *  share a group (always contiguous thanks to the store's normalization). */
type Segment =
  | { type: 'tab'; tab: Tab }
  | { type: 'group'; group: TabGroup; members: Tab[] };

/**
 * Per-pane tab strip — renders only the tabs that live in `paneId`'s leaf.
 * Click activates; the X closes; right-click opens the context menu with
 * Rename / Duplicate / grouping / Close. Tabs that belong to a group are
 * wrapped in a collapsible colour-coded container (Chrome-style grouping).
 * The strip opts out of the Tauri window-drag region so dragging a tab won't
 * drag the window.
 */
export function PaneTabStrip({ paneId, variant = 'leaf' }: Props) {
  const leaf = useWorkspace((s) => findLeaf(s.layout, paneId));
  const tabs = useWorkspace((s) => s.tabs);
  const tabGroups = useWorkspace((s) => s.tabGroups);
  const tabDirty = useWorkspace((s) => s.tabDirty);
  const setActive = useWorkspace((s) => s.setActive);
  const closeTab = useWorkspace((s) => s.closeTab);
  const renameTab = useWorkspace((s) => s.renameTab);
  const openFile = useWorkspace((s) => s.openFile);
  const newTerminal = useWorkspace((s) => s.newTerminal);
  const setFocusedPane = useWorkspace((s) => s.setFocusedPane);
  const focusedPaneId = useWorkspace((s) => s.focusedPaneId);
  const groupTabs = useWorkspace((s) => s.groupTabs);
  const addTabToGroup = useWorkspace((s) => s.addTabToGroup);
  const removeTabFromGroup = useWorkspace((s) => s.removeTabFromGroup);
  const toggleGroupCollapsed = useWorkspace((s) => s.toggleGroupCollapsed);

  const [contextMenu, setContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(
    null,
  );
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [groupMenu, setGroupMenu] = useState<{ groupId: string; x: number; y: number } | null>(
    null,
  );

  if (!leaf) return null;
  const isFocused = paneId === focusedPaneId;

  const requestClose = (id: string, title: string) => {
    // Refuse if this is the last tab in the workspace — closeTab in the
    // store has the same guard, but no-op here keeps the dirty-confirm
    // prompt from firing pointlessly.
    if (tabs.length <= 1) return;
    if (tabDirty[id]) {
      const ok = window.confirm(`"${title}" has unsaved changes. Discard them?`);
      if (!ok) return;
    }
    closeTab(id);
  };

  const duplicate = (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.kind === 'editor' && tab.filePath) {
      openFile(tab.filePath, tab.title, { forceNew: true });
      return;
    }
    if (tab.kind === 'preview') {
      useWorkspace.getState().openPreview(tab.previewUrl);
      return;
    }
    // Terminal: spawn a fresh shell with the same shellOverride. We use
    // `newTerminal` so the new tab inherits the standard setup (root reset,
    // unique id) — losing `shellOverride` would defeat the duplicate, so
    // pass it through explicitly.
    void newTerminal({ title: tab.title, shellOverride: tab.shellOverride });
  };

  // ─── Build the render segments from the leaf's ordered tab ids ──────────
  const tabById = new Map(tabs.map((t) => [t.id, t]));
  const groupById = new Map(tabGroups.map((g) => [g.id, g]));
  const segments: Segment[] = [];
  for (const id of leaf.tabIds) {
    const tab = tabById.get(id);
    if (!tab) continue;
    const group = tab.groupId ? groupById.get(tab.groupId) : undefined;
    if (!group) {
      segments.push({ type: 'tab', tab });
      continue;
    }
    const last = segments[segments.length - 1];
    if (last && last.type === 'group' && last.group.id === group.id) {
      last.members.push(tab);
    } else {
      segments.push({ type: 'group', group, members: [tab] });
    }
  }

  /** Groups in this leaf a given tab could be moved into (excludes its own). */
  const groupOptionsFor = (tabId: string): GroupOption[] => {
    const tab = tabById.get(tabId);
    const seen = new Set<string>();
    const out: GroupOption[] = [];
    for (const id of leaf.tabIds) {
      const gid = tabById.get(id)?.groupId;
      if (!gid || gid === tab?.groupId || seen.has(gid)) continue;
      const g = groupById.get(gid);
      if (!g) continue;
      seen.add(gid);
      out.push({ id: g.id, name: g.name, color: g.color });
    }
    return out;
  };

  // ─── The tab pill ───────────────────────────────────────────────────────
  const renderPill = (tab: Tab, groupTokens?: GroupColorTokens) => {
    const tabId = tab.id;
    const isActive = tabId === leaf.activeTabId;
    const Icon = iconForKind(tab.kind);
    const dirty = !!tabDirty[tabId];
    const isRenaming = renamingTabId === tabId;
    // Active member of a group → tint with the group hue instead of the
    // neutral white wash, so the selection reads as "inside this group".
    const groupActive = isActive && isFocused && !!groupTokens;

    return (
      <div
        key={tabId}
        draggable
        onDragStart={(e) => {
          // Payload: tabId + the leaf the drag originated in. The drop target
          // uses `arc/tab` as the discriminator in `dataTransfer.types`.
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('arc/tab', JSON.stringify({ tabId, sourcePaneId: paneId }));
          (e.currentTarget as HTMLElement).dataset.dragging = '1';
        }}
        onDragEnd={(e) => {
          delete (e.currentTarget as HTMLElement).dataset.dragging;
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setFocusedPane(paneId);
          setActive(tabId);
          setContextMenu({ tabId, x: e.clientX, y: e.clientY });
        }}
        className="group/tab relative shrink-0 data-[dragging=1]:opacity-40"
      >
        {isRenaming ? (
          <RenameInput
            initial={tab.title}
            onCommit={(value) => {
              const trimmed = value.trim();
              if (trimmed) renameTab(tabId, trimmed);
              setRenamingTabId(null);
            }}
            onCancel={() => setRenamingTabId(null)}
          />
        ) : (
          <button
            onClick={() => {
              setFocusedPane(paneId);
              setActive(tabId);
            }}
            onDoubleClick={() => setRenamingTabId(tabId)}
            style={
              groupActive
                ? {
                    background: groupTokens!.activeBg,
                    boxShadow: `inset 0 0 0 1px ${groupTokens!.wrapBorder}`,
                  }
                : undefined
            }
            className={cn(
              'flex h-[34px] min-w-[124px] max-w-[228px] items-center gap-2.5 rounded-lg px-3',
              'font-display text-[13px] font-medium tracking-tight transition-all duration-150 ease-apple',
              groupActive
                ? 'text-fg-base'
                : isActive
                  ? isFocused
                    ? 'bg-white/[0.11] text-fg-base shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08),0_1px_3px_0_rgba(0,0,0,0.30)]'
                    : 'bg-white/[0.05] text-fg-base/90'
                  : 'text-fg-muted hover:bg-white/[0.05] hover:text-fg-base/90',
            )}
          >
            <Icon
              size={14}
              strokeWidth={2}
              style={groupActive ? { color: groupTokens!.text } : undefined}
              className={cn(
                'shrink-0 transition-colors',
                !groupActive && (isActive && isFocused ? 'text-accent-bright' : 'text-fg-subtle'),
              )}
            />
            <span className="flex-1 truncate text-left">{tab.title}</span>
            {tabs.length > 1 ? (
              <span
                role="button"
                tabIndex={0}
                aria-label={dirty ? 'Close tab (unsaved changes)' : 'Close tab'}
                onClick={(e) => {
                  e.stopPropagation();
                  requestClose(tabId, tab.title);
                }}
                className={cn(
                  'relative -mr-1 ml-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full',
                  'transition-all duration-150 hover:bg-white/15 hover:text-fg-base',
                  dirty
                    ? 'text-accent hover:text-fg-base'
                    : 'text-fg-subtle opacity-0 group-hover/tab:opacity-100',
                )}
              >
                {dirty ? (
                  <>
                    <span className="absolute inset-0 m-auto h-1.5 w-1.5 rounded-full bg-accent shadow-glow-sm transition-opacity duration-150 group-hover/tab:opacity-0" />
                    <X
                      size={10}
                      strokeWidth={2.5}
                      className="opacity-0 transition-opacity duration-150 group-hover/tab:opacity-100"
                    />
                  </>
                ) : (
                  <X size={10} strokeWidth={2.5} />
                )}
              </span>
            ) : dirty ? (
              <span
                aria-label="Unsaved changes"
                title="Unsaved changes"
                className="relative -mr-1 ml-0.5 flex h-[18px] w-[18px] items-center justify-center"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-glow-sm" />
              </span>
            ) : null}
          </button>
        )}
      </div>
    );
  };

  return (
    <div
      data-tauri-drag-region="false"
      onMouseDown={() => setFocusedPane(paneId)}
      className={cn(
        'scrollbar-none flex shrink-0 items-center gap-1 overflow-x-auto',
        'transition-colors duration-150',
        variant === 'topbar'
          ? 'h-[40px] min-w-0'
          : cn(
              'h-11 border-b px-2',
              isFocused
                ? 'border-border-hairline bg-bg-chrome/30'
                : 'border-border-hairline/60 bg-transparent',
            ),
      )}
    >
      {segments.map((seg) => {
        if (seg.type === 'tab') return renderPill(seg.tab);
        const tokens = groupColorTokens(seg.group.color);
        return (
          <GroupContainer
            key={seg.group.id}
            group={seg.group}
            count={seg.members.length}
            tokens={tokens}
            active={seg.members.some((m) => m.id === leaf.activeTabId) && isFocused}
            onToggle={() => toggleGroupCollapsed(seg.group.id)}
            onOpenMenu={(x, y) => setGroupMenu({ groupId: seg.group.id, x, y })}
          >
            {seg.members.map((m) => renderPill(m, tokens))}
          </GroupContainer>
        );
      })}

      {contextMenu && (
        <TabContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          closable={tabs.length > 1}
          inGroup={!!tabById.get(contextMenu.tabId)?.groupId}
          groupOptions={groupOptionsFor(contextMenu.tabId)}
          onClose={() => setContextMenu(null)}
          onRename={() => setRenamingTabId(contextMenu.tabId)}
          onDuplicate={() => duplicate(contextMenu.tabId)}
          onNewGroup={() => groupTabs([contextMenu.tabId])}
          onAddToGroup={(groupId) => addTabToGroup(contextMenu.tabId, groupId)}
          onRemoveFromGroup={() => removeTabFromGroup(contextMenu.tabId)}
          onCloseTab={() => {
            const tab = tabs.find((t) => t.id === contextMenu.tabId);
            if (tab) requestClose(tab.id, tab.title);
          }}
        />
      )}

      {groupMenu &&
        (() => {
          const group = tabGroups.find((g) => g.id === groupMenu.groupId);
          if (!group) return null;
          return (
            <TabGroupMenu
              x={groupMenu.x}
              y={groupMenu.y}
              group={group}
              onClose={() => setGroupMenu(null)}
            />
          );
        })()}
    </div>
  );
}

/** The colour-coded shell around a group's tabs. A rail across the top paints
 *  the group's roof in its hue, so a run of tabs reads as one banded unit. The
 *  header chip toggles collapse on click and opens the group menu on double /
 *  right click; collapsing animates the member run closed (grid-fr width
 *  transition) while a count badge fades in to stand in for the hidden tabs. */
function GroupContainer({
  group,
  count,
  tokens,
  active,
  onToggle,
  onOpenMenu,
  children,
}: {
  group: TabGroup;
  count: number;
  tokens: GroupColorTokens;
  active: boolean;
  onToggle: () => void;
  onOpenMenu: (x: number, y: number) => void;
  children?: ReactNode;
}) {
  const chipRef = useRef<HTMLButtonElement>(null);
  const collapsed = group.collapsed;
  const named = !!group.name.trim();
  const openMenuAtChip = () => {
    const r = chipRef.current?.getBoundingClientRect();
    if (r) onOpenMenu(r.left, r.bottom + 4);
  };
  return (
    <div
      className={cn(
        'relative flex h-[36px] shrink-0 items-center rounded-[12px] px-1',
        'transition-shadow duration-200 ease-apple',
      )}
      style={{
        background: tokens.wrapBg,
        // Layered insets, front-to-back: the coloured roof rail always shows;
        // the full hairline ring + ambient bloom only when the group is active.
        boxShadow: [
          `inset 0 2px 0 0 ${tokens.rail}`,
          `inset 0 0 0 1px ${active ? tokens.wrapBorder : 'transparent'}`,
          active ? `0 0 16px -7px ${tokens.railGlow}` : '',
        ]
          .filter(Boolean)
          .join(', '),
      }}
    >
      <button
        ref={chipRef}
        type="button"
        onClick={onToggle}
        onDoubleClick={(e) => {
          e.preventDefault();
          openMenuAtChip();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onOpenMenu(e.clientX, e.clientY);
        }}
        title={group.name.trim() || 'Tab group'}
        aria-expanded={!collapsed}
        className={cn(
          'group/chip flex h-[26px] shrink-0 items-center gap-1.5 rounded-[8px] px-2',
          'font-display text-[12px] font-semibold tracking-tight transition-colors',
          'focus:outline-none',
        )}
        style={{ background: tokens.chipBg, color: tokens.text }}
        onMouseEnter={(e) => (e.currentTarget.style.background = tokens.chipBgHover)}
        onMouseLeave={(e) => (e.currentTarget.style.background = tokens.chipBg)}
      >
        {/* Dot ⇄ chevron: the dot is the resting glyph; on hover it yields to a
            chevron that rotates flat when expanded, hinting the toggle. */}
        <span className="relative grid h-2.5 w-2.5 shrink-0 place-items-center" aria-hidden>
          <span
            className="col-start-1 row-start-1 h-2 w-2 rounded-full transition-opacity duration-150 group-hover/chip:opacity-0"
            style={{ background: tokens.solid }}
          />
          <ChevronRight
            size={11}
            strokeWidth={2.75}
            className={cn(
              'col-start-1 row-start-1 opacity-0 transition-all duration-200 ease-apple group-hover/chip:opacity-100',
              collapsed ? 'rotate-0' : 'rotate-90',
            )}
          />
        </span>
        {named && <span className="max-w-[140px] truncate">{group.name}</span>}
        {/* Count badge — width/opacity animate so it slides in as the run
            collapses, rather than popping. */}
        <span
          aria-hidden={!collapsed}
          className={cn(
            'flex h-[15px] items-center justify-center overflow-hidden rounded-full',
            'text-[10.5px] font-bold tabular-nums transition-all duration-300 ease-apple',
            collapsed ? 'ml-0.5 min-w-[15px] px-1.5 opacity-100' : 'ml-0 w-0 px-0 opacity-0',
          )}
          style={{ background: tokens.chipBorder, color: tokens.text }}
        >
          {count}
        </span>
      </button>

      {/* Member run — the grid-fr trick collapses width smoothly. The inner
          flex carries the spacing so a collapsed group leaves no dangling gap. */}
      <div
        aria-hidden={collapsed}
        className={cn(
          'grid min-w-0 transition-[grid-template-columns,opacity] duration-300 ease-apple',
          collapsed ? 'grid-cols-[0fr] opacity-0' : 'grid-cols-[1fr] opacity-100',
        )}
      >
        <div
          className={cn(
            'flex min-w-0 items-center gap-1 overflow-hidden pl-1',
            collapsed && 'pointer-events-none',
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** Inline rename input. Autofocuses, commits on Enter / blur, cancels on
 *  Escape. Sized to match the tab pill so the strip doesn't reflow when
 *  rename mode toggles on. */
function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      className={cn(
        'h-[34px] w-[180px] rounded-lg border border-accent/45 bg-bg-base/80 px-3',
        'font-display text-[13px] font-medium tracking-tight text-fg-base',
        'focus:outline-none focus:shadow-focus',
      )}
    />
  );
}
