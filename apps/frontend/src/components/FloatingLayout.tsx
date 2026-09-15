import { useLayoutEffect, useRef, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { useWorkspace, type PaneLeaf } from '../state/workspace';
import { useSettings } from '../state/settings';
import { PaneLeafView } from './PaneLeafView';
import { PaneHeader, iconForKind } from './PaneHeader';
import { MoveIcon, WorkspaceFlyout } from './MoveToWorkspace';
import { cn } from '../lib/cn';

/** Width of the card stack. Previews are the main window scaled to fit it. */
const STACK_W = 232;
/** `PaneHeader` is `h-9`; the main window's content area is its slot minus that. */
const HEADER_H = 36;

interface Props {
  leaf: PaneLeaf;
  hostsRef: React.MutableRefObject<Map<string, HTMLDivElement>>;
  stageRef: React.RefObject<HTMLDivElement>;
}

/**
 * Floating layout: the leaf's active tab fills the main window, and the deck on
 * the left lists every tab. `tabIds` is kept most-recent-first by the store, so
 * the deck opens with a title strip for the window you're viewing, then a live
 * scaled-down card for the one you just left, then the rest.
 *
 * The previews are the real tab hosts, reparented into each card at the main
 * window's size and shrunk with a CSS transform — terminals keep running and
 * never refit to the thumbnail, because ResizeObserver ignores transforms.
 * Only the expanded cards (the window you just left, and the one you're
 * hovering) host one; the rest stay in the hidden stage.
 */
export function FloatingLayout({ leaf, hostsRef, stageRef }: Props) {
  const gap = useSettings((s) => s.tileGap);
  const [collapsed, setCollapsed] = useState(false);
  // Last card hovered or focused. Cleared only when the pointer leaves the
  // whole deck, so moving between cards never collapses one out from under you.
  const [peekId, setPeekId] = useState<string | null>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const [main, setMain] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setMain({ w: Math.round(r.width), h: Math.max(0, Math.round(r.height) - HEADER_H) });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const stack = leaf.tabIds;
  const hidden = stack.length - 1;
  // No cards until the main window is measured: a 0×0 host is what crashes xterm.
  const measured = main.w > 0 && main.h > 0;
  const scale = measured ? STACK_W / main.w : 0;

  return (
    <div className="flex h-full w-full" style={{ gap }}>
      {hidden > 0 &&
        (collapsed ? (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            aria-label={`Show ${hidden} minimized ${hidden === 1 ? 'window' : 'windows'}`}
            title="Show stack"
            className="flex w-7 shrink-0 flex-col items-center gap-1 self-start rounded-md py-2 text-fg-muted outline-none transition-colors hover:bg-surface-2 hover:text-fg-base focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <PanelLeftOpen size={14} strokeWidth={1.9} />
            <span className="font-display text-2xs tabular-nums">{hidden}</span>
          </button>
        ) : (
          <div
            className="flex min-h-0 shrink-0 flex-col"
            style={{ width: STACK_W }}
            onMouseLeave={() => setPeekId(null)}
          >
            <div className="flex h-7 shrink-0 items-center justify-end">
              <button
                type="button"
                onClick={() => setCollapsed(true)}
                aria-label="Hide stack"
                title="Hide stack"
                className="flex h-6 w-6 items-center justify-center rounded text-fg-subtle outline-none transition-colors hover:bg-surface-3 hover:text-fg-base focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                <PanelLeftClose size={13} strokeWidth={1.9} />
              </button>
            </div>
            <ol
              aria-label="Windows"
              className="isolate min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-3 [scrollbar-width:none]"
            >
              {measured &&
                stack.map((id, i) => (
                  <StackCard
                    key={id}
                    tabId={id}
                    depth={i}
                    total={stack.length}
                    current={id === leaf.activeTabId}
                    // The window you just left shows whole; the rest peek on hover.
                    expanded={id !== leaf.activeTabId && (i === 1 || peekId === id)}
                    onPeek={() => setPeekId(id)}
                    main={main}
                    scale={scale}
                    hostsRef={hostsRef}
                    stageRef={stageRef}
                  />
                ))}
            </ol>
          </div>
        ))}

      <div ref={slotRef} className="min-h-0 min-w-0 flex-1">
        <PaneLeafView
          paneId={leaf.id}
          hostsRef={hostsRef}
          stageRef={stageRef}
          header={<PaneHeader paneId={leaf.id} />}
        />
      </div>
    </div>
  );
}

const cardAction =
  'flex h-[22px] w-[22px] items-center justify-center rounded text-fg-muted outline-none hover:bg-surface-3 hover:text-fg-base focus-visible:ring-2 focus-visible:ring-accent/60';

function StackCard({
  tabId,
  depth,
  total,
  current,
  expanded,
  onPeek,
  main,
  scale,
  hostsRef,
  stageRef,
}: {
  tabId: string;
  depth: number;
  total: number;
  /** The window open in the main area — a title strip, since its content can
   *  only be hosted in one place. */
  current: boolean;
  expanded: boolean;
  onPeek: () => void;
  main: { w: number; h: number };
  scale: number;
  hostsRef: React.MutableRefObject<Map<string, HTMLDivElement>>;
  stageRef: React.RefObject<HTMLDivElement>;
}) {
  const tab = useWorkspace((s) => s.tabs.find((t) => t.id === tabId));
  const running = useWorkspace((s) => !!s.tabRunning[tabId]);
  const setActive = useWorkspace((s) => s.setActive);
  const closeTab = useWorkspace((s) => s.closeTab);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [moveAnchor, setMoveAnchor] = useState<{ el: HTMLElement; kb: boolean } | null>(null);
  const host = hostsRef.current.get(tabId) ?? null;

  // Same imperative hosting as PaneLeafView: borrow the tab's host div, hand
  // it back to the stage on unmount. React runs this cleanup before the main
  // window's effect claims the host, so a swap never strands it.
  //
  // Only an expanded card hosts a live preview. A tucked card is a title strip
  // with a zero-height body, and hosting there would keep a full-window-size
  // terminal rendering where nobody can see it.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || !host || current || !expanded) return;
    body.appendChild(host);
    host.dispatchEvent(new CustomEvent('arc:host-shown'));
    return () => {
      if (host.parentElement !== body) return;
      stageRef.current?.appendChild(host);
      host.dispatchEvent(new CustomEvent('arc:host-hidden'));
    };
  }, [host, stageRef, current, expanded]);

  if (!tab) return null;
  const Icon = iconForKind(tab.kind);
  // Cards behind the front one tuck under it and narrow a little, up to three
  // steps — enough to read as a deck without the tail turning into a sliver.
  const inset = expanded || current ? 0 : Math.min(depth, 3) * 3;

  return (
    <li
      style={{
        zIndex: current ? total + 2 : expanded ? total + 1 : total - depth,
        marginTop: depth === 0 ? 0 : -6,
        marginLeft: inset,
        marginRight: inset,
      }}
      aria-current={current || undefined}
      className={cn(
        'group relative animate-pane-in overflow-hidden rounded-lg bg-bg-base shadow-[0_8px_18px_-8px_rgba(0,0,0,0.55)] transition-[margin] duration-200 ease-apple motion-reduce:animate-none motion-reduce:transition-none',
        current ? 'ring-1 ring-accent/50' : 'ring-1 ring-border-subtle',
      )}
    >
      <div className={cn('flex h-[34px] items-center gap-2 pl-2.5 pr-14', depth > 0 && 'pt-1.5')}>
        <span
          aria-hidden
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            running ? 'animate-pulse-soft bg-emerald-400' : 'bg-fg-subtle',
          )}
        />
        <Icon
          size={12}
          strokeWidth={2}
          className={cn('shrink-0', current ? 'text-accent-bright' : 'text-fg-subtle')}
        />
        <span className="truncate font-display text-xs font-medium tracking-tight text-fg-base/85">
          {tab.title}
        </span>
        {current && <span className="sr-only">(viewing)</span>}
      </div>

      {!current && (
        <>
          <div
            aria-hidden
            className="relative overflow-hidden border-t border-border-hairline/60 transition-[height] duration-200 ease-apple motion-reduce:transition-none"
            style={{ height: expanded ? Math.round(main.h * scale) : 0 }}
          >
            <div
              ref={bodyRef}
              // `inert` keeps the thumbnail's terminal/editor out of the tab order.
              {...{ inert: '' }}
              className="pointer-events-none absolute left-0 top-0"
              style={{
                width: main.w,
                height: main.h,
                transform: `scale(${scale})`,
                transformOrigin: '0 0',
              }}
            />
          </div>

          <button
            type="button"
            onMouseEnter={onPeek}
            onFocus={onPeek}
            onClick={() => setActive(tabId)}
            aria-label={`Go to ${tab.title}`}
            className="absolute inset-0 flex items-center justify-center rounded-lg outline-none transition-colors duration-150 group-hover:bg-scrim-1 focus-visible:bg-scrim-1 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
          >
            <span className="translate-y-1 rounded-full bg-bg-panel/95 px-3 py-1 font-display text-xs font-medium text-fg-base opacity-0 shadow-sheet ring-1 ring-edge-2 transition-all duration-150 ease-apple group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100 motion-reduce:transition-none">
              Go to
            </span>
          </button>
        </>
      )}

      <div
        className={cn(
          'absolute right-1.5 flex items-center gap-0.5 transition-opacity',
          depth > 0 ? 'top-[9px]' : 'top-1.5',
          moveAnchor ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100',
        )}
      >
        <button
          type="button"
          onClick={(e) => {
            // `detail` is 0 for a keyboard-activated click.
            const next = { el: e.currentTarget, kb: e.detail === 0 };
            setMoveAnchor((a) => (a ? null : next));
          }}
          aria-label={`Move ${tab.title} to workspace`}
          aria-haspopup="menu"
          aria-expanded={!!moveAnchor}
          title="Move to workspace"
          className={cardAction}
        >
          <MoveIcon size={12} strokeWidth={2.2} />
        </button>
        <button
          type="button"
          onClick={() => closeTab(tabId)}
          aria-label={`Close ${tab.title}`}
          title="Close"
          className={cardAction}
        >
          <X size={12} strokeWidth={2.2} />
        </button>
      </div>

      {moveAnchor && (
        <WorkspaceFlyout
          anchorEl={moveAnchor.el}
          placement="below"
          tabId={tabId}
          focusFirst={moveAnchor.kb}
          onDismiss={(refocus) => {
            if (refocus) moveAnchor.el.focus();
            setMoveAnchor(null);
          }}
        />
      )}
    </li>
  );
}
