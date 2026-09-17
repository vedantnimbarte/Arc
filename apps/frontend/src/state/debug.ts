import { create } from 'zustand';
import type { ChangeDesc, Text } from '@codemirror/state';
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
// id), no multi-root.

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

/** Map a launch config's `type` to the adapter ARC spawns for it. `config`
 *  (already substituted) can pick the interpreter: debugpy's `python`, or the
 *  older `pythonPath`, runs the adapter instead of `python` from PATH. */
export function adapterFor(type: string, config?: Record<string, unknown>): AdapterSpec | null {
  switch (type) {
    case 'python':
    case 'debugpy': {
      const python = [config?.python, config?.pythonPath].find(
        (p): p is string => typeof p === 'string' && p.trim() !== '',
      );
      return {
        commands: [python ?? 'python'],
        args: ['-m', 'debugpy.adapter'],
        transport: 'stdio',
        install: 'debugpy (pip install debugpy)',
      };
    }
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

// ─── Breakpoints (pure) ─────────────────────────────────────────────────────

export interface Breakpoint {
  /** 1-based. */
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  /** The adapter's verdict, for the current session only. */
  verified?: boolean;
}

export type BreakpointOption = 'condition' | 'hitCondition' | 'logMessage';

/** Each option, the capability an adapter must advertise before it's sent,
 *  and how the console note names it. `arc-dap` gates the breakpoints sent
 *  during the start handshake with the same table. */
export const BREAKPOINT_OPTIONS: Record<BreakpointOption, { capability: string; label: string }> = {
  condition: { capability: 'supportsConditionalBreakpoints', label: 'conditions' },
  hitCondition: { capability: 'supportsHitConditionalBreakpoints', label: 'hit counts' },
  logMessage: { capability: 'supportsLogPoints', label: 'log messages' },
};

/** The `breakpoints` of a `setBreakpoints` request, leaving out options the
 *  adapter's `caps` don't cover (`null`: not known yet, send them all).
 *  `dropped` lists the options that were set but left out. */
export function breakpointsPayload(
  bps: Breakpoint[],
  caps: Record<string, unknown> | null,
): { breakpoints: Omit<Breakpoint, 'verified'>[]; dropped: BreakpointOption[] } {
  const dropped = new Set<BreakpointOption>();
  const breakpoints = bps.map((bp) => {
    const out: Omit<Breakpoint, 'verified'> = { line: bp.line };
    for (const option of Object.keys(BREAKPOINT_OPTIONS) as BreakpointOption[]) {
      if (!bp[option]) continue;
      if (caps && caps[BREAKPOINT_OPTIONS[option].capability] !== true) dropped.add(option);
      else out[option] = bp[option];
    }
    return out;
  });
  return { breakpoints, dropped: [...dropped] };
}

/** Carry breakpoints through an edit from `before` to `after`: each follows
 *  the start of its line, and one whose line was deleted outright (text and
 *  line break) is dropped. Two landing on one line keep the first. */
export function mapBreakpoints<T extends { line: number }>(
  bps: T[],
  changes: ChangeDesc,
  before: Text,
  after: Text,
): T[] {
  const out = new Map<number, T>();
  for (const bp of bps) {
    if (bp.line < 1 || bp.line > before.lines) continue;
    const { from, to } = before.line(bp.line);
    let deleted = false;
    changes.iterChangedRanges((fromA, toA) => {
      if (fromA <= from && toA >= to && (fromA < from || toA > to)) deleted = true;
    });
    if (deleted) continue;
    const line = after.lineAt(changes.mapPos(from, 1)).number;
    if (!out.has(line)) out.set(line, { ...bp, line });
  }
  return [...out.values()].sort((a, b) => a.line - b.line);
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
  /** Sorted by line. */
  breakpoints: Breakpoint[];
}

export interface WatchResult {
  value?: string;
  error?: string;
  variablesReference: number;
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
  /** What the live adapter answered `initialize` with. */
  capabilities: Record<string, unknown> | null;
  /** Keyed by `pathKey`. Kept for the app session, across debug sessions. */
  breakpoints: Record<string, BreakpointFile>;
  /** Watch expressions by workspace root, kept for the app session. */
  watches: Record<string, string[]>;
  /** By expression, for the selected frame. */
  watchResults: Record<string, WatchResult>;
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
  /** Set (or with `''`, clear) options on the breakpoint at `line`, adding
   *  one there if there isn't one. */
  editBreakpoint: (path: string, line: number, options: Partial<Record<BreakpointOption, string>>) => void;
  /** Follow an edit to `path` — see `mapBreakpoints`. */
  moveBreakpoints: (path: string, changes: ChangeDesc, before: Text, after: Text) => void;
  selectFrame: (frame: DapStackFrame) => Promise<void>;
  loadVariables: (ref: number) => Promise<void>;
  evaluate: (expression: string) => Promise<void>;
  /** Watch list edits apply to the current workspace root's list. */
  addWatch: (expression: string) => void;
  editWatch: (index: number, expression: string) => void;
  removeWatch: (index: number) => void;
  /** Evaluate every watch against the selected frame. */
  refreshWatches: () => Promise<void>;
}

const OUTPUT_CAP = 2000;
/** How long edits settle before moved breakpoints are resent. */
const RESEND_DELAY_MS = 500;

/** Frame-scoped fields, cleared whenever the debuggee runs again. */
const RUNNING = {
  frames: [],
  frameId: null,
  scopes: [],
  variables: {},
  location: null,
  watchResults: {},
};

/** Session-scoped fields, reset whenever a session ends. */
const IDLE = {
  ...RUNNING,
  status: 'idle' as DebugStatus,
  sessionId: null,
  capabilities: null,
  threads: [],
  threadId: null,
};

let unlisten: (() => void) | null = null;
const resendTimers = new Map<string, ReturnType<typeof setTimeout>>();

const watchRoot = () => useFiles.getState().root ?? '';

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
      const breakpoints = file.breakpoints.map((bp, i) => ({ ...bp, verified: bps?.[i]?.verified ?? false }));
      return { breakpoints: { ...s.breakpoints, [key]: { ...file, breakpoints } } };
    });

  /** A console note for options the live adapter can't take. */
  const noteDropped = (dropped: BreakpointOption[]) => {
    if (dropped.length === 0) return;
    const what = dropped.map((o) => BREAKPOINT_OPTIONS[o].label).join(', ');
    log(`This debug adapter doesn't support breakpoint ${what}; those breakpoints break unconditionally.\n`, 'stderr');
  };

  const setFile = (key: string, file: BreakpointFile) =>
    set((s) => ({ breakpoints: { ...s.breakpoints, [key]: file } }));

  /** Edit the current root's watch list, then re-evaluate it. */
  const updateWatches = (edit: (list: string[]) => string[]) => {
    const root = watchRoot();
    set((s) => ({ watches: { ...s.watches, [root]: edit(s.watches[root] ?? []) } }));
    void get().refreshWatches();
  };

  const sendBreakpoints = async (file: BreakpointFile) => {
    const id = get().sessionId;
    if (!id) return;
    try {
      const body = await dapRequest<{ breakpoints?: DapBreakpoint[] }>(id, 'setBreakpoints', {
        source: { path: file.path },
        breakpoints: breakpointsPayload(file.breakpoints, get().capabilities).breakpoints,
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
    for (const timer of resendTimers.values()) clearTimeout(timer);
    resendTimers.clear();
    set((s) => ({
      ...IDLE,
      // Verdicts belong to the session that gave them.
      breakpoints: Object.fromEntries(
        Object.entries(s.breakpoints).map(([k, f]) => [
          k,
          { ...f, breakpoints: f.breakpoints.map((bp) => ({ ...bp, verified: undefined })) },
        ]),
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
        set({ status: 'running', ...RUNNING });
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
          if (!file || !file.breakpoints.some((b) => b.line === bp.line)) return s;
          const breakpoints = file.breakpoints.map((b) => (b.line === bp.line ? { ...b, verified: bp.verified } : b));
          return { breakpoints: { ...s.breakpoints, [pathKey(path)]: { ...file, breakpoints } } };
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
    watches: {},
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
      const root = useFiles.getState().root ?? '';
      const file = activeEditorPath() ?? '';
      const config = substituteVars(raw, { workspaceFolder: root, file, fileDirname: file ? dirname(file) : root });
      const adapter = adapterFor(config.type, config);
      if (!adapter) {
        log(`Debug type "${raw.type}" is not supported. ARC drives debugpy, lldb-dap and dlv.\n`, 'stderr');
        return;
      }
      if (config.program === PICK_EXECUTABLE) {
        const [picked] = await fsPickFiles(root || null);
        if (!picked) return;
        config.program = picked;
      }
      // ARC answers runInTerminal with "unsupported", so ask debugpy for its
      // internal console up front rather than have the launch fail.
      if (adapter.args.includes('debugpy.adapter')) config.console = 'internalConsole';

      const id = `dbg-${Date.now()}`;
      set({ ...IDLE, status: 'starting', sessionId: id, output: [] });
      unlisten = await onDapEvent(id, handleEvent);
      const files = Object.values(get().breakpoints).filter((f) => f.breakpoints.length > 0);
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
            // Unfiltered: `arc-dap` drops what the adapter can't take once
            // `initialize` has said what that is.
            breakpoints: files.map((f) => ({ path: f.path, breakpoints: breakpointsPayload(f.breakpoints, null).breakpoints })),
          });
          if (get().sessionId !== id) return; // stopped while starting
          set({ capabilities: result.capabilities });
          noteDropped([
            ...new Set(files.flatMap((f) => breakpointsPayload(f.breakpoints, result.capabilities).dropped)),
          ]);
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
        if (command !== 'pause') set({ status: 'running', ...RUNNING });
      } catch (err) {
        log(`${command} failed: ${err}\n`, 'stderr');
      }
    },

    toggleBreakpoint: (path, line) => {
      const key = pathKey(path);
      const file = get().breakpoints[key] ?? { path, breakpoints: [] };
      const breakpoints = file.breakpoints.some((bp) => bp.line === line)
        ? file.breakpoints.filter((bp) => bp.line !== line)
        : [...file.breakpoints, { line }].sort((a, b) => a.line - b.line);
      const next = { ...file, breakpoints };
      setFile(key, next);
      void sendBreakpoints(next);
    },

    editBreakpoint: (path, line, options) => {
      const key = pathKey(path);
      const file = get().breakpoints[key] ?? { path, breakpoints: [] };
      const current = file.breakpoints.find((bp) => bp.line === line) ?? { line };
      const edited: Breakpoint = { ...current };
      for (const [option, value] of Object.entries(options) as [BreakpointOption, string][]) {
        edited[option] = value.trim() || undefined;
      }
      const next = {
        ...file,
        breakpoints: [...file.breakpoints.filter((bp) => bp.line !== line), edited].sort((a, b) => a.line - b.line),
      };
      setFile(key, next);
      if (get().capabilities) noteDropped(breakpointsPayload([edited], get().capabilities).dropped);
      void sendBreakpoints(next);
    },

    moveBreakpoints: (path, changes, before, after) => {
      const key = pathKey(path);
      const file = get().breakpoints[key];
      if (!file || file.breakpoints.length === 0) return;
      const moved = mapBreakpoints(file.breakpoints, changes, before, after);
      if (moved.length === file.breakpoints.length && moved.every((bp, i) => bp.line === file.breakpoints[i]!.line)) {
        return;
      }
      setFile(key, { ...file, breakpoints: moved });
      if (!get().sessionId) return;
      clearTimeout(resendTimers.get(key));
      resendTimers.set(
        key,
        setTimeout(() => {
          resendTimers.delete(key);
          const latest = get().breakpoints[key];
          if (latest) void sendBreakpoints(latest);
        }, RESEND_DELAY_MS),
      );
    },

    selectFrame: async (frame) => {
      const id = get().sessionId;
      if (!id) return;
      const path = frame.source?.path;
      set({ frameId: frame.id, location: path ? { path, line: frame.line } : null, scopes: [], variables: {} });
      if (path) openAt(path, frame.line);
      void get().refreshWatches();
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

    addWatch: (expression) => {
      if (!expression.trim()) return;
      updateWatches((list) => [...list, expression.trim()]);
    },

    editWatch: (index, expression) =>
      updateWatches((list) =>
        expression.trim()
          ? list.map((e, i) => (i === index ? expression.trim() : e))
          : list.filter((_, i) => i !== index),
      ),

    removeWatch: (index) => updateWatches((list) => list.filter((_, i) => i !== index)),

    refreshWatches: async () => {
      const { sessionId: id, frameId } = get();
      const expressions = get().watches[watchRoot()] ?? [];
      if (!id || frameId === null || expressions.length === 0) return;
      const results = await Promise.all(
        expressions.map(async (expression): Promise<[string, WatchResult]> => {
          try {
            const body = await dapRequest<{ result: string; variablesReference?: number }>(id, 'evaluate', {
              expression,
              frameId,
              context: 'watch',
            });
            return [expression, { value: body.result, variablesReference: body.variablesReference ?? 0 }];
          } catch (err) {
            return [expression, { error: String(err).replace(/^evaluate: /, ''), variablesReference: 0 }];
          }
        }),
      );
      // Stale if the debuggee moved on or another frame was picked meanwhile.
      if (get().sessionId !== id || get().frameId !== frameId) return;
      set({ watchResults: Object.fromEntries(results) });
    },
  };
});
