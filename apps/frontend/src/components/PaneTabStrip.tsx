import { useEffect, useRef, useState } from 'react';
import { Terminal as TerminalIcon, FileCode, Monitor, X } from 'lucide-react';
import { findLeaf, useWorkspace } from '../state/workspace';
import { cn } from '../lib/cn';
import { TabContextMenu } from './TabContextMenu';

interface Props {
  paneId: string;
  /** Visual variant. `leaf` (default) is the per-pane strip with a border
   *  and chrome backdrop. `topbar` is a transparent inline strip used when
   *  the tabs live in the application toolbar. */
  variant?: 'leaf' | 'topbar';
}

/**
 * Per-pane tab strip — renders only the tabs that live in `paneId`'s leaf.
 * Click activates; the X closes; right-click opens the context menu with
 * Rename / Duplicate / Split / Close. The strip opts out of the Tauri
 * window-drag region so dragging a tab won't drag the window (foundation
 * for the CP5 HTML5 drag-drop).
 */
export function PaneTabStrip({ paneId, variant = 'leaf' }: Props) {
  const leaf = useWorkspace((s) => findLeaf(s.layout, paneId));
  const tabs = useWorkspace((s) => s.tabs);
  const tabDirty = useWorkspace((s) => s.tabDirty);
  const setActive = useWorkspace((s) => s.setActive);
  const closeTab = useWorkspace((s) => s.closeTab);
  const renameTab = useWorkspace((s) => s.renameTab);
  const openFile = useWorkspace((s) => s.openFile);
  const newTerminal = useWorkspace((s) => s.newTerminal);
  const setFocusedPane = useWorkspace((s) => s.setFocusedPane);
  const focusedPaneId = useWorkspace((s) => s.focusedPaneId);

  const [contextMenu, setContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(
    null,
  );
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);

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

  return (
    <div
      data-tauri-drag-region="false"
      onMouseDown={() => setFocusedPane(paneId)}
      className={cn(
        'scrollbar-none flex shrink-0 items-center gap-0.5 overflow-x-auto',
        'transition-colors duration-150',
        variant === 'topbar'
          ? 'h-[32px] min-w-0'
          : cn(
              'h-10 border-b px-2',
              isFocused
                ? 'border-border-hairline bg-bg-chrome/30'
                : 'border-border-hairline/60 bg-transparent',
            ),
      )}
    >
      {leaf.tabIds.map((tabId) => {
        const tab = tabs.find((t) => t.id === tabId);
        if (!tab) return null;
        const isActive = tabId === leaf.activeTabId;
        const Icon =
          tab.kind === 'terminal' ? TerminalIcon
          : tab.kind === 'preview' ? Monitor
          : FileCode;
        const dirty = !!tabDirty[tabId];
        const isRenaming = renamingTabId === tabId;
        return (
          <div
            key={tabId}
            draggable
            onDragStart={(e) => {
              // Payload: tabId + the leaf the drag originated in. The drop
              // target uses `arc/tab` as the discriminator in `dataTransfer.types`
              // so it can show its 5-zone overlay during dragover (the actual
              // payload bytes aren't readable until drop).
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData(
                'arc/tab',
                JSON.stringify({ tabId, sourcePaneId: paneId }),
              );
              // Stash a class on the source so it dims while the drag is
              // active. Removed on dragend.
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
            className="group relative shrink-0 data-[dragging=1]:opacity-40"
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
                className={cn(
                  'flex h-[28px] items-center gap-2 rounded-[7px] px-2.5 font-display text-[12px] font-medium tracking-tight transition-all duration-150 ease-apple',
                  isActive
                    ? isFocused
                      ? 'bg-white/[0.11] text-fg-base shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08),0_1px_3px_0_rgba(0,0,0,0.30)]'
                      : 'bg-white/[0.05] text-fg-base/90'
                    : 'text-fg-muted hover:bg-white/[0.05] hover:text-fg-base/90',
                )}
              >
                <Icon
                  size={11}
                  strokeWidth={2.1}
                  className={cn(
                    'shrink-0 transition-colors',
                    isActive && isFocused ? 'text-accent-bright' : 'text-fg-subtle',
                  )}
                />
                <span className="max-w-[140px] truncate">{tab.title}</span>
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
                      'relative ml-0.5 flex h-4 w-4 items-center justify-center rounded-full',
                      'transition-all duration-150 hover:bg-white/15 hover:text-fg-base',
                      dirty
                        ? 'text-accent hover:text-fg-base'
                        : 'text-fg-subtle opacity-0 group-hover:opacity-100',
                    )}
                  >
                    {dirty ? (
                      <>
                        <span className="absolute inset-0 m-auto h-1.5 w-1.5 rounded-full bg-accent shadow-glow-sm transition-opacity duration-150 group-hover:opacity-0" />
                        <X
                          size={9}
                          strokeWidth={2.5}
                          className="opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                        />
                      </>
                    ) : (
                      <X size={9} strokeWidth={2.5} />
                    )}
                  </span>
                ) : dirty ? (
                  <span
                    aria-label="Unsaved changes"
                    title="Unsaved changes"
                    className="relative ml-0.5 flex h-4 w-4 items-center justify-center"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-glow-sm" />
                  </span>
                ) : null}
              </button>
            )}
          </div>
        );
      })}

      {contextMenu && (
        <TabContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          closable={tabs.length > 1}
          onClose={() => setContextMenu(null)}
          onRename={() => setRenamingTabId(contextMenu.tabId)}
          onDuplicate={() => duplicate(contextMenu.tabId)}
          onCloseTab={() => {
            const tab = tabs.find((t) => t.id === contextMenu.tabId);
            if (tab) requestClose(tab.id, tab.title);
          }}
        />
      )}
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
        'h-[28px] w-[160px] rounded-[7px] border border-accent/45 bg-bg-base/80 px-2.5',
        'font-display text-[12px] font-medium tracking-tight text-fg-base',
        'focus:outline-none focus:shadow-focus',
      )}
    />
  );
}
