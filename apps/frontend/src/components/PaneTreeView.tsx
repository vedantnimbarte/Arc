import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import { Terminal as TerminalIcon } from 'lucide-react';
import { findLeaf, useWorkspace, type PaneNode, type PaneSplit } from '../state/workspace';
import { PaneLeafView } from './PaneLeafView';
import { PaneHeader } from './PaneHeader';
import { cn } from '../lib/cn';

interface Props {
  /** Shared host-div registry held by App.tsx so this tree can hand each
   *  visible leaf the right host node to reparent. */
  hostsRef: React.MutableRefObject<Map<string, HTMLDivElement>>;
  stageRef: React.RefObject<HTMLDivElement>;
}

/**
 * Renders the workspace's full pane tree. Splits become `react-resizable-panels`
 * Groups; leaves get a tab strip plus a content slot that DOM-reparents the
 * active tab's host div in.
 */
export function PaneTreeView({ hostsRef, stageRef }: Props) {
  const layout = useWorkspace((s) => s.layout);
  const newTerminal = useWorkspace((s) => s.newTerminal);
  const maximizedPaneId = useWorkspace((s) => s.maximizedPaneId);

  // Closing/moving the last tab can leave the active workspace with an empty
  // leaf — offer a way back instead of a blank pane.
  if (layout.kind === 'leaf' && layout.tabIds.length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-center">
        <TerminalIcon size={26} strokeWidth={1.5} className="text-fg-subtle" />
        <div className="font-display text-[13px] text-fg-muted">This workspace is empty</div>
        <button
          onClick={() => void newTerminal()}
          className="rounded-md bg-accent/90 px-3 py-1.5 font-display text-[11.5px] font-medium text-bg-base transition-colors hover:bg-accent"
        >
          New terminal
        </button>
      </div>
    );
  }

  // Maximize: when a leaf is zoomed (and still exists in this workspace),
  // render only it, full-size — grid-style.
  const maxLeaf = maximizedPaneId ? findLeaf(layout, maximizedPaneId) : null;
  if (maxLeaf) {
    return (
      <PaneLeafView
        paneId={maxLeaf.id}
        hostsRef={hostsRef}
        stageRef={stageRef}
        header={<PaneHeader paneId={maxLeaf.id} />}
      />
    );
  }

  // Every leaf shows its own strip — it carries the tab list plus the
  // split/close controls, and there's no tab strip in the app toolbar.
  return (
    <PaneNodeView node={layout} hostsRef={hostsRef} stageRef={stageRef} showHeader />
  );
}

function PaneNodeView({
  node,
  hostsRef,
  stageRef,
  showHeader,
}: {
  node: PaneNode;
  hostsRef: React.MutableRefObject<Map<string, HTMLDivElement>>;
  stageRef: React.RefObject<HTMLDivElement>;
  showHeader: boolean;
}) {
  if (node.kind === 'leaf') {
    return (
      <PaneLeafView
        paneId={node.id}
        hostsRef={hostsRef}
        stageRef={stageRef}
        header={showHeader ? <PaneHeader paneId={node.id} /> : null}
      />
    );
  }
  // Split → render a Group. We key on the split's id so React rebuilds the
  // group when the structure changes (avoids the library's internal panel-
  // id bookkeeping getting confused by mid-tree edits).
  return (
    <SplitGroupView
      node={node}
      hostsRef={hostsRef}
      stageRef={stageRef}
      showHeader={showHeader}
    />
  );
}

function SplitGroupView({
  node,
  hostsRef,
  stageRef,
  showHeader,
}: {
  node: PaneSplit;
  hostsRef: React.MutableRefObject<Map<string, HTMLDivElement>>;
  stageRef: React.RefObject<HTMLDivElement>;
  showHeader: boolean;
}) {
  const setSplitSizes = useWorkspace((s) => s.setSplitSizes);
  // `Layout` from the library is a `Record<panelId, sizePct>`. We mapped each
  // Panel id to the child node's id, so this trivially round-trips to the
  // store's `PaneSplit.sizes` indexed by child order.
  const onLayoutChanged = (layout: Layout) => {
    const sizes = node.children.map((c) => layout[c.id] ?? 0);
    setSplitSizes(node.id, sizes);
  };
  return (
    <Group
      key={node.id}
      orientation={node.direction}
      onLayoutChanged={onLayoutChanged}
      className={cn('h-full w-full', node.direction === 'horizontal' ? 'flex-row' : 'flex-col')}
    >
      {node.children.map((child, idx) => (
        <SplitChild
          key={child.id}
          child={child}
          direction={node.direction}
          isLast={idx === node.children.length - 1}
          defaultSize={node.sizes[idx] ?? 100 / node.children.length}
          hostsRef={hostsRef}
          stageRef={stageRef}
          showHeader={showHeader}
        />
      ))}
    </Group>
  );
}

function SplitChild({
  child,
  direction,
  isLast,
  defaultSize,
  hostsRef,
  stageRef,
  showHeader,
}: {
  child: PaneNode;
  direction: 'horizontal' | 'vertical';
  isLast: boolean;
  defaultSize: number;
  hostsRef: React.MutableRefObject<Map<string, HTMLDivElement>>;
  stageRef: React.RefObject<HTMLDivElement>;
  showHeader: boolean;
}) {
  return (
    <>
      <Panel id={child.id} defaultSize={defaultSize} minSize={10} className="min-h-0 min-w-0">
        <PaneNodeView
          node={child}
          hostsRef={hostsRef}
          stageRef={stageRef}
          showHeader={showHeader}
        />
      </Panel>
      {!isLast && (
        <Separator
          className={cn(
            'group relative shrink-0 rounded-full bg-transparent transition-colors duration-150',
            // A small gap between panes; a rounded accent pill appears on hover
            // / drag so the resize affordance reads without a heavy divider.
            direction === 'horizontal'
              ? 'mx-1 w-1 hover:bg-accent/30 data-[dragging=true]:bg-accent/50'
              : 'my-1 h-1 hover:bg-accent/30 data-[dragging=true]:bg-accent/50',
          )}
        >
          <span
            aria-hidden
            className={cn(
              'absolute',
              direction === 'horizontal'
                ? '-left-[4px] right-[-4px] top-0 bottom-0'
                : '-top-[4px] bottom-[-4px] left-0 right-0',
            )}
          />
        </Separator>
      )}
    </>
  );
}
