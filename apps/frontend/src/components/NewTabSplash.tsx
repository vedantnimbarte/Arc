import { useEffect, useState } from 'react';
import { Clock, FileText, TerminalSquare } from 'lucide-react';
import { fileIcon } from '../lib/fileIcons';
import { isTauri, sessionCommandsRecent, type CommandRecord } from '../lib/tauri';
import { useFiles } from '../state/files';
import { cn } from '../lib/cn';

interface Props {
  /** Paste a recent command into the terminal (does NOT auto-run). */
  onPasteCommand: (command: string) => void;
  /** Open a recent file in the editor. */
  onOpenFile: (path: string) => void;
}

const COMMAND_LIMIT = 8;

/**
 * Two-column splash shown over a fresh terminal tab (Tier 1.2): recent
 * commands on the left, recent files on the right. Clicking a command pastes
 * it (the user still presses Enter); clicking a file opens it in the editor.
 * Dismisses itself once the user starts typing — see the Terminal wiring.
 */
export function NewTabSplash({ onPasteCommand, onOpenFile }: Props) {
  const recentFiles = useFiles((s) => s.recentFiles);
  const [commands, setCommands] = useState<CommandRecord[]>([]);

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    void sessionCommandsRecent(COMMAND_LIMIT)
      .then((rows) => {
        if (!cancelled) setCommands(rows);
      })
      .catch(() => {
        /* history unavailable — splash just shows files (or nothing) */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const hasCommands = commands.length > 0;
  const hasFiles = recentFiles.length > 0;
  if (!hasCommands && !hasFiles) return null;

  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
      <div className="pointer-events-auto grid w-full max-w-2xl grid-cols-1 gap-4 sm:grid-cols-2">
        <SplashColumn icon={TerminalSquare} title="Recent commands" empty={!hasCommands}>
          {commands.map((c) => (
            <SplashRow
              key={c.id}
              onClick={() => onPasteCommand(c.command)}
              mono
              ok={c.exit_code}
            >
              <span className="truncate">{c.command}</span>
            </SplashRow>
          ))}
        </SplashColumn>

        <SplashColumn icon={Clock} title="Recent files" empty={!hasFiles}>
          {recentFiles.map((path) => {
            const name = path.split(/[\\/]/).pop() || path;
            const { Icon, color } = fileIcon(name);
            return (
              <SplashRow key={path} onClick={() => onOpenFile(path)} title={path}>
                <Icon size={12} strokeWidth={1.8} style={{ color }} className="shrink-0" />
                <span className="truncate">{name}</span>
              </SplashRow>
            );
          })}
        </SplashColumn>
      </div>
    </div>
  );
}

function SplashColumn({
  icon: Icon,
  title,
  empty,
  children,
}: {
  icon: typeof FileText;
  title: string;
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border-hairline bg-bg-chrome/40 p-3 backdrop-blur-md">
      <div className="mb-2 flex items-center gap-1.5 px-1 font-display text-[10.5px] font-semibold uppercase tracking-wider text-fg-subtle">
        <Icon size={11} strokeWidth={2.2} />
        {title}
      </div>
      {empty ? (
        <div className="px-1 py-2 font-display text-[11px] italic text-fg-subtle">nothing yet</div>
      ) : (
        <div className="flex flex-col gap-0.5">{children}</div>
      )}
    </div>
  );
}

function SplashRow({
  onClick,
  children,
  mono,
  title,
  ok,
}: {
  onClick: () => void;
  children: React.ReactNode;
  mono?: boolean;
  title?: string;
  /** Exit code, when known — non-zero gets a subtle red dot. */
  ok?: number | null;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11.5px] text-fg-base/85 transition-colors hover:bg-white/[0.06] hover:text-fg-base',
        mono && 'font-mono',
      )}
    >
      {typeof ok === 'number' && (
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            ok === 0 ? 'bg-emerald-400/70' : 'bg-red-400/70',
          )}
          aria-hidden
        />
      )}
      {children}
    </button>
  );
}
