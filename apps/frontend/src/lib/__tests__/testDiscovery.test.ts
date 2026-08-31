import { describe, expect, it } from 'vitest';
import {
  detectFrameworks,
  escapeRegex,
  isTestFile,
  parseTests,
  runSpec,
} from '../testDiscovery';

const NO_MANIFESTS = {
  packageJson: null,
  cargoToml: null,
  goMod: null,
  pyProject: null,
  setupPy: null,
  setupCfg: null,
  toxIni: null,
  pytestIni: null,
};

describe('detectFrameworks', () => {
  it('picks vitest over jest when a repo declares both', () => {
    const pkg = '{"devDependencies":{"jest":"^29","vitest":"^2"}}';
    expect(detectFrameworks({ ...NO_MANIFESTS, packageJson: pkg })).toEqual(['vitest']);
  });

  it('finds jest on its own', () => {
    const pkg = '{"devDependencies":{"jest":"^29"}}';
    expect(detectFrameworks({ ...NO_MANIFESTS, packageJson: pkg })).toEqual(['jest']);
  });

  it('reports every runner a polyglot repo has', () => {
    expect(
      detectFrameworks({
        ...NO_MANIFESTS,
        packageJson: '{"devDependencies":{"vitest":"^2"}}',
        cargoToml: '[package]',
        goMod: 'module x',
        pyProject: '[project]',
      }),
    ).toEqual(['vitest', 'cargo', 'gotest', 'pytest']);
  });

  it('finds nothing in a repo with no manifests', () => {
    expect(detectFrameworks(NO_MANIFESTS)).toEqual([]);
    // A package.json with no test runner is not a JS test project.
    expect(detectFrameworks({ ...NO_MANIFESTS, packageJson: '{"name":"x"}' })).toEqual([]);
  });
});

describe('isTestFile', () => {
  it('matches the JS conventions and nothing else', () => {
    expect(isTestFile('src/a.test.ts', 'vitest')).toBe(true);
    expect(isTestFile('src/a.spec.tsx', 'vitest')).toBe(true);
    expect(isTestFile('src/a.test.mjs', 'jest')).toBe(true);
    expect(isTestFile('src/a.ts', 'vitest')).toBe(false);
    expect(isTestFile('src/testing.ts', 'vitest')).toBe(false);
  });

  it('matches both pytest spellings', () => {
    expect(isTestFile('tests/test_a.py', 'pytest')).toBe(true);
    expect(isTestFile('a_test.py', 'pytest')).toBe(true);
    expect(isTestFile('contest.py', 'pytest')).toBe(false);
  });

  it('matches go and cargo layouts', () => {
    expect(isTestFile('pkg/a_test.go', 'gotest')).toBe(true);
    expect(isTestFile('pkg/a.go', 'gotest')).toBe(false);
    expect(isTestFile('rust/db/tests/live.rs', 'cargo')).toBe(true);
    expect(isTestFile('rust/db/src/lib.rs', 'cargo')).toBe(false);
  });
});

describe('parseTests', () => {
  it('reads JS test names with their line numbers', () => {
    const src = [
      "import { it } from 'vitest';",
      "describe('group', () => {",
      "  it('does a thing', () => {});",
      '  test.only("another", () => {});',
      '  it.skip(`templated`, () => {});',
      '});',
    ].join('\n');
    expect(parseTests(src, 'vitest')).toEqual([
      { name: 'does a thing', line: 3 },
      { name: 'another', line: 4 },
      { name: 'templated', line: 5 },
    ]);
  });

  it('skips a name it cannot know without running the file', () => {
    expect(parseTests('it(`case ${n}`, () => {});', 'vitest')).toEqual([]);
  });

  it('does not mistake an unrelated identifier for a test', () => {
    const src = ["visit('/home');", "await omit('x');", "it ('spaced', () => {});"].join('\n');
    expect(parseTests(src, 'vitest')).toEqual([{ name: 'spaced', line: 3 }]);
  });

  it('reads python test functions', () => {
    const src = ['def helper():', '    pass', '', 'def test_adds():', '    assert 1'].join('\n');
    expect(parseTests(src, 'pytest')).toEqual([{ name: 'test_adds', line: 4 }]);
  });

  it('reads go test functions but not ordinary ones', () => {
    const src = ['func helper() {}', 'func TestAdds(t *testing.T) {}', 'func BenchmarkX(b *testing.B) {}'].join('\n');
    expect(parseTests(src, 'gotest')).toEqual([
      { name: 'TestAdds', line: 2 },
      { name: 'BenchmarkX', line: 3 },
    ]);
  });

  it('reads rust tests through their attributes', () => {
    const src = [
      '#[test]',
      'fn adds() {}',
      '',
      '#[tokio::test]',
      'async fn awaits() {}',
      '',
      '#[test]',
      '#[should_panic]',
      'fn panics() {}',
      '',
      'fn not_a_test() {}',
    ].join('\n');
    expect(parseTests(src, 'cargo')).toEqual([
      { name: 'adds', line: 2 },
      { name: 'awaits', line: 5 },
      { name: 'panics', line: 9 },
    ]);
  });
});

describe('runSpec', () => {
  it('scopes vitest to a file and then to one test', () => {
    expect(runSpec('vitest', { manager: 'pnpm' })).toEqual({
      program: 'pnpm',
      args: ['exec', 'vitest', 'run', '--reporter=basic'],
    });
    expect(runSpec('vitest', { manager: 'pnpm', rel: 'src/a.test.ts', testName: 'does (x)' })).toEqual(
      {
        program: 'pnpm',
        args: ['exec', 'vitest', 'run', '--reporter=basic', 'src/a.test.ts', '-t', 'does \\(x\\)'],
      },
    );
  });

  it('uses each package manager’s own runner', () => {
    expect(runSpec('jest', { manager: 'yarn' }).program).toBe('yarn');
    expect(runSpec('jest', { manager: 'bun' }).args.slice(0, 2)).toEqual(['x', 'jest']);
    expect(runSpec('jest', { manager: 'npm' }).program).toBe('npx');
  });

  it('addresses one pytest case as path::name', () => {
    expect(runSpec('pytest', { rel: 'tests/test_a.py', testName: 'test_adds' })).toEqual({
      program: 'pytest',
      args: ['-q', 'tests/test_a.py::test_adds'],
    });
    expect(runSpec('pytest', { rel: 'tests/test_a.py' }).args).toEqual(['-q', 'tests/test_a.py']);
  });

  it('filters cargo by name and targets a file only when running the whole file', () => {
    expect(runSpec('cargo', { rel: 'tests/live.rs' }).args).toEqual(['test', '--test', 'live']);
    expect(runSpec('cargo', { rel: 'tests/live.rs', testName: 'adds' }).args).toEqual([
      'test',
      'adds',
      '--exact',
    ]);
  });

  it('turns a go test file into its package', () => {
    expect(runSpec('gotest', { rel: 'pkg/sub/a_test.go' }).args).toEqual(['test', './pkg/sub']);
    // A root-level test file is package `.`, not `./`.
    expect(runSpec('gotest', { rel: 'a_test.go' }).args).toEqual(['test', '.']);
    expect(runSpec('gotest', {}).args).toEqual(['test', './...']);
    expect(runSpec('gotest', { rel: 'a_test.go', testName: 'TestX' }).args).toEqual([
      'test',
      '.',
      '-run',
      '^TestX$',
    ]);
  });

  it('escapes regex metacharacters in a filter', () => {
    expect(escapeRegex('a.b(c)+')).toBe('a\\.b\\(c\\)\\+');
  });
});
