import { create } from 'zustand';
import {
  dapRequest,
  dapStart,
  dapStop,
  fsPickFiles,
  fsReadFile,
  isTauri,
  onDapEvent,
  type DapBreakpoint,
  type DapEvent,
} from '../lib/tauri';
import { parseJsonc } from '../lib/vscodeTheme';
import { isRemotePath } from '../lib/remote';
import { useFiles } from './files';
import { useWorkspace } from './workspace';

// Debugger state: launch configs, breakpoints, and the one live session the
// Debug panel drives. The adapter plumbing lives in `arc-dap`; this store only
// turns its events into something the panel and editor gutter can render.
//
// ponytail: one session at a time in the UI (the Rust side already keys by
// id), no watch expressions, no conditional breakpoints, no multi-root.

// ─── Launch configs (pure — see state/__tests__/debug.test.ts) ─────────────

export interface LaunchConfig {
  name: string;
  type: string;
  request: 'launch' | 'attach';
  [key: string]: unknown;
}

/** Placeholder the lldb quick config uses; resolved with a file picker. */
export const PICK_EXECUTABLE = '${command:pickExecutable}';

export const QUICK_CONFIGS: LaunchConfig[] = [
  {
    name: 'Python: current file',
    type: 'python',
    request: 'launch',
    program: '${file}',
    cwd: '${fileDirname}',
    console: 'internalConsole',
  },
  {
    name: 'Debug with lldb-dap: pick executable',
    type: 'lldb',
    request: 'launch',
    program: PICK_EXECUTABLE,
    cwd: '${workspaceFolder}',
  },
];

/** The usable `configurations` from a `.vscode/launch.json` (JSONC). Throws on
 *  malformed JSON so the panel can say so; skips entries missing a name,
 *  type or request. */
export function parseLaunchJson(text: string): LaunchConfig[] {
  const json = parseJsonc(text) as { configurations?: unknown };
  const list = Array.isArray(json?.configurations) ? json.configurations : [];
  return list.filter(
    (c): c is LaunchConfig =>
      !!c &&
      typeof c === 'object' &&
      typeof (c as LaunchConfig).name === 'string' &&
      typeof (c as LaunchConfig).type === 'string' &&
      ((c as LaunchConfig).request === 'launch' || (c as LaunchConfig).request === 'attach'),
  );
}

export interface LaunchVars {
  workspaceFolder: string;
  file: string;
  fileDirname: string;
}

/** Replace `${workspaceFolder}`, `${file}` and `${fileDirname}` in every
 *  string of `value`, recursively. Unknown variables are left as written. */
export function substituteVars<T>(value: T, vars: LaunchVars): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{(workspaceFolder|file|fileDirname)\}/g, (_, k: keyof LaunchVars) =>
      vars[k],
    ) as T;
  }
  if (Array.isArray(value)) return value.map((v) => substituteVars(v, vars)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substituteVars(v, vars)]),
    ) as T;
  }
  return value;
}

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i > 0 ? path.slice(0, i) : path;
}

export interface AdapterSpec {
  /** Tried in order; the next is used only when one isn't on PATH. */
  commands: string[];
  args: string[];
  transport: 'stdio' | 'tcp';
  /** What to tell the user to install when it won't start. */
  install: string;
}

/** Map a launch config's `type` to the adapter ARC spawns for it. */
export function adapterFor(type: string): AdapterSpec | null {
  switch (type) {
    case 'python':
    case 'debugpy':
      return {
        commands: ['python'],
        args: ['-m', 'debugpy.adapter'],
        transport: 'stdio',
        install: 'debugpy (pip install debugpy)',
      };
    case 'lldb':
    case 'lldb-dap':
    case 'lldb-vscode':
    case 'codelldb':
    case 'cppdbg':
    case 'cppvsdbg':
      return {
        commands: ['lldb-dap', 'lldb-vscode'],
        args: [],
        transport: 'stdio',
        install: 'lldb-dap (ships with LLVM 18+)',
      };
    case 'go':
      return {
        commands: ['dlv'],
        args: ['dap', '--listen', '127.0.0.1:${port}'],
        transport: 'tcp',
        install: 'Delve (go install github.com/go-delve/delve/cmd/dlv@latest)',
      };
    default:
      return null;
  }
}

/** Key for comparing paths from the editor and from an adapter, which spell
 *  the same file differently on Windows (slashes, drive-letter case). */
export function pathKey(path: string): string {
  const p = path.replace(/\\/g, '/');
  return /^[a-zA-Z]:\//.test(p) ? p.toLowerCase() : p;
}

// ─── Store ──────────────────────────────────────────────────────────────────

export interface DapThread {
  id: number;
  name: string;
}
export interface DapStackFrame {
  id: number;
  name: string;
  line: number;
  source?: { path?: string; name?: string };
}
export interface DapScope {
  name: string;
  variablesReference: number;
}
export interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

export interface BreakpointFile {
  /** As first toggled — the spelling sent to the adapter. */
  path: string;
  lines: number[];
  /** line → adapter verdict, for the current session only. */
  verified: Record<number, boolean>;
}

export type DebugStatus = 'idle' | 'starting' | 'running' | 'stopped';

interface DebugState {
  configs: LaunchConfig[];
  /** Whether `configs` came from launch.json or are the built-in fallbacks. */
  fromLaunchJson: boolean;
  configError: string | null;
  selected: number;
  status: DebugStatus;
  sessionId: string | null;
  /** Keyed by `pathKey`. Kept for the app session, across debug sessions. */
  breakpoints: Record<string, BreakpointFile>;
  threads: DapThread[];
  threadId: number | null;
  frames: DapStackFrame[];
  frameId: number | null;
  scopes: DapScope[];
  /** Children by `variablesReference`, fetched on expand. */
  variables: Record<number, DapVariable[]>;
  /** Where the selected frame is — drives the editor's current-line mark. */
  location: { path: string; line: number } | null;
  output: { category: string; text: string }[];

  loadConfigs: (root: string | null) => Promise<void>;
  select: (index: number) => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** continue / next / stepIn / stepOut / pause on the current thread. */
  step: (command: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause') => Promise<void>;
  toggleBreakpoint: (path: string, line: number) => void;
  selectFrame: (frame: DapStackFrame) => Promise<void>;
  loadVariables: (ref: number) => Promise<void>;
  evaluate: (expression: string) => Promise<void>;
}

const OUTPUT_CAP = 2000;

/** Session-scoped fields, reset whenever a session ends. */
const IDLE = {
  status: 'idle' as DebugStatus,
  sessionId: null,
  threads: [],
  threadId: null,
  frames: [],
  frameId: null,
  scopes: [],
  variables: {},
  location: null,
};

let unlisten: (() => void) | null = null;

function activeEditorPath(): string | null {
  const ws = useWorkspace.getState();
  const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
  return tab?.kind === 'editor' && tab.filePath ? tab.filePath : null;
}

/** Open `path` at `line`, reusing an open tab even if the adapter spells the
 *  path differently from how the tab was opened. */
function openAt(path: string, line: number) {
  const ws = useWorkspace.getState();
  const key = pathKey(path);
  const tab = ws.tabs.find((t) => t.kind === 'editor' && t.filePath && pathKey(t.filePath) === key);
  ws.openFile(tab?.filePath ?? path, undefined, { line });
}

export const useDebug = create<DebugState>((set, get) => {
  const log = (text: string, category = 'console') =>
    set((s) => ({ output: [...s.output, { category, text }].slice(-OUTPUT_CAP) }));

  /** Record the adapter's verdict for one file's breakpoints (same order). */
  const applyVerdict = (path: string, bps: DapBreakpoint[] | null | undefined) =>
    set((s) => {
      const key = pathKey(path);
      const file = s.breakpoints[key];
      if (!file) return s;
      const verified: Record<number, boolean> = {};
      file.lines.forEach((line, i) => (verified[line] = bps?.[i]?.verified ?? false));
      return { breakpoints: { ...s.breakpoints, [key]: { ...file, verified } } };
    });

  const sendBreakpoints = async (file: BreakpointFile) => {
    const id = get().sessionId;
    if (!id) return;
    try {
      const body = await dapRequest<{ breakpoints?: DapBreakpoint[] }>(id, 'setBreakpoints', {
        source: { path: file.path },
        breakpoints: file.lines.map((line) => ({ line })),
      });
      applyVerdict(file.path, body.breakpoints);
    } catch (err) {
      log(`setBreakpoints failed: ${err}`, 'stderr');
    }
  };

  const endSession = async () => {
    const id = get().sessionId;
    unlisten?.();
    unlisten = null;
    set((s) => ({
      ...IDLE,
      // Verdicts belong to the session that gave them.
      breakpoints: Object.fromEntries(
        Object.entries(s.breakpoints).map(([k, f]) => [k, { ...f, verified: {} }]),
      ),
    }));
    if (id) await dapStop(id).catch(() => {});
  };

  const onStopped = async (id: string, threadId: number | null) => {
    try {
      const { threads } = await dapRequest<{ threads: DapThread[] }>(id, 'threads');
      const tid = threadId ?? threads[0]?.id ?? null;
      set({ threads, threadId: tid });
      if (tid === null) return;
      const { stackFrames } = await dapRequest<{ stackFrames: DapStackFrame[] }>(id, 'stackTrace', {
        threadId: tid,
        levels: 50,
      });
      set({ frames: stackFrames });
      const top = stackFrames[0];
      if (top) await get().selectFrame(top);
    } catch (err) {
      log(`Could not read the stopped state: ${err}`, 'stderr');
    }
  };

  const handleEvent = (ev: DapEvent) => {
    const id = get().sessionId;
    if (!id || ev.session_id !== id) return;
    const body = ev.body ?? {};
    switch (ev.event) {
      case 'stopped':
        set({ status: 'stopped', threadId: body.threadId ?? get().threadId });
        void onStopped(id, body.threadId ?? get().threadId);
        return;
      case 'continued':
        set({ status: 'running', frames: [], frameId: null, scopes: [], variables: {}, location: null });
        return;
      case 'output':
        if (body.category !== 'telemetry' && typeof body.output === 'string') {
          log(body.output, body.category ?? 'console');
        }
        return;
      case 'breakpoint': {
        const bp: DapBreakpoint | undefined = body.breakpoint;
        const path = bp?.source?.path;
        if (!bp || !path || bp.line === undefined) return;
        set((s) => {
          const file = s.breakpoints[pathKey(path)];
          if (!file || !file.lines.includes(bp.line!)) return s;
          return {
            breakpoints: {
              ...s.breakpoints,
              [pathKey(path)]: { ...file, verified: { ...file.verified, [bp.line!]: bp.verified } },
            },
          };
        });
        return;
      }
      case 'exited':
        log(`Process exited with code ${body.exitCode}\n`);
        return;
      case 'terminated':
      case 'adapterExited':
        void endSession();
        return;
    }
  };

  return {
    configs: QUICK_CONFIGS,
    fromLaunchJson: false,
    configError: null,
    selected: 0,
    ...IDLE,
    breakpoints: {},
    output: [],

    loadConfigs: async (root) => {
      if (!root || !isTauri || isRemotePath(root)) {
        set({ configs: QUICK_CONFIGS, fromLaunchJson: false, configError: null, selected: 0 });
        return;
      }
      let text: string;
      try {
        text = await fsReadFile(`${root}/.vscode/launch.json`);
      } catch {
        set({ configs: QUICK_CONFIGS, fromLaunchJson: false, configError: null, selected: 0 });
        return;
      }
      try {
        const configs = parseLaunchJson(text);
        set({
          configs: configs.length > 0 ? configs : QUICK_CONFIGS,
          fromLaunchJson: configs.length > 0,
          configError: null,
          selected: 0,
        });
      } catch (err) {
        set({
          configs: QUICK_CONFIGS,
          fromLaunchJson: false,
          configError: `launch.json: ${err}`,
          selected: 0,
        });
      }
    },

    select: (selected) => set({ selected }),

    start: async () => {
      if (get().sessionId) return;
      const raw = get().configs[get().selected];
      if (!raw) return;
      const adapter = adapterFor(raw.type);
      if (!adapter) {
        log(`Debug type "${raw.type}" is not supported. ARC drives debugpy, lldb-dap and dlv.\n`, 'stderr');
        return;
      }
      const root = useFiles.getState().root ?? '';
      const file = activeEditorPath() ?? '';
      let config: LaunchConfig = { ...raw };
      if (config.program === PICK_EXECUTABLE) {
        const [picked] = await fsPickFiles(root || null);
        if (!picked) return;
        config.program = picked;
      }
      config = substituteVars(config, { workspaceFolder: root, file, fileDirname: file ? dirname(file) : root });
      // ARC answers runInTerminal with "unsupported", so ask debugpy for its
      // internal console up front rather than have the launch fail.
      if (adapter.args.includes('debugpy.adapter')) config.console = 'internalConsole';

      const id = `dbg-${Date.now()}`;
      set({ ...IDLE, status: 'starting', sessionId: id, output: [] });
      unlisten = await onDapEvent(id, handleEvent);
      const files = Object.values(get().breakpoints).filter((f) => f.lines.length > 0);
      const cwd = typeof config.cwd === 'string' && config.cwd ? config.cwd : root || null;

      for (const [i, command] of adapter.commands.entries()) {
        try {
          log(`Starting ${command} ${adapter.args.join(' ')}\n`);
          const result = await dapStart(id, {
            command,
            args: adapter.args,
            cwd,
            transport: adapter.transport,
            request: config.request,
            config,
            breakpoints: files.map((f) => ({ path: f.path, lines: f.lines })),
          });
          if (get().sessionId !== id) return; // stopped while starting
          for (const r of result.breakpoints) applyVerdict(r.path, r.breakpoints);
          if (get().status === 'starting') set({ status: 'running' });
          return;
        } catch (err) {
          const missing = String(err).includes('not found on PATH');
          if (missing && i < adapter.commands.length - 1) continue;
          if (get().sessionId !== id) return;
          log(`${err}\n`, 'stderr');
          log(`Could not start the debug adapter. Is ${adapter.install} installed and on PATH?\n`, 'stderr');
          await endSession();
          return;
        }
      }
    },

    stop: endSession,

    step: async (command) => {
      const { sessionId: id, threadId } = get();
      if (!id) return;
      const tid = threadId ?? get().threads[0]?.id;
      try {
        await dapRequest(id, command, { threadId: tid ?? 0 });
        if (command !== 'pause') {
          set({ status: 'running', frames: [], frameId: null, scopes: [], variables: {}, location: null });
        }
      } catch (err) {
        log(`${command} failed: ${err}\n`, 'stderr');
      }
    },

    toggleBreakpoint: (path, line) => {
      const key = pathKey(path);
      const file = get().breakpoints[key] ?? { path, lines: [], verified: {} };
      const lines = file.lines.includes(line)
        ? file.lines.filter((l) => l !== line)
        : [...file.lines, line].sort((a, b) => a - b);
      const next = { ...file, lines };
      set((s) => ({ breakpoints: { ...s.breakpoints, [key]: next } }));
      void sendBreakpoints(next);
    },

    selectFrame: async (frame) => {
      const id = get().sessionId;
      if (!id) return;
      const path = frame.source?.path;
      set({ frameId: frame.id, location: path ? { path, line: frame.line } : null, scopes: [], variables: {} });
      if (path) openAt(path, frame.line);
      try {
        const { scopes } = await dapRequest<{ scopes: DapScope[] }>(id, 'scopes', { frameId: frame.id });
        set({ scopes });
      } catch (err) {
        log(`scopes failed: ${err}\n`, 'stderr');
      }
    },

    loadVariables: async (ref) => {
      const id = get().sessionId;
      if (!id || get().variables[ref]) return;
      try {
        const { variables } = await dapRequest<{ variables: DapVariable[] }>(id, 'variables', {
          variablesReference: ref,
        });
        set((s) => ({ variables: { ...s.variables, [ref]: variables } }));
      } catch (err) {
        log(`variables failed: ${err}\n`, 'stderr');
      }
    },

    evaluate: async (expression) => {
      const id = get().sessionId;
      if (!id || !expression.trim()) return;
      log(`> ${expression}\n`, 'input');
      try {
        const body = await dapRequest<{ result: string }>(id, 'evaluate', {
          expression,
          frameId: get().frameId ?? undefined,
          context: 'repl',
        });
        log(`${body.result}\n`, 'result');
      } catch (err) {
        log(`${err}\n`, 'stderr');
      }
    },
  };
});
