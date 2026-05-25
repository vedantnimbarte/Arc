import { useLayoutEffect, useRef, useState } from 'react';
import { findLeaf, useWorkspace } from '../state/workspace';
import { DropZoneOverlay, type DropZone } from './DropZoneOverlay';

interface Props {
  paneId: string;
  /** Shared host-div registry — App.tsx mounts each tab's content into its
   *  host via a portal, and we reparent that host node here so the tab is
   *  visible only inside the pane that currently owns it. */
  hostsRef: React.MutableRefObject<Map<string, HTMLDivElement>>;
  /** The hidden stage that holds tab host divs when they're not visible
   *  in any leaf. Receives the displaced host on `activeTabId` change. */
  stageRef: React.RefObject<HTMLDivElement>;
  /** Slot above the content area — typically a tab bar. */
  header?: React.ReactNode;
}

/**
 * One leaf in the pane tree. Renders an empty content `<div>` whose only
 * job is to host whichever tab is active in this leaf. The hosting is
 * imperative — we don't React-render the tab content here; we steal the
 * portal target via `appendChild` after layout.
 *
 * PTY survival hinges on this never touching the React subtree behind the
 * host div. When the leaf's active tab changes (or the leaf unmounts),
 * the prior host is returned to the stage so it stays in the DOM and
 * xterm/CodeMirror keep their internal state intact.
 *
 * The content area is also a drag-and-drop target for tabs. Hovering with
 * a tab drag shows the 5-zone overlay (center/top/bottom/left/right) and
 * dispatches either a same-group move or a split into the new sub-pane on
 * drop. The cleanup paths (mouseup, blur, dragleave with depth counter)
 * mirror the standard "Tauri webview drag" gotcha — `dragend` isn't
 * reliable when the source DOM reparents mid-drag.
 */
export function PaneLeafView({ paneId, hostsRef, stageRef, header }: Props) {
  const leaf = useWorkspace((s) => findLeaf(s.layout, paneId));
  const moveTabToPane = useWorkspace((s) => s.moveTabToPane);
  const splitPaneWithTab = useWorkspace((s) => s.splitPaneWithTab);
  const contentRef = useRef<HTMLDivElement>(null);
  // `enterCount` tracks dragenter/dragleave depth — pure dragleave fires
  // for every child boundary crossed, so we only clear the overlay when
  // the count returns to zero (the drag actually left the leaf).
  const enterCount = useRef(0);
  const [zone, setZone] = useState<DropZone | null>(null);

  useLayoutEffect(() => {
    const container = contentRef.current;
    const activeTabId = leaf?.activeTabId;
    if (!container || !activeTabId) return;
    const host = hostsRef.current.get(activeTabId);
    if (!host) return;

    // If the host is already inside this leaf, nothing to do.
    if (host.parentElement === container) return;

    container.appendChild(host);
    // Notify the hosted content (Terminal / Editor) that it's now visible
    // in a real leaf. xterm in particular needs a kick — ResizeObserver
    // can miss the display:none→visible transition and leave the canvas
    // rendered at stale dimensions (looks like only a sliver of the prompt
    // is visible after switching back to the tab).
    host.dispatchEvent(new CustomEvent('arc:host-shown'));

    return () => {
      // On effect teardown the next activeTab's effect already appendChild'd
      // its own host. We only need to handle the leaf unmounting entirely —
      // return any host we still own to the stage so React's portal keeps
      // rendering into it.
      const stage = stageRef.current;
      if (!stage) return;
      if (host.parentElement === container) {
        stage.appendChild(host);
      }
    };
  }, [leaf?.activeTabId, hostsRef, stageRef]);

  const hasTabDrag = (e: React.DragEvent) => e.dataTransfer.types.includes('arc/tab');

  const computeZone = (clientX: number, clientY: number): DropZone => {
    const rect = contentRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return 'center';
    const px = (clientX - rect.left) / rect.width;
    const py = (clientY - rect.top) / rect.height;
    const edge = 0.25;
    // Edges win over corners — pick the closest cardinal so the user can
    // hit "left" by tracking close to the vertical edge without needing to
    // also be vertically centered.
    if (px < edge && px <= py && px <= 1 - py) return 'left';
    if (px > 1 - edge && 1 - px <= py && 1 - px <= 1 - py) return 'right';
    if (py < edge) return 'top';
    if (py > 1 - edge) return 'bottom';
    return 'center';
  };

  const reset = () => {
    enterCount.current = 0;
    setZone(null);
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {header}
      <div
        ref={contentRef}
        className="dot-grid relative min-h-0 flex-1 overflow-hidden"
        onDragEnter={(e) => {
          if (!hasTabDrag(e)) return;
          enterCount.current += 1;
          if (enterCount.current === 1) {
            setZone(computeZone(e.clientX, e.clientY));
          }
        }}
        onDragOver={(e) => {
          if (!hasTabDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const next = computeZone(e.clientX, e.clientY);
          if (next !== zone) setZone(next);
        }}
        onDragLeave={(e) => {
          if (!hasTabDrag(e)) return;
          enterCount.current = Math.max(0, enterCount.current - 1);
          if (enterCount.current === 0) setZone(null);
        }}
        onDrop={(e) => {
          if (!hasTabDrag(e)) return;
          e.preventDefault();
          const raw = e.dataTransfer.getData('arc/tab');
          reset();
          if (!raw) return;
          let parsed: { tabId: string; sourcePaneId: string } | null = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            return;
          }
          if (!parsed) return;
          if (zone === 'center' || zone === null) {
            // Same-pane center drop = no-op; cross-pane = move into the
            // target leaf's strip.
            if (parsed.sourcePaneId !== paneId) {
              moveTabToPane(parsed.tabId, paneId);
            }
            return;
          }
          // Directional zones map directly onto the workspace's split sides.
          splitPaneWithTab(paneId, zone, parsed.tabId);
        }}
      >
        {zone && <DropZoneOverlay zone={zone} />}
      </div>
    </div>
  );
}
