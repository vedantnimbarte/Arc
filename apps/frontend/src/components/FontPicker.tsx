// Searchable font popover for Settings → Appearance. Lists the families
// installed on the user's machine (via `fonts_list_system`), each previewed in
// its own typeface, with a live filter and full keyboard navigation. Replaces
// the old native <select> so we can render real type specimens.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Loader2, Search, Type, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { listSystemFonts } from '../lib/tauri';
import { getFont, systemFontStack } from '../themes';

interface Props {
  /** Current stored fontId — a system family name, or a legacy bundled id. */
  value: string;
  onChange: (family: string) => void;
}

/** A short specimen shown beside each family name, rendered in that family. */
const SPECIMEN = 'Ag 123 {}';

export function FontPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const label = getFont(value).label;
  const previewStack = getFont(value).stack;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'group flex w-full items-center gap-3 rounded-lg border bg-bg-base/60 px-3 py-2 text-left transition-colors focus:outline-none',
          open
            ? 'border-accent/45 bg-bg-base/80 shadow-focus'
            : 'border-border-subtle hover:border-border-strong hover:bg-bg-base/70',
        )}
      >
        <Type
          size={13}
          strokeWidth={2.1}
          className="shrink-0 text-fg-subtle transition-colors group-hover:text-fg-muted"
        />
        <span
          className="min-w-0 flex-1 truncate font-display text-[12.5px] font-medium tracking-tight text-fg-base"
          style={{ fontFamily: previewStack }}
        >
          {label}
        </span>
        <span
          className="hidden shrink-0 truncate text-[12px] text-fg-subtle tabular-nums sm:inline"
          style={{ fontFamily: previewStack }}
        >
          {SPECIMEN}
        </span>
        <ChevronDown
          size={12}
          strokeWidth={2.2}
          className={cn(
            'shrink-0 text-fg-subtle transition-transform duration-200 ease-apple',
            open && 'rotate-180',
          )}
        />
      </button>
      <FontPopover
        open={open}
        anchorRef={triggerRef}
        value={value}
        onChange={(family) => {
          onChange(family);
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

function FontPopover({
  open,
  anchorRef,
  value,
  onChange,
  onClose,
}: {
  open: boolean;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  value: string;
  onChange: (family: string) => void;
  onClose: () => void;
}) {
  const [fonts, setFonts] = useState<string[] | null>(null);
  const [query, setQuery] = useState('');
  const [focusIdx, setFocusIdx] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Lazy-load the system font list the first time the popover opens.
  useEffect(() => {
    if (!open || fonts !== null) return;
    let alive = true;
    listSystemFonts()
      .then((list) => {
        if (alive) setFonts(list);
      })
      .catch(() => {
        if (alive) setFonts([]);
      });
    return () => {
      alive = false;
    };
  }, [open, fonts]);

  // Position the panel flush under the trigger, matching its width.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.max(280, r.width);
      const vw = window.innerWidth;
      const left = Math.max(8, Math.min(vw - width - 8, r.left));
      setPos({ top: r.bottom + 6, left, width });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, anchorRef]);

  // Reset transient state + focus the search box on open.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const id = window.setTimeout(() => inputRef.current?.focus(), 16);
    return () => window.clearTimeout(id);
  }, [open]);

  // Close on outside click + Escape.
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

  const filtered = useMemo(() => {
    const list = fonts ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((f) => f.toLowerCase().includes(q));
  }, [fonts, query]);

  // Land the highlight on the active font (or the top) whenever the list
  // shape changes, so opening the picker shows the current choice.
  useEffect(() => {
    const idx = filtered.indexOf(value);
    setFocusIdx(idx >= 0 ? idx : 0);
  }, [filtered, value]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${focusIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusIdx]);

  const pick = useCallback(
    (family: string) => onChange(family),
    [onChange],
  );

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const f = filtered[focusIdx];
      if (f) pick(f);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!open || !pos || typeof document === 'undefined') return null;

  const loading = fonts === null;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Choose a font"
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}
      className="material-sheet z-[60] flex max-h-[420px] flex-col overflow-hidden rounded-lg shadow-sheet ring-1 ring-white/10 animate-popover-in"
    >
      {/* Search */}
      <div className="flex items-center gap-2 border-b border-border-hairline bg-bg-base/60 px-3 py-2">
        <Search size={12} strokeWidth={2.2} className="shrink-0 text-fg-subtle" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder="Search system fonts…"
          className="flex-1 bg-transparent font-display text-[12.5px] text-fg-base placeholder:text-fg-subtle focus:outline-none"
          autoComplete="off"
          spellCheck={false}
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            className="rounded p-0.5 text-fg-subtle hover:bg-white/[0.08] hover:text-fg-base"
            aria-label="Clear search"
          >
            <X size={10} strokeWidth={2.2} />
          </button>
        )}
      </div>

      {/* List */}
      <div ref={listRef} role="listbox" className="min-h-0 flex-1 overflow-y-auto py-1">
        {loading && (
          <div className="flex items-center justify-center gap-2 px-4 py-10 font-display text-[12px] text-fg-subtle">
            <Loader2 size={13} strokeWidth={2.2} className="animate-spin" />
            Loading system fonts…
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
            <span className="font-display text-[12px] italic text-fg-subtle">
              {fonts && fonts.length === 0
                ? 'No system fonts found.'
                : `No fonts match “${query}”`}
            </span>
          </div>
        )}

        {!loading &&
          filtered.map((family, idx) => {
            const isFocus = idx === focusIdx;
            const isCurrent = family === value;
            const stack = systemFontStack(family);
            return (
              <button
                key={family}
                role="option"
                aria-selected={isCurrent}
                data-idx={idx}
                onMouseEnter={() => setFocusIdx(idx)}
                onClick={() => pick(family)}
                className={cn(
                  'flex w-full items-baseline gap-3 px-3 py-2 text-left transition-colors',
                  isFocus ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]',
                )}
              >
                <span
                  className="min-w-0 flex-1 truncate text-[13.5px] leading-tight text-fg-base"
                  style={{ fontFamily: stack }}
                >
                  {family}
                </span>
                <span
                  className="shrink-0 text-[12px] leading-tight text-fg-subtle"
                  style={{ fontFamily: stack }}
                >
                  {SPECIMEN}
                </span>
                <Check
                  size={12}
                  strokeWidth={2.6}
                  className={cn(
                    'shrink-0 self-center text-accent-bright transition-opacity',
                    isCurrent ? 'opacity-100' : 'opacity-0',
                  )}
                />
              </button>
            );
          })}
      </div>

      {/* Footer */}
      {!loading && (fonts?.length ?? 0) > 0 && (
        <div className="flex items-center justify-between border-t border-border-hairline bg-bg-base/40 px-3 py-1.5 font-display text-[10px] text-fg-subtle">
          <span className="tabular-nums">
            {filtered.length === fonts!.length
              ? `${fonts!.length} fonts`
              : `${filtered.length} of ${fonts!.length}`}
          </span>
          <span>
            <kbd className="font-mono">↑↓</kbd> navigate ·{' '}
            <kbd className="font-mono">↵</kbd> select
          </span>
        </div>
      )}
    </div>,
    document.body,
  );
}
