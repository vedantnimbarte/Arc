import { ArrowDown, ArrowUp, Command as CommandIcon, FolderOpen, GitBranch } from 'lucide-react';
import { useFiles } from '../state/files';
import { useGit } from '../state/git';
import { runCommand } from '../state/commands';
import { formatBinding, getBinding } from '../state/shortcuts';
import { cn } from '../lib/cn';

/**
 * Thin strip along the bottom of the window: which folder you're in, what git
 * thinks of it, and a permanent pointer at ⌘K.
 *
 * ARC used to carry a much heavier status bar (breadcrumbs, shell picker,
 * branch switcher — see commit a9e77ed) and it was removed for good reason.
 * This is deliberately not that: it is the app's only always-visible surface
 * that answers "where am I", and every item is a shortcut to the sidebar view
 * that owns it, so it teaches the layout rather than duplicating it.
 */
export function StatusBar() {
  const root = useFiles((s) => s.root);
  const showSidebarView = useFiles((s) => s.showSidebarView);
  const info = useGit((s) => s.info);
  const changes = useGit((s) => s.entries.length);
  const conflicts = useGit((s) =>
    s.entries.reduce((n, e) => (e.kind === 'conflict' ? n + 1 : n), 0),
  );

  const paletteKbd = formatBinding(getBinding('open-command-palette'));

  return (
    <footer className="material-toolbar flex h-6 shrink-0 items-center gap-1 border-t border-border-hairline px-2 font-display text-2xs text-fg-muted">
      {/* Folder — the answer to "what am I even looking at". With no root
          picked yet this is the call to action instead. */}
      <Item
        icon={FolderOpen}
        onClick={() =>
          root ? showSidebarView('files') : void runCommand('workspace.open-folder')
        }
        label={root ? basename(root) : 'Open a folder…'}
        title={root ?? 'Choose the folder to work in'}
        accent={!root}
      />

      {info?.branch && (
        <Item
          icon={GitBranch}
          onClick={() => showSidebarView('git')}
          label={info.branch}
          title={`On branch ${info.branch} — open Source Control`}
        >
          {info.ahead > 0 && (
            <span className="flex items-center tabular-nums">
              <ArrowUp size={9} strokeWidth={2.4} />
              {info.ahead}
            </span>
          )}
          {info.behind > 0 && (
            <span className="flex items-center tabular-nums">
              <ArrowDown size={9} strokeWidth={2.4} />
              {info.behind}
            </span>
          )}
          {changes > 0 && (
            <span
              className={cn('tabular-nums', conflicts > 0 ? 'text-status-err' : 'text-accent-bright')}
            >
              {conflicts > 0
                ? `${conflicts} conflict${conflicts === 1 ? '' : 's'}`
                : `${changes} change${changes === 1 ? '' : 's'}`}
            </span>
          )}
        </Item>
      )}

      <div className="flex-1" />

      {/* The one thing every new user needs to know. Deliberately spelled out
          rather than left as a bare glyph. */}
      <Item
        icon={CommandIcon}
        onClick={() => void runCommand('shortcut.open-command-palette')}
        label="Commands"
        title="Search every action in ARC"
      >
        <kbd className="font-mono text-fg-subtle">{paletteKbd}</kbd>
      </Item>
    </footer>
  );
}

/** Last path segment of a path, forward or back slashes. */
function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function Item({
  icon: Icon,
  label,
  title,
  onClick,
  accent,
  children,
}: {
  icon: typeof GitBranch;
  label: string;
  title: string;
  onClick: () => void;
  /** Draw attention — used for the "no folder yet" call to action. */
  accent?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex h-[18px] max-w-[240px] items-center gap-1.5 rounded px-1.5 transition-colors',
        'hover:bg-surface-2 hover:text-fg-base',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
        accent && 'text-accent-bright',
      )}
    >
      <Icon size={11} strokeWidth={2} className="shrink-0" />
      <span className="truncate">{label}</span>
      {children}
    </button>
  );
}
