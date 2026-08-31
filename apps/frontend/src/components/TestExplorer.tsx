import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FlaskConical,
  Loader2,
  Play,
  RefreshCw,
  X,
  XCircle,
} from 'lucide-react';
import { useFiles } from '../state/files';
import { useWorkspace } from '../state/workspace';
import { statusOf, targetKey, useTests, type Target, type TestStatus } from '../state/tests';
import { frameworkLabel, type Framework, type TestFile } from '../lib/testDiscovery';
import { isTauri } from '../lib/tauri';
import { cn } from '../lib/cn';

/**
 * Sidebar test explorer: framework → file → test, each row runnable.
 *
 * A run's verdict is its runner's exit code (see `state/tests.ts`), so a
 * single test's row is exactly as trustworthy as running that test yourself.
 * A failed row opens the runner's real output rather than a summary of it —
 * the stack trace is the reason you clicked.
 */
export function TestExplorer() {
  const root = useFiles((s) => s.root);
  const openFile = useWorkspace((s) => s.openFile);
  const tests = useTests();
  const { scan, run, files, frameworks, scanning, error, openOutput, setOpenOutput } = tests;

  useEffect(() => {
    void scan(root);
  }, [root, scan]);

  const byFramework = useMemo(() => {
    const map = new Map<Framework, TestFile[]>();
    for (const f of files) {
      const list = map.get(f.framework);
      if (list) list.push(f);
      else map.set(f.framework, [f]);
    }
    return map;
  }, [files]);

  const shownOutcome = openOutput ? tests.outcomes[openOutput] : undefined;

  if (!isTauri) {
    return <Empty>The test explorer needs the desktop app.</Empty>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 px-3 py-2">
        <span className="flex-1 font-sans text-2xs uppercase tracking-widest text-fg-subtle/60">
          Tests
        </span>
        <button
          type="button"
          onClick={() => void scan(root)}
          disabled={scanning}
          title="Rescan for tests"
          className="flex h-5 w-5 items-center justify-center rounded text-fg-muted transition hover:bg-surface-2 hover:text-fg-base disabled:opacity-40"
        >
          <RefreshCw size={12} className={scanning ? 'animate-spin-slow' : ''} />
        </button>
      </div>

      {error && (
        <p className="px-3 pb-2 font-sans text-xs text-status-err">{error}</p>
      )}

      <div className="min-h-0 flex-1 overflow-auto pb-2">
        {!scanning && frameworks.length === 0 && (
          <Empty>
            No test runner found here. ARC looks for vitest or jest in
            package.json, plus Cargo.toml, go.mod and the pytest configs.
          </Empty>
        )}

        {frameworks.map((framework) => (
          <FrameworkNode
            key={framework}
            framework={framework}
            files={byFramework.get(framework) ?? []}
            status={statusOf(tests, { framework })}
            onRun={(t: Target) => void run(t)}
            onOpenFile={openFile}
            statusFor={(t: Target) => statusOf(tests, t)}
            onShowOutput={setOpenOutput}
          />
        ))}
      </div>

      {/* Output drawer — the runner's own words, not a paraphrase. */}
      {shownOutcome && (
        <div className="flex max-h-[45%] min-h-0 shrink-0 flex-col border-t border-border-hairline">
          <div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-subtle">
              {shownOutcome.command}
            </span>
            <span className="shrink-0 font-sans text-2xs text-fg-subtle">
              {shownOutcome.durationMs} ms
            </span>
            <button
              type="button"
              onClick={() => setOpenOutput(null)}
              className="shrink-0 text-fg-muted hover:text-fg-base"
            >
              <X size={12} />
            </button>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 pb-2 font-mono text-2xs leading-[16px] text-fg-base/85">
            {shownOutcome.output || '(no output)'}
          </pre>
        </div>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 py-2 font-sans text-xs leading-relaxed text-fg-subtle">{children}</p>
  );
}

// ─── Tree ────────────────────────────────────────────────────────────────────

interface FrameworkNodeProps {
  framework: Framework;
  files: TestFile[];
  status: TestStatus;
  onRun: (t: Target) => void;
  onOpenFile: (path: string) => void;
  statusFor: (t: Target) => TestStatus;
  onShowOutput: (key: string | null) => void;
}

function FrameworkNode({
  framework,
  files,
  status,
  onRun,
  onOpenFile,
  statusFor,
  onShowOutput,
}: FrameworkNodeProps) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <Row
        depth={0}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        icon={<FlaskConical size={11} className="shrink-0 text-fg-subtle" />}
        label={frameworkLabel(framework)}
        hint={`${files.length} file${files.length === 1 ? '' : 's'}`}
        status={status}
        onRun={() => onRun({ framework })}
        runTitle="Run every test for this framework"
        onShowOutput={() => onShowOutput(targetKey({ framework }))}
      />
      {open &&
        files.map((file) => (
          <FileNode
            key={file.rel}
            file={file}
            status={statusFor({ framework, rel: file.rel })}
            onRun={onRun}
            onOpenFile={onOpenFile}
            statusFor={statusFor}
            onShowOutput={onShowOutput}
          />
        ))}
      {open && files.length === 0 && (
        <p className="px-3 py-1 pl-8 font-sans text-2xs text-fg-subtle/70">
          No test files matched — the framework row still runs the whole suite.
        </p>
      )}
    </div>
  );
}

function FileNode({
  file,
  status,
  onRun,
  onOpenFile,
  statusFor,
  onShowOutput,
}: {
  file: TestFile;
  status: TestStatus;
  onRun: (t: Target) => void;
  onOpenFile: (path: string) => void;
  statusFor: (t: Target) => TestStatus;
  onShowOutput: (key: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const target: Target = { framework: file.framework, rel: file.rel };
  return (
    <div>
      <Row
        depth={1}
        open={file.tests.length > 0 ? open : undefined}
        onToggle={() => setOpen((o) => !o)}
        label={file.rel.split('/').pop() ?? file.rel}
        title={file.rel}
        hint={file.tests.length > 0 ? String(file.tests.length) : undefined}
        status={status}
        onRun={() => onRun(target)}
        runTitle="Run this file"
        onLabelClick={() => onOpenFile(file.path)}
        onShowOutput={() => onShowOutput(targetKey(target))}
      />
      {open &&
        file.tests.map((t, i) => {
          const testTarget: Target = {
            framework: file.framework,
            rel: file.rel,
            testName: t.name,
          };
          return (
            <Row
              key={`${t.name}-${i}`}
              depth={2}
              label={t.name}
              title={`${file.rel}:${t.line}`}
              status={statusFor(testTarget)}
              onRun={() => onRun(testTarget)}
              runTitle="Run this test"
              onLabelClick={() => onOpenFile(file.path)}
              onShowOutput={() => onShowOutput(targetKey(testTarget))}
            />
          );
        })}
    </div>
  );
}

// ─── Row ─────────────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: TestStatus }) {
  if (status === 'running') {
    return <Loader2 size={11} className="shrink-0 animate-spin text-fg-muted" />;
  }
  if (status === 'pass') {
    return <CheckCircle2 size={11} className="shrink-0 text-status-ok" />;
  }
  if (status === 'fail') {
    return <XCircle size={11} className="shrink-0 text-status-err" />;
  }
  // Idle keeps the column's width so rows don't shift when a run starts.
  return <span className="h-[11px] w-[11px] shrink-0" />;
}

function Row({
  depth,
  open,
  onToggle,
  icon,
  label,
  title,
  hint,
  status,
  onRun,
  runTitle,
  onLabelClick,
  onShowOutput,
}: {
  depth: number;
  open?: boolean;
  onToggle?: () => void;
  icon?: React.ReactNode;
  label: string;
  title?: string;
  hint?: string;
  status: TestStatus;
  onRun: () => void;
  runTitle: string;
  onLabelClick?: () => void;
  onShowOutput?: () => void;
}) {
  return (
    <div
      className="group flex items-center gap-1.5 py-[3px] pr-2 hover:bg-surface-1"
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      {onToggle && open !== undefined ? (
        <button
          type="button"
          onClick={onToggle}
          className="flex h-3 w-3 shrink-0 items-center justify-center text-fg-subtle hover:text-fg-base"
        >
          {open ? <ChevronDown size={10} strokeWidth={2} /> : <ChevronRight size={10} strokeWidth={2} />}
        </button>
      ) : (
        <span className="h-3 w-3 shrink-0" />
      )}
      <StatusIcon status={status} />
      {icon}
      <button
        type="button"
        title={title ?? label}
        onClick={() => {
          // A failed row's first job is to show you why it failed.
          if (status === 'fail' && onShowOutput) onShowOutput();
          else onLabelClick?.();
        }}
        className={cn(
          'min-w-0 flex-1 truncate text-left font-sans text-xs',
          status === 'fail' ? 'text-status-err' : 'text-fg-base/90',
        )}
      >
        {label}
      </button>
      {hint && (
        <span className="shrink-0 font-mono text-2xs text-fg-subtle/60 group-hover:hidden">
          {hint}
        </span>
      )}
      <button
        type="button"
        onClick={onRun}
        title={runTitle}
        disabled={status === 'running'}
        className="hidden h-4 w-4 shrink-0 items-center justify-center rounded text-fg-muted transition hover:bg-surface-2 hover:text-fg-base disabled:opacity-40 group-hover:flex"
      >
        <Play size={10} />
      </button>
    </div>
  );
}
