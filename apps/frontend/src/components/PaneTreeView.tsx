import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import { useWorkspace, type PaneNode, type PaneSplit } from '../state/workspace';
import { PaneLeafView } from './PaneLeafView';
import { PaneTabStrip } from './PaneTabStrip';
import { cn } from '../lib/cn';

/**
 * In a single-leaf workspace the tab strip lives in the application
 * toolbar; rendering a second per-pane strip would duplicate it. When the
 * workspace is split, every leaf carries its own strip again so users can
 * still see what's in panes that don't hold focus.
 */
function shouldShowLeafHeader(layout: PaneNode): boolean {
  return layout.kind !== 'leaf';
}

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
  const showHeader = shouldShowLeafHeader(layout);
  return (
    <PaneNodeView
      node={layout}
      hostsRef={hostsRef}
      stageRef={stageRef}
      showHeader={showHeader}
    />
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
        header={showHeader ? <PaneTabStrip paneId={node.id} /> : null}
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
            'group relative shrink-0 bg-transparent transition-colors duration-150',
            // Thin tinted line + a wider invisible grab band so 4px clicks land
            // without dominating the look.
            direction === 'horizontal'
              ? 'w-px hover:bg-accent/35 data-[dragging=true]:bg-accent/50'
              : 'h-px hover:bg-accent/35 data-[dragging=true]:bg-accent/50',
          )}
        >
          <span
            aria-hidden
            className={cn(
              'absolute',
              direction === 'horizontal'
                ? '-left-[3px] right-[-3px] top-0 bottom-0'
                : '-top-[3px] bottom-[-3px] left-0 right-0',
            )}
          />
        </Separator>
      )}
    </>
  );
}
