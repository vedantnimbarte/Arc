import { useCallback, useRef } from 'react';
import {
  Columns2,
  Rows2,
  X as XIcon,
} from 'lucide-react';
import { Terminal } from './Terminal';
import { useWorkspace, type PaneNode, type SplitPath, type Tab } from '../state/workspace';
import { cn } from '../lib/cn';

interface Props {
  tab: Tab;
}

/** Renders the pane tree of a terminal tab. Splits become a flex row /
 *  column with a draggable hairline between children; leaves render the
 *  real Terminal. The active leaf is outlined with a 1px accent and shows
 *  a small split/close toolbar in its top-right corner. */
export function TerminalPanes({ tab }: Props) {
  const tree = tab.paneTree ?? { kind: 'leaf' as const, id: tab.id };
  const activeId = tab.activePaneId ?? firstLeaf(tree);
  const setActivePane = useWorkspace((s) => s.setActivePane);
  const splitActivePane = useWorkspace((s) => s.splitActivePane);
  const closeActivePane = useWorkspace((s) => s.closeActivePane);

  return (
    <PaneRenderer
      node={tree}
      path={[]}
      tabId={tab.id}
      activePaneId={activeId}
      onFocus={(paneId) => setActivePane(tab.id, paneId)}
      onSplit={(direction) => splitActivePane(tab.id, direction)}
      onClose={() => closeActivePane(tab.id)}
    />
  );
}

interface RendererProps {
  node: PaneNode;
  path: SplitPath;
  tabId: string;
  activePaneId: string;
  onFocus: (paneId: string) => void;
  onSplit: (direction: 'horizontal' | 'vertical') => void;
  onClose: () => void;
}

function PaneRenderer({
  node,
  path,
  tabId,
  activePaneId,
  onFocus,
  onSplit,
  onClose,
}: RendererProps) {
  if (node.kind === 'leaf') {
    const isActive = node.id === activePaneId;
    return (
      <div
        className={cn(
          'relative h-full w-full overflow-hidden rounded-[6px] transition-shadow duration-150 ease-apple',
          isActive
            ? 'ring-1 ring-inset ring-accent/40 shadow-glow-sm'
            : 'ring-1 ring-inset ring-transparent',
        )}
      >
        <Terminal
          sessionKey={node.id}
          paneId={node.id}
          tabId={tabId}
          onFocus={() => onFocus(node.id)}
        />
        {isActive && (
          <PaneToolbar onSplit={onSplit} onClose={onClose} />
        )}
      </div>
    );
  }

  const isRow = node.direction === 'vertical'; // vertical split = side-by-side
  const aFlex = node.ratio;
  const bFlex = 1 - node.ratio;

  return (
    <div
      className={cn('flex h-full w-full', isRow ? 'flex-row' : 'flex-col')}
    >
      <div style={{ flexBasis: 0, flexGrow: aFlex, minWidth: 0, minHeight: 0 }}>
        <PaneRenderer
          node={node.a}
          path={[...path, 'a']}
          tabId={tabId}
          activePaneId={activePaneId}
          onFocus={onFocus}
          onSplit={onSplit}
          onClose={onClose}
        />
      </div>
      <SplitSeparator
        tabId={tabId}
        path={path}
        direction={node.direction}
        ratio={node.ratio}
      />
      <div style={{ flexBasis: 0, flexGrow: bFlex, minWidth: 0, minHeight: 0 }}>
        <PaneRenderer
          node={node.b}
          path={[...path, 'b']}
          tabId={tabId}
          activePaneId={activePaneId}
          onFocus={onFocus}
          onSplit={onSplit}
          onClose={onClose}
        />
      </div>
    </div>
  );
}

function PaneToolbar({
  onSplit,
  onClose,
}: {
  onSplit: (direction: 'horizontal' | 'vertical') => void;
  onClose: () => void;
}) {
  return (
    <div
      className="pointer-events-auto absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5 rounded-md border border-white/[0.06] bg-bg-base/70 px-0.5 py-0.5 backdrop-blur-md transition-opacity duration-150 ease-apple"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <ToolbarButton
        label="Split vertical (side-by-side)"
        onClick={() => onSplit('vertical')}
      >
        <Columns2 size={11} strokeWidth={1.9} />
      </ToolbarButton>
      <ToolbarButton
        label="Split horizontal (stacked)"
        onClick={() => onSplit('horizontal')}
      >
        <Rows2 size={11} strokeWidth={1.9} />
      </ToolbarButton>
      <div className="mx-0.5 h-3 w-px bg-white/[0.06]" aria-hidden />
      <ToolbarButton label="Close pane" onClick={onClose} danger>
        <XIcon size={11} strokeWidth={2.2} />
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  children,
  label,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'flex h-5 w-5 items-center justify-center rounded text-fg-muted transition-colors',
        danger ? 'hover:bg-status-err/20 hover:text-status-err' : 'hover:bg-white/[0.08] hover:text-fg-base',
      )}
    >
      {children}
    </button>
  );
}

function SplitSeparator({
  tabId,
  path,
  direction,
  ratio,
}: {
  tabId: string;
  path: SplitPath;
  direction: 'horizontal' | 'vertical';
  ratio: number;
}) {
  const dragRef = useRef<{ startPx: number; startRatio: number; total: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const sep = e.currentTarget as HTMLElement;
      const container = sep.parentElement;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const total = direction === 'vertical' ? rect.width : rect.height;
      const startPx = direction === 'vertical' ? e.clientX : e.clientY;
      dragRef.current = { startPx, startRatio: ratio, total };
      document.body.style.cursor = direction === 'vertical' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';

      const onMove = (ev: PointerEvent) => {
        const state = dragRef.current;
        if (!state) return;
        const now = direction === 'vertical' ? ev.clientX : ev.clientY;
        const delta = (now - state.startPx) / state.total;
        useWorkspace.getState().setSplitRatio(tabId, path, state.startRatio + delta);
      };
      const onUp = () => {
        dragRef.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    },
    [direction, path, ratio, tabId],
  );

  const onDoubleClick = useCallback(() => {
    useWorkspace.getState().setSplitRatio(tabId, path, 0.5);
  }, [path, tabId]);

  const isVertical = direction === 'vertical';
  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      role="separator"
      aria-orientation={isVertical ? 'vertical' : 'horizontal'}
      title="Drag to resize · double-click to reset"
      className={cn(
        'group relative z-10 shrink-0 select-none',
        isVertical
          ? '-mx-[3px] w-[6px] cursor-col-resize'
          : '-my-[3px] h-[6px] cursor-row-resize',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute bg-transparent transition-colors duration-150 group-hover:bg-accent/60 group-active:bg-accent',
          isVertical
            ? 'left-1/2 top-0 h-full w-px -translate-x-1/2'
            : 'left-0 top-1/2 h-px w-full -translate-y-1/2',
        )}
      />
    </div>
  );
}

function firstLeaf(node: PaneNode): string {
  return node.kind === 'leaf' ? node.id : firstLeaf(node.a);
}
