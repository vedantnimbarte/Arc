import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, CaseSensitive, Regex, WholeWord, X } from 'lucide-react';
import type { SearchAddon, ISearchOptions } from '@xterm/addon-search';
import { cn } from '../lib/cn';

/**
 * Find bar for a terminal pane. Opened with ⌘/Ctrl+F from Terminal's custom
 * key handler; drives `@xterm/addon-search` directly.
 *
 * Enter / Shift+Enter step through matches, Esc closes and clears the
 * highlight. The match counter comes from the addon's `onDidChangeResults`,
 * which only reports totals when `decorations` are configured — so they are
 * always passed.
 */

interface Props {
  addon: SearchAddon;
  /** Highlight colours, taken from the active xterm theme. */
  decorations: { activeMatchBackground: string; matchBackground: string; matchOverviewRuler: string; activeMatchColorOverviewRuler: string };
  onClose: () => void;
}

export function TerminalSearchBar({ addon, decorations, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [results, setResults] = useState<{ index: number; count: number } | null>(null);

  const options: ISearchOptions = {
    caseSensitive,
    wholeWord,
    regex,
    decorations,
  };

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // The addon reports totals asynchronously as it walks the buffer.
  useEffect(() => {
    const sub = addon.onDidChangeResults((r) => {
      // resultIndex is -1 when nothing matched.
      setResults(r.resultCount === 0 ? { index: -1, count: 0 } : { index: r.resultIndex, count: r.resultCount });
    });
    return () => sub.dispose();
  }, [addon]);

  // Re-run the search as the query or any toggle changes. `findNext` with
  // `incremental` keeps the viewport steady while typing instead of jumping
  // to the next match on every keystroke.
  useEffect(() => {
    if (!query) {
      addon.clearDecorations();
      setResults(null);
      return;
    }
    try {
      addon.findNext(query, { ...options, incremental: true });
    } catch {
      // An in-progress regex (e.g. `foo(`) throws — leave the previous
      // highlight alone until it parses.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, wholeWord, regex, addon]);

  const step = (dir: 'next' | 'prev') => {
    if (!query) return;
    try {
      if (dir === 'next') addon.findNext(query, options);
      else addon.findPrevious(query, options);
    } catch {
      /* invalid regex */
    }
  };

  const close = () => {
    addon.clearDecorations();
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? 'prev' : 'next');
    }
  };

  const toggle = (on: boolean, label: string, onClick: () => void, Icon: typeof CaseSensitive) => (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={on}
      className={cn(
        'rounded p-1 transition-colors',
        on ? 'bg-surface-3 text-fg-base' : 'text-fg-subtle hover:bg-surface-2 hover:text-fg-muted',
      )}
    >
      <Icon size={12} strokeWidth={2} />
    </button>
  );

  const noMatch = results !== null && results.count === 0;

  return (
    <div
      className="absolute right-3 top-2 z-20 flex items-center gap-1 rounded-md border border-border-hairline bg-bg-panel px-1.5 py-1 shadow-sheet ring-1 ring-edge-1"
      // Keep clicks inside from stealing terminal focus handling.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find"
        aria-label="Find in terminal"
        spellCheck={false}
        className={cn(
          'w-44 bg-transparent px-1 font-mono text-xs text-fg-base outline-none placeholder:text-fg-subtle',
          noMatch && 'text-status-err',
        )}
      />
      <span className="min-w-[3.5rem] select-none text-right font-mono text-2xs tabular-nums text-fg-subtle">
        {results === null ? '' : results.count === 0 ? 'no results' : `${results.index + 1}/${results.count}`}
      </span>
      {toggle(caseSensitive, 'Match case', () => setCaseSensitive((v) => !v), CaseSensitive)}
      {toggle(wholeWord, 'Match whole word', () => setWholeWord((v) => !v), WholeWord)}
      {toggle(regex, 'Use regular expression', () => setRegex((v) => !v), Regex)}
      <div className="mx-0.5 h-4 w-px bg-border-subtle" />
      <button
        type="button"
        onClick={() => step('prev')}
        title="Previous match (shift+enter)"
        aria-label="Previous match"
        className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
      >
        <ArrowUp size={12} strokeWidth={2} />
      </button>
      <button
        type="button"
        onClick={() => step('next')}
        title="Next match (enter)"
        aria-label="Next match"
        className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
      >
        <ArrowDown size={12} strokeWidth={2} />
      </button>
      <button
        type="button"
        onClick={close}
        title="Close (esc)"
        aria-label="Close find bar"
        className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
      >
        <X size={12} strokeWidth={2} />
      </button>
    </div>
  );
}
