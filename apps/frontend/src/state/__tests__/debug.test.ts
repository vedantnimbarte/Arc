import { beforeEach, describe, expect, it } from 'vitest';
import { EditorState, type ChangeSpec } from '@codemirror/state';
import {
  adapterFor,
  breakpointsPayload,
  dirname,
  mapBreakpoints,
  parseLaunchJson,
  pathKey,
  substituteVars,
  useDebug,
} from '../debug';
import { useFiles } from '../files';

describe('parseLaunchJson', () => {
  it('reads JSONC with comments and trailing commas', () => {
    const src = `{
      // VS Code writes this header
      "version": "0.2.0",
      "configurations": [
        /* the one we want */
        { "name": "Py", "type": "debugpy", "request": "launch", "program": "\${file}", },
        { "name": "Attach", "type": "go", "request": "attach", },
      ],
    }`;
    const configs = parseLaunchJson(src);
    expect(configs.map((c) => c.name)).toEqual(['Py', 'Attach']);
    expect(configs[0]!.program).toBe('${file}');
  });

  it('skips entries missing name, type or a valid request', () => {
    const src = JSON.stringify({
      configurations: [
        { name: 'ok', type: 'python', request: 'launch' },
        { type: 'python', request: 'launch' },
        { name: 'bad', type: 'python', request: 'run' },
        'nope',
      ],
    });
    expect(parseLaunchJson(src).map((c) => c.name)).toEqual(['ok']);
  });

  it('throws on malformed JSON so the panel can report it', () => {
    expect(() => parseLaunchJson('{ "configurations": [')).toThrow();
  });
});

describe('substituteVars', () => {
  const vars = { workspaceFolder: 'C:\\proj', file: 'C:\\proj\\src\\a.py', fileDirname: 'C:\\proj\\src' };

  it('replaces the supported variables recursively', () => {
    const out = substituteVars(
      {
        program: '${file}',
        cwd: '${workspaceFolder}',
        args: ['--dir', '${fileDirname}/out'],
        env: { ROOT: '${workspaceFolder}' },
        port: 5678,
        stopOnEntry: true,
      },
      vars,
    );
    expect(out).toEqual({
      program: 'C:\\proj\\src\\a.py',
      cwd: 'C:\\proj',
      args: ['--dir', 'C:\\proj\\src/out'],
      env: { ROOT: 'C:\\proj' },
      port: 5678,
      stopOnEntry: true,
    });
  });

  it('leaves unknown variables alone', () => {
    expect(substituteVars('${env:HOME} ${port}', vars)).toBe('${env:HOME} ${port}');
  });
});

describe('adapterFor', () => {
  it('maps types to the adapter ARC spawns', () => {
    expect(adapterFor('python')?.args).toEqual(['-m', 'debugpy.adapter']);
    expect(adapterFor('cppdbg')?.commands).toEqual(['lldb-dap', 'lldb-vscode']);
    expect(adapterFor('go')).toMatchObject({ commands: ['dlv'], transport: 'tcp' });
    expect(adapterFor('node')).toBeNull();
  });

  it("runs debugpy under the config's python, after variable substitution", () => {
    const vars = { workspaceFolder: '/proj', file: '/proj/a.py', fileDirname: '/proj' };
    const config = substituteVars({ python: '${workspaceFolder}/.venv/bin/python' }, vars);
    expect(adapterFor('debugpy', config)).toMatchObject({
      commands: ['/proj/.venv/bin/python'],
      args: ['-m', 'debugpy.adapter'],
    });
    expect(adapterFor('python', { pythonPath: 'C:\\py\\python.exe' })?.commands).toEqual(['C:\\py\\python.exe']);
    expect(adapterFor('python', { python: '' })?.commands).toEqual(['python']);
    expect(adapterFor('python')?.commands).toEqual(['python']);
  });
});

describe('paths', () => {
  it('pathKey matches Windows spellings of the same file', () => {
    expect(pathKey('C:\\a\\b.py')).toBe(pathKey('c:/a/b.py'));
    expect(pathKey('/Users/A/b.py')).not.toBe(pathKey('/users/a/b.py'));
  });

  it('dirname handles both separators', () => {
    expect(dirname('C:\\a\\b.py')).toBe('C:\\a');
    expect(dirname('/a/b/c.go')).toBe('/a/b');
  });
});

describe('toggleBreakpoint', () => {
  beforeEach(() => useDebug.setState({ breakpoints: {}, sessionId: null }));

  const path = 'C:\\a\\b.py';
  const lines = () => useDebug.getState().breakpoints[pathKey(path)]?.breakpoints.map((bp) => bp.line);

  it('adds sorted lines and removes on a second toggle', () => {
    const { toggleBreakpoint } = useDebug.getState();
    toggleBreakpoint(path, 9);
    toggleBreakpoint('c:/a/b.py', 3);
    expect(lines()).toEqual([3, 9]);
    toggleBreakpoint(path, 9);
    expect(lines()).toEqual([3]);
  });

  it('editBreakpoint adds or updates options, and blank clears one', () => {
    const { editBreakpoint } = useDebug.getState();
    editBreakpoint(path, 4, { condition: ' x > 1 ' });
    editBreakpoint(path, 4, { logMessage: 'x={x}' });
    const file = () => useDebug.getState().breakpoints[pathKey(path)]!;
    expect(file().breakpoints).toEqual([{ line: 4, condition: 'x > 1', logMessage: 'x={x}' }]);
    editBreakpoint(path, 4, { condition: '' });
    expect(file().breakpoints).toEqual([{ line: 4, condition: undefined, logMessage: 'x={x}' }]);
  });
});

describe('mapBreakpoints', () => {
  const doc = 'one\ntwo\nthree\nfour\n';
  const map = (bps: { line: number }[], changes: ChangeSpec) => {
    const state = EditorState.create({ doc });
    const tr = state.update({ changes });
    return mapBreakpoints(bps, tr.changes, state.doc, tr.state.doc).map((bp) => bp.line);
  };

  it('shifts breakpoints below an inserted or removed line break', () => {
    expect(map([{ line: 1 }, { line: 3 }], { from: 0, insert: 'zero\n' })).toEqual([2, 4]);
    // Enter at the end of line 2 pushes line 3 down, leaves line 2 alone.
    expect(map([{ line: 2 }, { line: 3 }], { from: 7, insert: '\n' })).toEqual([2, 4]);
    // Joining line 3 onto line 2 carries its breakpoint up.
    expect(map([{ line: 3 }], { from: 7, to: 8 })).toEqual([2]);
  });

  it('keeps a breakpoint whose line text is edited or replaced', () => {
    expect(map([{ line: 2 }], { from: 4, to: 7, insert: 'TWO' })).toEqual([2]);
    expect(map([{ line: 2 }], { from: 5, insert: 'x' })).toEqual([2]);
  });

  it('drops a breakpoint whose whole line was deleted', () => {
    expect(map([{ line: 2 }, { line: 3 }], { from: 4, to: 8 })).toEqual([2]);
    expect(map([{ line: 1 }, { line: 4 }], { from: 0, to: 14 })).toEqual([1]);
  });

  it('keeps one breakpoint when two land on the same line, with its options', () => {
    const bps = [{ line: 2, condition: 'a' }, { line: 3 }];
    const state = EditorState.create({ doc });
    const tr = state.update({ changes: { from: 7, to: 8 } });
    expect(mapBreakpoints(bps, tr.changes, state.doc, tr.state.doc)).toEqual([{ line: 2, condition: 'a' }]);
  });
});

describe('breakpointsPayload', () => {
  const bps = [
    { line: 1, verified: true },
    { line: 2, condition: 'x > 1', hitCondition: '3' },
    { line: 3, logMessage: 'x={x}' },
  ];

  it('sends every option before the capabilities are known', () => {
    expect(breakpointsPayload(bps, null)).toEqual({
      breakpoints: [{ line: 1 }, { line: 2, condition: 'x > 1', hitCondition: '3' }, { line: 3, logMessage: 'x={x}' }],
      dropped: [],
    });
  });

  it('leaves out options the adapter does not support, and says which', () => {
    const caps = { supportsConditionalBreakpoints: true, supportsHitConditionalBreakpoints: false };
    expect(breakpointsPayload(bps, caps)).toEqual({
      breakpoints: [{ line: 1 }, { line: 2, condition: 'x > 1' }, { line: 3 }],
      dropped: ['hitCondition', 'logMessage'],
    });
  });
});

describe('watch list', () => {
  beforeEach(() => {
    useDebug.setState({ watches: {}, sessionId: null });
    useFiles.setState({ root: '/proj' });
  });

  it('adds, edits and removes expressions per workspace root', () => {
    const { addWatch, editWatch, removeWatch } = useDebug.getState();
    addWatch('  x + 1 ');
    addWatch('   ');
    addWatch('items');
    expect(useDebug.getState().watches['/proj']).toEqual(['x + 1', 'items']);

    editWatch(0, 'x * 2');
    expect(useDebug.getState().watches['/proj']).toEqual(['x * 2', 'items']);
    // Clearing an expression removes it.
    editWatch(1, '');
    expect(useDebug.getState().watches['/proj']).toEqual(['x * 2']);

    useFiles.setState({ root: '/other' });
    addWatch('y');
    removeWatch(0);
    expect(useDebug.getState().watches).toEqual({ '/proj': ['x * 2'], '/other': [] });
  });
});
