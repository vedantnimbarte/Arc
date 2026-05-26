import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, Command as CommandIcon, Search } from 'lucide-react';
import { cn } from '../lib/cn';
import {
  scoreAction,
  useCommands,
  type CommandAction,
  type CommandGroup,
} from '../state/commands';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Unified ⌘K command palette. Every feature registers actions into the
 * `useCommands` store; this component just renders + filters whatever is
 * currently registered. Different from `CommandHistoryPalette` (⌃R), which
 * surfaces shell command history.
 */
export function CommandPalette({ open, onClose }: Props) {
  const actions = useCommands((s) => s.actions);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery('');
      setSelected(0);
    }
  }, [open]);

  const visible = useMemo(() => {
    const all = Array.from(actions.values()).filter((a) => !a.when || a.when());
    if (!query.trim()) {
      // Sort by group then title when there's no query — gives a stable
      // browse order on first open.
      return [...all].sort((a, b) => {
        if (a.group !== b.group) return GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
        return a.title.localeCompare(b.title);
      });
    }
    return all
      .map((a) => [a, scoreAction(a, query)] as const)
      .filter(([, s]) => s >= 0)
      .sort((a, b) => b[1] - a[1])
      .map(([a]) => a);
  }, [actions, query]);

  // Clamp the selected index whenever the visible list shrinks.
  useEffect(() => {
    if (selected >= visible.length) setSelected(Math.max(0, visible.length - 1));
  }, [visible.length, selected]);

  // Keep the selected row in view as the user arrow-keys through results.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const node = list.querySelector<HTMLElement>(`[data-row="${selected}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const pick = async (action: CommandAction) => {
    onClose();
    if (action.when && !action.when()) return;
    try {
      await action.run();
    } catch (err) {
      console.error(`[commands] ${action.id} failed:`, err);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const action = visible[selected];
      if (action) void pick(action);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, visible.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    }
  };

  if (!open) return null;

  // Build group headers when no query — when filtering we just show a flat
  // ranked list, headers would shuffle distractingly.
  const groupedRows: Array<{ kind: 'header'; group: CommandGroup } | { kind: 'row'; action: CommandAction; index: number }> = [];
  if (!query.trim()) {
    let lastGroup: CommandGroup | null = null;
    visible.forEach((action, index) => {
      if (action.group !== lastGroup) {
        groupedRows.push({ kind: 'header', group: action.group });
        lastGroup = action.group;
      }
      groupedRows.push({ kind: 'row', action, index });
    });
  } else {
    visible.forEach((action, index) => groupedRows.push({ kind: 'row', action, index }));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="material-sheet mt-[14vh] flex w-[640px] max-w-[92vw] animate-sheet-in flex-col overflow-hidden rounded-window shadow-sheet ring-1 ring-white/10"
      >
        <div className="flex items-center gap-2 border-b border-border-hairline px-3.5 py-2.5">
          <CommandIcon size={13} strokeWidth={2.1} className="text-fg-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="run a command…"
            className="flex-1 bg-transparent font-display text-[13px] text-fg-base placeholder:text-fg-subtle focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="font-mono text-[10px] text-fg-subtle">esc</kbd>
        </div>

        <div ref={listRef} className="max-h-[420px] overflow-y-auto py-1">
          {visible.length === 0 && (
            <div className="flex items-center justify-center gap-1.5 px-4 py-6 font-display text-[11.5px] italic text-fg-subtle">
              <Search size={11} strokeWidth={2} />
              no commands {query ? `match “${query}”` : 'registered'}
            </div>
          )}

          {groupedRows.map((entry, i) => {
            if (entry.kind === 'header') {
              return (
                <div
                  key={`h-${entry.group}-${i}`}
                  className="px-3.5 pb-0.5 pt-1.5 font-display text-[10px] uppercase tracking-wider text-fg-subtle"
                >
                  {entry.group}
                </div>
              );
            }
            const { action, index } = entry;
            const Icon = action.icon;
            const isSelected = index === selected;
            return (
              <button
                key={action.id}
                data-row={index}
                onMouseEnter={() => setSelected(index)}
                onClick={() => void pick(action)}
                className={cn(
                  'flex w-full items-center gap-2.5 px-3.5 py-1.5 text-left transition-colors',
                  isSelected
                    ? 'bg-accent-soft ring-1 ring-inset ring-border-strong'
                    : 'hover:bg-white/[0.045]',
                )}
              >
                {Icon ? (
                  <Icon size={12} strokeWidth={2.1} className="shrink-0 text-fg-muted" />
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate font-display text-[12.5px] text-fg-base/90">
                  {action.title}
                </span>
                {action.shortcut && (
                  <kbd className="shrink-0 font-mono text-[10px] text-fg-subtle">
                    {action.shortcut}
                  </kbd>
                )}
                {isSelected && (
                  <CornerDownLeft size={11} strokeWidth={2.1} className="shrink-0 text-fg-muted" />
                )}
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between border-t border-border-hairline px-3.5 py-1.5 font-display text-[10px] text-fg-subtle">
          <span>
            <kbd className="font-mono">↑↓</kbd> select · <kbd className="font-mono">return</kbd> run · <kbd className="font-mono">esc</kbd> close
          </span>
          <span className="tabular-nums">{visible.length} commands</span>
        </div>
      </div>
    </div>
  );
}

const GROUP_ORDER: CommandGroup[] = [
  'Workspace',
  'Terminal',
  'Editor',
  'View',
  'Assistant',
  'Git',
  'SSH',
  'AI CLIs',
  'Help',
];
