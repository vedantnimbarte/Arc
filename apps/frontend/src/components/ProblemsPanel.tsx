import { useEffect, useMemo } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Info,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { useFiles } from '../state/files';
import { useWorkspace } from '../state/workspace';
import { allProblems, useProblems } from '../state/problems';
import { problemsPrompt } from '../lib/agentPrompt';
import { useClaudeCode } from '../state/claudeCode';
import { copyText } from '../lib/clipboard';
import { countBySeverity, groupByFile, type Problem, type Severity } from '../lib/problemMatchers';
import { isRemotePath } from '../lib/remote';
import { fileIcon } from '../lib/fileIcons';
import { isTauri } from '../lib/tauri';
import { cn } from '../lib/cn';

/**
 * Problems panel: run the project's own checkers and turn what they print
 * into rows that open the file at the offending line.
 *
 * Deliberately not a live view. LSP diagnostics already cover the file you
 * are looking at, inline and instantly; what is missing is the whole-project
 * answer, and that costs a `tsc`/`cargo check` run. So this panel is a button
 * you press, and it is honest about when it last ran.
 */
export function ProblemsPanel() {
  const root = useFiles((s) => s.root);
  const openFile = useWorkspace((s) => s.openFile);
  const { checkers, results, running, scanning, scanError, collapsed, scan, run, runAll, toggleFile } =
    useProblems();

  useEffect(() => {
    void scan(root);
  }, [root, scan]);

  const problems = useMemo(() => allProblems(results), [results]);
  const groups = useMemo(() => groupByFile(problems), [problems]);
  const counts = useMemo(() => countBySeverity(problems), [problems]);

  /**
   * Hand the current diagnostics to an agent.
   *
   * Prefers the Claude Code panel, which ARC drives directly, so the prompt
   * lands in a conversation rather than on a command line. When that CLI is
   * not available the prompt goes to the clipboard instead of the action
   * silently doing nothing — every other supported agent runs in a terminal
   * ARC cannot type a multi-line prompt into safely.
   */
  const sendToAgent = () => {
    const prompt = problemsPrompt(problems);
    const claude = useClaudeCode.getState();
    if (claude.status === 'ready') {
      useFiles.getState().setAgentPanelTab('claude');
      useFiles.getState().showSidebarView('agents');
      void claude.send(prompt);
      return;
    }
    copyText(prompt, 'Agent prompt');
  };
  const anyRunning = Object.keys(running).length > 0;
  const ranAnything = Object.keys(results).length > 0;

  const open = (p: Problem) => {
    if (!p.file || !root) return;
    // Checkers print paths relative to the directory they ran in — the
    // workspace root — except eslint, which prints absolute ones.
    const absolute = isAbsolute(p.file) ? p.file : joinPath(root, p.file);
    openFile(absolute, undefined, p.line > 0 ? { line: p.line } : undefined);
  };

  if (!isTauri) {
    return <Empty>The problems panel needs the desktop app.</Empty>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 px-3 py-2">
        <span className="flex-1 font-sans text-2xs uppercase tracking-widest text-fg-subtle/60">
          Problems
        </span>
        {ranAnything && (
          <span className="flex items-center gap-2 font-mono text-2xs text-fg-subtle">
            {counts.errors > 0 && (
              <span className="text-red-300">{counts.errors} err</span>
            )}
            {counts.warnings > 0 && (
              <span className="text-amber-300/90">{counts.warnings} warn</span>
            )}
          </span>
        )}
        {/* Hand the diagnostics to an agent instead of retyping them. Only
            offered when there is something to hand over. */}
        {problems.length > 0 && (
          <button
            type="button"
            onClick={sendToAgent}
            title="Send these problems to an agent"
            aria-label="Send these problems to an agent"
            className="flex h-5 w-5 items-center justify-center rounded text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
          >
            <Sparkles size={12} />
          </button>
        )}
        <button
          type="button"
          onClick={() => void runAll()}
          disabled={anyRunning || checkers.length === 0}
          title="Run every checker"
          aria-label="Run every checker"
          className="flex h-5 w-5 items-center justify-center rounded text-fg-muted transition hover:bg-surface-2 hover:text-fg-base disabled:opacity-40"
        >
          {anyRunning ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
        </button>
        <button
          type="button"
          onClick={() => void scan(root)}
          disabled={scanning}
          title="Re-detect checkers"
          aria-label="Re-detect checkers"
          className="flex h-5 w-5 items-center justify-center rounded text-fg-muted transition hover:bg-surface-2 hover:text-fg-base disabled:opacity-40"
        >
          <RefreshCw size={12} className={scanning ? 'animate-spin-slow' : ''} />
        </button>
      </div>

      {/* One chip per detected checker: press to run just that one. */}
      {checkers.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-1 px-3 pb-2">
          {checkers.map((c) => {
            const result = results[c.id];
            const busy = !!running[c.id];
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => void run(c.id)}
                disabled={busy}
                title={result?.command ?? `Run ${c.label}`}
                className={cn(
                  'flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-2xs transition',
                  result?.error
                    ? 'border-red-500/30 bg-red-500/[0.07] text-red-300'
                    : result
                      ? 'border-border-hairline bg-surface-1 text-fg-muted hover:text-fg-base'
                      : 'border-border-hairline text-fg-subtle hover:bg-surface-1 hover:text-fg-base',
                  busy && 'opacity-60',
                )}
              >
                {busy && <Loader2 size={9} className="animate-spin" />}
                {c.label}
                {result && !result.error && (
                  <span className="text-fg-subtle/70">{result.problems.length}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {scanError && (
        <div className="mx-3 mb-2 rounded border border-red-500/25 bg-red-500/[0.06] px-2 py-1.5 font-mono text-2xs text-red-300">
          {scanError}
        </div>
      )}

      {/* A checker that failed to run at all — distinct from one that ran and
          found nothing. Silence here would read as "clean". */}
      {Object.entries(results)
        .filter(([, r]) => r.error)
        .map(([id, r]) => (
          <div
            key={id}
            className="mx-3 mb-2 rounded border border-red-500/25 bg-red-500/[0.06] px-2 py-1.5 font-mono text-2xs text-red-300"
          >
            <span className="font-semibold">{id}</span> · {r.error}
          </div>
        ))}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!root && <Empty>Open a folder to check it.</Empty>}
        {root && isRemotePath(root) && (
          <Empty>Checkers run locally — a remote workspace has no toolchain here.</Empty>
        )}
        {root && !isRemotePath(root) && checkers.length === 0 && !scanning && (
          <Empty>
            No checkers found. ARC looks for tsconfig.json, Cargo.toml, an ESLint config,
            pyproject.toml or go.mod at the workspace root.
          </Empty>
        )}
        {checkers.length > 0 && !ranAnything && !anyRunning && (
          <Empty>Press play to run {checkers.length === 1 ? 'it' : 'them'}.</Empty>
        )}
        {ranAnything && problems.length === 0 && !anyRunning && (
          <div className="px-3 py-6 text-center font-display text-xs italic text-fg-subtle">
            no problems reported
          </div>
        )}

        {groups.map(([file, list]) => {
          const isCollapsed = !!collapsed[file];
          const { Icon, color } = fileIcon(file || 'x.txt');
          return (
            <div key={file || '(project)'}>
              <button
                type="button"
                onClick={() => toggleFile(file)}
                className="flex w-full items-center gap-1 px-2 py-1 text-left hover:bg-surface-1"
              >
                {isCollapsed ? (
                  <ChevronRight size={11} className="shrink-0 text-fg-subtle" />
                ) : (
                  <ChevronDown size={11} className="shrink-0 text-fg-subtle" />
                )}
                <Icon size={11} className="shrink-0" style={{ color }} />
                <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-base/90" title={file}>
                  {file || 'project'}
                </span>
                <span className="shrink-0 font-mono text-2xs text-fg-subtle">{list.length}</span>
              </button>
              {!isCollapsed &&
                list.map((p, i) => (
                  <button
                    key={`${p.line}:${p.column}:${i}`}
                    type="button"
                    onClick={() => open(p)}
                    disabled={!p.file}
                    className="flex w-full items-start gap-1.5 py-1 pl-6 pr-2 text-left hover:bg-surface-1 disabled:cursor-default"
                  >
                    <SeverityIcon severity={p.severity} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-display text-xs leading-snug text-fg-base/90">
                        {p.message}
                      </span>
                      <span className="block truncate font-mono text-2xs text-fg-subtle">
                        {p.line > 0 && `${p.line}:${p.column} · `}
                        {p.source}
                        {p.code && ` · ${p.code}`}
                      </span>
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SeverityIcon({ severity }: { severity: Severity }) {
  if (severity === 'error') {
    return <CircleAlert size={11} className="mt-[3px] shrink-0 text-red-400" aria-label="error" />;
  }
  if (severity === 'warning') {
    return (
      <AlertTriangle size={11} className="mt-[3px] shrink-0 text-amber-400" aria-label="warning" />
    );
  }
  return <Info size={11} className="mt-[3px] shrink-0 text-fg-subtle" aria-label="info" />;
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-6 text-center font-display text-xs italic leading-relaxed text-fg-subtle">
      {children}
    </div>
  );
}

function isAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
}

function joinPath(root: string, rel: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[\\/]$/, '')}${sep}${rel.replace(/^[\\/]/, '')}`;
}
