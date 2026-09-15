import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Square,
} from 'lucide-react';
import { useFiles } from '../state/files';
import { useDebug, type DapStackFrame, type DapVariable } from '../state/debug';
import { formatBinding, getBinding, type ActionId } from '../state/shortcuts';
import { isTauri } from '../lib/tauri';
import { Select } from './Select';
import { cn } from '../lib/cn';

/**
 * Debug panel: pick a launch config, run it under the adapter the user has
 * installed, and inspect the program when it stops. The editor gutter owns
 * breakpoints; this panel is the controls, call stack, variables and console.
 */
export function DebugPanel() {
  const root = useFiles((s) => s.root);
  const d = useDebug();
  const { loadConfigs } = d;

  useEffect(() => {
    void loadConfigs(root);
  }, [root, loadConfigs]);

  if (!isTauri) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Header />
        <Empty>The debugger needs the desktop app.</Empty>
      </div>
    );
  }

  const live = d.sessionId !== null;
  const stopped = d.status === 'stopped';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header>
        <button
          type="button"
          onClick={() => void loadConfigs(root)}
          disabled={live}
          title="Reload .vscode/launch.json"
          aria-label="Reload launch configurations"
          className="flex h-5 w-5 items-center justify-center rounded text-fg-muted transition hover:bg-surface-2 hover:text-fg-base disabled:opacity-40"
        >
          <RefreshCw size={12} />
        </button>
      </Header>

      <div className="flex shrink-0 items-center gap-1 px-3 pb-2">
        <Select
          value={String(d.selected)}
          onChange={(v) => d.select(Number(v))}
          ariaLabel="Debug configuration"
          size="compact"
          className="min-w-0 flex-1"
          options={d.configs.map((c, i) => ({ value: String(i), label: c.name, hint: c.type }))}
        />
        {live ? (
          <IconButton action="debug-stop" label="Stop" onClick={() => void d.stop()}>
            <Square size={12} className="text-status-err" />
          </IconButton>
        ) : (
          <IconButton action="debug-start-continue" label="Start debugging" onClick={() => void d.start()}>
            <Play size={12} className="text-status-ok" />
          </IconButton>
        )}
      </div>
      {!d.fromLaunchJson && (
        <p className="px-3 pb-2 font-sans text-2xs text-fg-subtle/70">
          No .vscode/launch.json here — showing quick configs.
        </p>
      )}
      {d.configError && <p className="px-3 pb-2 font-sans text-xs text-status-err">{d.configError}</p>}

      {live && (
        <div className="flex shrink-0 items-center gap-1 border-y border-border-hairline px-3 py-1">
          {d.status === 'starting' ? (
            <Loader2 size={12} className="animate-spin text-fg-muted" />
          ) : stopped ? (
            <IconButton action="debug-start-continue" label="Continue" onClick={() => void d.step('continue')}>
              <Play size={12} />
            </IconButton>
          ) : (
            <IconButton label="Pause" onClick={() => void d.step('pause')}>
              <Pause size={12} />
            </IconButton>
          )}
          <IconButton action="debug-step-over" label="Step over" disabled={!stopped} onClick={() => void d.step('next')}>
            <ArrowRight size={12} />
          </IconButton>
          <IconButton action="debug-step-into" label="Step into" disabled={!stopped} onClick={() => void d.step('stepIn')}>
            <ArrowDownToLine size={12} />
          </IconButton>
          <IconButton action="debug-step-out" label="Step out" disabled={!stopped} onClick={() => void d.step('stepOut')}>
            <ArrowUpFromLine size={12} />
          </IconButton>
          <span className="flex-1 text-right font-sans text-2xs text-fg-subtle">{d.status}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto pb-2">
        {live && (
          <>
            <Section title="Call Stack">
              {d.threads.length === 0 && <Empty>{stopped ? 'No threads.' : 'Running…'}</Empty>}
              {d.threads.map((t) => (
                <div key={t.id}>
                  <p className="px-3 py-[3px] font-sans text-2xs text-fg-subtle">
                    {t.name}
                    {t.id === d.threadId && stopped ? ' · paused' : ''}
                  </p>
                  {t.id === d.threadId &&
                    d.frames.map((f) => (
                      <FrameRow key={f.id} frame={f} active={f.id === d.frameId} onClick={() => void d.selectFrame(f)} />
                    ))}
                </div>
              ))}
            </Section>
            <Section title="Variables">
              {d.scopes.map((s) => (
                <VariableNode
                  key={s.variablesReference}
                  depth={0}
                  variable={{ name: s.name, value: '', variablesReference: s.variablesReference }}
                  defaultOpen={d.scopes.length === 1 || s.name === 'Locals'}
                />
              ))}
            </Section>
          </>
        )}
      </div>

      <Console />
    </div>
  );
}

function Header({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 px-3 py-2">
      <span className="flex-1 font-sans text-2xs uppercase tracking-widest text-fg-subtle/60">Debug</span>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-2 font-sans text-xs leading-relaxed text-fg-subtle">{children}</p>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 px-2 py-1 font-sans text-2xs uppercase tracking-widest text-fg-subtle/70 hover:text-fg-base"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        {title}
      </button>
      {open && children}
    </div>
  );
}

function IconButton({
  action,
  label,
  disabled,
  onClick,
  children,
}: {
  action?: ActionId;
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const binding = action ? getBinding(action) : null;
  const title = binding ? `${label} (${formatBinding(binding)})` : label;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted transition hover:bg-surface-2 hover:text-fg-base disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function FrameRow({ frame, active, onClick }: { frame: DapStackFrame; active: boolean; onClick: () => void }) {
  const file = frame.source?.name ?? frame.source?.path?.split(/[\\/]/).pop();
  return (
    <button
      type="button"
      onClick={onClick}
      title={frame.source?.path ? `${frame.source.path}:${frame.line}` : frame.name}
      className={cn(
        'flex w-full items-center gap-2 py-[3px] pl-6 pr-2 text-left hover:bg-surface-1',
        active && 'bg-surface-2',
      )}
    >
      <span className="min-w-0 flex-1 truncate font-sans text-xs text-fg-base/90">{frame.name}</span>
      {file && (
        <span className="shrink-0 font-mono text-2xs text-fg-subtle">
          {file}:{frame.line}
        </span>
      )}
    </button>
  );
}

function VariableNode({
  variable,
  depth,
  defaultOpen = false,
}: {
  variable: DapVariable;
  depth: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const children = useDebug((s) => s.variables[variable.variablesReference]);
  const loadVariables = useDebug((s) => s.loadVariables);
  const expandable = variable.variablesReference > 0;

  const toggle = () => {
    if (!expandable) return;
    if (!open) void loadVariables(variable.variablesReference);
    setOpen((o) => !o);
  };

  // Scopes like "Locals" start expanded, which still has to fetch them.
  useEffect(() => {
    if (defaultOpen && expandable) {
      void loadVariables(variable.variablesReference);
      setOpen(true);
    }
  }, [defaultOpen, expandable, loadVariables, variable.variablesReference]);

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        title={variable.type ? `${variable.name}: ${variable.type}` : variable.name}
        className="flex w-full items-center gap-1 py-[2px] pr-2 text-left hover:bg-surface-1"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <span className="flex h-3 w-3 shrink-0 items-center justify-center text-fg-subtle">
          {expandable && (open ? <ChevronDown size={10} /> : <ChevronRight size={10} />)}
        </span>
        <span className={cn('shrink-0 font-mono text-2xs', depth === 0 ? 'text-fg-base/90' : 'text-fg-muted')}>
          {variable.name}
        </span>
        {variable.value && (
          <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-subtle">= {variable.value}</span>
        )}
      </button>
      {open &&
        children?.map((v, i) => <VariableNode key={`${v.name}-${i}`} variable={v} depth={depth + 1} />)}
    </div>
  );
}

function Console() {
  const output = useDebug((s) => s.output);
  const live = useDebug((s) => s.sessionId !== null);
  const evaluate = useDebug((s) => s.evaluate);
  const [expr, setExpr] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [output]);

  if (output.length === 0 && !live) return null;

  return (
    <div className="flex max-h-[40%] min-h-[96px] shrink-0 flex-col border-t border-border-hairline">
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-1.5 font-mono text-2xs leading-[16px]">
        {output.map((o, i) => (
          <span
            key={i}
            className={cn(
              o.category === 'stderr' ? 'text-status-err' : o.category === 'input' ? 'text-fg-subtle' : 'text-fg-base/85',
            )}
          >
            {o.text}
          </span>
        ))}
        <div ref={endRef} />
      </pre>
      <form
        className="shrink-0 border-t border-border-hairline"
        onSubmit={(e) => {
          e.preventDefault();
          void evaluate(expr);
          setExpr('');
        }}
      >
        <input
          value={expr}
          onChange={(e) => setExpr(e.target.value)}
          disabled={!live}
          placeholder={live ? 'Evaluate an expression' : 'Start a session to evaluate'}
          aria-label="Evaluate an expression"
          className="w-full bg-transparent px-3 py-1.5 font-mono text-2xs text-fg-base outline-none placeholder:text-fg-subtle/60 disabled:opacity-50"
        />
      </form>
    </div>
  );
}
