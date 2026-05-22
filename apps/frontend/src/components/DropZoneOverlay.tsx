import { cn } from '../lib/cn';

export type DropZone = 'center' | 'top' | 'bottom' | 'left' | 'right';

/** Translucent rectangle that previews where a dropped tab will land.
 *  Center fills the whole pane; cardinal zones cover the half that the
 *  new sub-leaf will occupy after the split. */
export function DropZoneOverlay({ zone }: { zone: DropZone }) {
  const style = (() => {
    switch (zone) {
      case 'top':
        return { top: 0, left: 0, right: 0, height: '50%' };
      case 'bottom':
        return { bottom: 0, left: 0, right: 0, height: '50%' };
      case 'left':
        return { top: 0, bottom: 0, left: 0, width: '50%' };
      case 'right':
        return { top: 0, bottom: 0, right: 0, width: '50%' };
      case 'center':
      default:
        return { inset: 0 } as React.CSSProperties;
    }
  })();
  return (
    <div
      aria-hidden
      style={style as React.CSSProperties}
      className={cn(
        'pointer-events-none absolute z-20 rounded-md',
        'bg-accent/15 ring-1 ring-inset ring-accent/50',
        'transition-all duration-100 ease-out',
        // Subtle glow so the user feels the drop target lock in.
        'shadow-[0_0_24px_-4px_rgba(220,224,232,0.35)_inset]',
      )}
    />
  );
}
