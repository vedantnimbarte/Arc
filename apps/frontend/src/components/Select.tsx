// Themed replacement for a native <select>.
//
// A native select's popup is drawn by the OS, not the page, so it ignores the
// theme entirely and lands as a white sheet on top of a dark window. This is
// the same portal-and-anchor approach `FontPicker` already uses, minus the
// search box and type specimens: one trigger, one floating listbox.
//
// It also carries something a native select structurally cannot — a line of
// help per option — so a choice like "acceptEdits" can say what it does
// before you commit to it rather than after.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, TriangleAlert } from 'lucide-react';
import { cn } from '../lib/cn';

export interface SelectOption<T extends string> {
  value: T;
  /** What the row is called. Rendered in mono when `mono` is set on the Select. */
  label: string;
  /** One line on what picking this does. Optional. */
  hint?: string;
  /** Marks the row with a warning glyph — for a choice that removes a
   *  guardrail. The label keeps normal contrast; the amber only reinforces. */
  risky?: boolean;
}

interface Props<T extends string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  /** Names the control for screen readers. */
  ariaLabel: string;
  /** Render the trigger label and option names in the mono face — for values
   *  that are literal identifiers (a branch, a model id, a host key) rather
   *  than prose. */
  mono?: boolean;
  /** `default` is the form-field trigger. `compact` is the toolbar chip: 28px
   *  tall, inset ring instead of a border, to sit in a row of icon buttons. */
  size?: 'default' | 'compact';
  className?: string;
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  mono = false,
  size = 'default',
  className,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => o.value === value);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md bg-surface-1 text-left transition-colors hover:bg-surface-2 focus:outline-none',
          size === 'compact'
            ? 'h-7 px-2 ring-1 ring-inset'
            : 'border px-2.5 py-1.5',
          open
            ? size === 'compact'
              ? 'bg-surface-2 ring-accent/45 shadow-focus'
              : 'border-accent/45 bg-surface-2 shadow-focus'
            : size === 'compact'
              ? 'ring-edge-1'
              : 'border-edge-2',
          className,
        )}
      >
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-fg-base',
            size === 'compact'
              ? cn('text-2xs', mono ? 'font-mono' : 'font-display')
              : mono
                ? 'font-mono text-xs'
                : 'font-display text-sm tracking-tight',
          )}
        >
          {current?.label ?? value}
        </span>
        <ChevronDown
          size={size === 'compact' ? 10 : 12}
          strokeWidth={2.2}
          className={cn(
            'shrink-0 text-fg-subtle transition-transform duration-200 ease-apple',
            open && 'rotate-180',
          )}
        />
      </button>
      <SelectPopover
        open={open}
        anchorRef={triggerRef}
        value={value}
        options={options}
        mono={mono}
        ariaLabel={ariaLabel}
        onChange={(v) => {
          onChange(v);
          setOpen(false);
          triggerRef.current?.focus();
        }}
        onClose={() => {
          setOpen(false);
          triggerRef.current?.focus();
        }}
      />
    </>
  );
}

function SelectPopover<T extends string>({
  open,
  anchorRef,
  value,
  options,
  mono,
  ariaLabel,
  onChange,
  onClose,
}: {
  open: boolean;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  value: T;
  options: SelectOption<T>[];
  mono: boolean;
  ariaLabel: string;
  onChange: (value: T) => void;
  onClose: () => void;
}) {
  const [pos, setPos] = useState<
    { top: number; left: number; width: number; maxHeight: number } | null
  >(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Anchor under the trigger, or above it when the space below is too tight.
  // The Settings window is only 700px tall, so a six-row list opened from the
  // lower half would otherwise run off the bottom edge.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.max(280, r.width);
      const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.left));
      const gap = 6;
      const below = window.innerHeight - r.bottom - gap - 8;
      const above = r.top - gap - 8;
      // Flip only when below genuinely cannot hold the list and above is roomier.
      const flip = below < 200 && above > below;
      setPos({
        top: flip ? Math.max(8, r.top - gap - Math.min(above, 320)) : r.bottom + gap,
        left,
        width,
        maxHeight: Math.min(320, flip ? above : below),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, anchorRef]);

  // Open on the current choice, and take focus so the arrow keys work without
  // the user having to click into the list first.
  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => o.value === value);
    setFocusIdx(idx >= 0 ? idx : 0);
    const id = window.setTimeout(() => listRef.current?.focus(), 16);
    return () => window.clearTimeout(id);
  }, [open, options, value]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (panelRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, onClose, anchorRef]);

  // Keep the highlighted row in view.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${focusIdx}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [focusIdx]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIdx((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setFocusIdx(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setFocusIdx(options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const o = options[focusIdx];
      if (o) onChange(o.value);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      onClose();
    }
  };

  if (!open || !pos || typeof document === 'undefined') return null;

  // The panel ground is opaque on purpose. The `material-*` blurs are tuned
  // for full-window sheets sitting over a scrim; a menu this size floats over
  // ordinary body copy, and any translucency leaves the text underneath
  // legible straight through the options.
  return createPortal(
    <div
      ref={panelRef}
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}
      className="animate-popover-in z-[60] overflow-hidden rounded-lg bg-bg-panel shadow-sheet ring-1 ring-edge-2"
    >
      <div
        ref={listRef}
        role="listbox"
        aria-label={ariaLabel}
        tabIndex={-1}
        onKeyDown={onKey}
        style={{ maxHeight: pos.maxHeight }}
        className="overflow-y-auto py-1 focus:outline-none"
      >
        {options.map((o, idx) => {
          const isFocus = idx === focusIdx;
          const isCurrent = o.value === value;
          return (
            <button
              key={o.value}
              role="option"
              aria-selected={isCurrent}
              data-idx={idx}
              onMouseEnter={() => setFocusIdx(idx)}
              onClick={() => onChange(o.value)}
              className={cn(
                'flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors',
                isFocus ? 'bg-surface-2' : 'hover:bg-surface-1',
              )}
            >
              <Check
                size={12}
                strokeWidth={2.6}
                className={cn(
                  'mt-0.5 shrink-0 transition-opacity',
                  o.risky ? 'text-status-warn' : 'text-accent-bright',
                  isCurrent ? 'opacity-100' : 'opacity-0',
                )}
              />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'flex items-center gap-1.5 text-fg-base',
                    mono ? 'font-mono text-xs' : 'font-display text-sm tracking-tight',
                  )}
                >
                  <span className="truncate">{o.label}</span>
                  {/* The amber carries no meaning on its own: at `status-warn`
                      on a light panel it is about 2:1 against white, and colour
                      alone is not a signal anyone can rely on. The glyph is
                      what marks the row; the tint only reinforces it. */}
                  {o.risky && (
                    <TriangleAlert
                      size={11}
                      strokeWidth={2.2}
                      className="shrink-0 text-status-warn"
                      aria-label="removes a guardrail"
                    />
                  )}
                </span>
                {o.hint && (
                  <span className="mt-0.5 block font-display text-2xs leading-relaxed text-fg-subtle">
                    {o.hint}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
