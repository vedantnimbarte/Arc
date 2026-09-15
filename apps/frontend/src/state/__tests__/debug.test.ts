import { beforeEach, describe, expect, it } from 'vitest';
import {
  adapterFor,
  dirname,
  parseLaunchJson,
  pathKey,
  substituteVars,
  useDebug,
} from '../debug';

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

  it('adds sorted lines and removes on a second toggle', () => {
    const { toggleBreakpoint } = useDebug.getState();
    toggleBreakpoint('C:\\a\\b.py', 9);
    toggleBreakpoint('c:/a/b.py', 3);
    expect(useDebug.getState().breakpoints[pathKey('C:\\a\\b.py')]?.lines).toEqual([3, 9]);
    toggleBreakpoint('C:\\a\\b.py', 9);
    expect(useDebug.getState().breakpoints[pathKey('C:\\a\\b.py')]?.lines).toEqual([3]);
  });
});
