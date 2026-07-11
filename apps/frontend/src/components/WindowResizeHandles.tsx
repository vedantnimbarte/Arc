import { getCurrentWindow } from '@tauri-apps/api/window';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// Frameless window (decorations: false) has no native resize borders — on
// Linux/WebKitGTK they're gone entirely. These invisible grips line the four
// edges + corners and hand the drag off to the OS via startResizeDragging.
// ponytail: fixed 6px edges / 12px corners — bump if grabbing feels finicky.
const EDGE = 6;
const CORNER = 12;

type Dir = Parameters<ReturnType<typeof getCurrentWindow>['startResizeDragging']>[0];

const start = (dir: Dir) => (e: React.MouseEvent) => {
  if (e.button !== 0) return;
  e.preventDefault();
  void getCurrentWindow().startResizeDragging(dir);
};

export function WindowResizeHandles() {
  if (!isTauri) return null;
  const base = 'fixed z-[9999]';
  return (
    <>
      {/* edges */}
      <div className={base} style={{ top: 0, left: CORNER, right: CORNER, height: EDGE, cursor: 'ns-resize' }} onMouseDown={start('North')} />
      <div className={base} style={{ bottom: 0, left: CORNER, right: CORNER, height: EDGE, cursor: 'ns-resize' }} onMouseDown={start('South')} />
      <div className={base} style={{ left: 0, top: CORNER, bottom: CORNER, width: EDGE, cursor: 'ew-resize' }} onMouseDown={start('West')} />
      <div className={base} style={{ right: 0, top: CORNER, bottom: CORNER, width: EDGE, cursor: 'ew-resize' }} onMouseDown={start('East')} />
      {/* corners */}
      <div className={base} style={{ top: 0, left: 0, width: CORNER, height: CORNER, cursor: 'nwse-resize' }} onMouseDown={start('NorthWest')} />
      <div className={base} style={{ top: 0, right: 0, width: CORNER, height: CORNER, cursor: 'nesw-resize' }} onMouseDown={start('NorthEast')} />
      <div className={base} style={{ bottom: 0, left: 0, width: CORNER, height: CORNER, cursor: 'nesw-resize' }} onMouseDown={start('SouthWest')} />
      <div className={base} style={{ bottom: 0, right: 0, width: CORNER, height: CORNER, cursor: 'nwse-resize' }} onMouseDown={start('SouthEast')} />
    </>
  );
}
