// Test discovery: which framework a project uses, which files hold tests,
// which tests are in a file, and what to run to execute one.
//
// Everything here is pure string work so it can be tested without a
// filesystem — `state/tests.ts` supplies the file contents and runs the
// commands.
//
// The parsers are line scanners, deliberately, for the same reason
// `state/tasks.ts` scans Makefiles rather than parsing them: a computed test
// name (`it(\`case ${n}\`)`, `@pytest.mark.parametrize`) is one only the
// runner can expand, and offering a name the runner would reject is worse
// than omitting it. Anything we can't name confidently is skipped; the file's
// "run all" entry still covers it.

export type Framework = 'vitest' | 'jest' | 'pytest' | 'cargo' | 'gotest';

export interface TestCase {
  /** Test name as the runner knows it. */
  name: string;
  /** 1-based line in the file — used to jump to it in the editor. */
  line: number;
}

export interface TestFile {
  /** Absolute path. */
  path: string;
  /** Path relative to the workspace root, forward-slashed. */
  rel: string;
  framework: Framework;
  tests: TestCase[];
}

/** One command to run, as program + args (no shell involved). */
export interface RunSpec {
  program: string;
  args: string[];
}

// ─── Framework detection ─────────────────────────────────────────────────

/**
 * Decide which runners a project uses from the manifests at its root.
 *
 * `packageJson` etc. are file contents or null when absent. More than one is
 * normal (a Rust+TS repo), and each framework discovers its own files.
 */
export function detectFrameworks(manifests: {
  packageJson: string | null;
  cargoToml: string | null;
  goMod: string | null;
  pyProject: string | null;
  setupPy: string | null;
  setupCfg: string | null;
  toxIni: string | null;
  pytestIni: string | null;
}): Framework[] {
  const out: Framework[] = [];
  if (manifests.packageJson) {
    // vitest and jest are mutually exclusive in practice; when both are
    // declared, vitest wins because a repo migrating between them runs vitest.
    const pkg = manifests.packageJson;
    if (/"vitest"\s*:/.test(pkg)) out.push('vitest');
    else if (/"jest"\s*:/.test(pkg)) out.push('jest');
  }
  if (manifests.cargoToml) out.push('cargo');
  if (manifests.goMod) out.push('gotest');
  if (
    manifests.pyProject ||
    manifests.setupPy ||
    manifests.setupCfg ||
    manifests.toxIni ||
    manifests.pytestIni
  ) {
    out.push('pytest');
  }
  return out;
}

/** Does this path look like a test file for `framework`? */
export function isTestFile(rel: string, framework: Framework): boolean {
  const p = rel.toLowerCase();
  switch (framework) {
    case 'vitest':
    case 'jest':
      return /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
    case 'pytest':
      return /(^|\/)test_[^/]*\.py$/.test(p) || /_test\.py$/.test(p);
    case 'gotest':
      return /_test\.go$/.test(p);
    case 'cargo':
      // `#[test]` lives anywhere in a Rust crate, so filename matching can
      // only find the integration-test directory.
      //
      // ponytail: `tests/*.rs` only. Unit tests inside `src/` are reachable
      // via the crate's "run all" row; parsing every .rs file to find
      // `#[cfg(test)]` modules is the upgrade if anyone misses them.
      return /(^|\/)tests\/[^/]+\.rs$/.test(p);
  }
}

// ─── Test-name parsing ───────────────────────────────────────────────────

/** `it("name")` / `test('name')`, incl. `.only` / `.skip` / `.concurrent`
 *  suffixes. `describe` blocks are deliberately not collected: they'd add a
 *  tree level whose only action is "run everything under it", which the file
 *  row already does. Template literals that interpolate are skipped — the
 *  name isn't knowable without running the file. */
const JS_TEST =
  /(?:^|[\s;{}(])(?:it|test)(?:\.(?:only|skip|todo|concurrent|failing|each))*\s*\(\s*(['"`])((?:(?!\1)[^\\])*?)\1/;

const PY_TEST = /^\s*(?:async\s+)?def\s+(test[A-Za-z0-9_]*)\s*\(/;
const GO_TEST = /^\s*func\s+((?:Test|Benchmark|Fuzz|Example)[A-Za-z0-9_]*)\s*\(/;
const RUST_TEST = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*\(/;
const RUST_ATTR = /^\s*#\[(?:tokio::)?(?:test|test\([^)]*\))\]/;

/**
 * Pull test names out of one file's source.
 *
 * Returns them in file order. Duplicates are kept — two same-named tests in
 * one file are a real (if unfortunate) thing, and dropping one would make the
 * tree disagree with the runner's output.
 */
export function parseTests(source: string, framework: Framework): TestCase[] {
  const lines = source.split(/\r?\n/);
  const out: TestCase[] = [];

  if (framework === 'cargo') {
    // `#[test]` and its friends sit on the line(s) above the fn. Walk down
    // through further attributes (`#[should_panic]`, `#[ignore]`) to reach it.
    for (let i = 0; i < lines.length; i++) {
      if (!RUST_ATTR.test(lines[i]!)) continue;
      for (let j = i + 1; j < lines.length && j <= i + 6; j++) {
        const line = lines[j]!;
        if (/^\s*#\[/.test(line)) continue;
        const m = RUST_TEST.exec(line);
        if (m) out.push({ name: m[1]!, line: j + 1 });
        break;
      }
    }
    return out;
  }

  const pattern =
    framework === 'pytest' ? PY_TEST : framework === 'gotest' ? GO_TEST : JS_TEST;
  const nameGroup = framework === 'vitest' || framework === 'jest' ? 2 : 1;

  for (let i = 0; i < lines.length; i++) {
    const m = pattern.exec(lines[i]!);
    if (!m) continue;
    const name = m[nameGroup];
    if (!name) continue;
    // A template literal that interpolates isn't a name we can pass to -t.
    if (name.includes('${')) continue;
    out.push({ name, line: i + 1 });
  }
  return out;
}

// ─── Run commands ────────────────────────────────────────────────────────

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

/** Escape a name for use as a regex-ish `-t` filter. vitest/jest treat the
 *  pattern as a regex, so a test called `foo (bar)` needs its parens quoted
 *  or it silently matches nothing. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Prefix that runs a local binary under the detected package manager. */
function jsRunner(manager: PackageManager, bin: string): RunSpec {
  if (manager === 'yarn') return { program: 'yarn', args: [bin] };
  if (manager === 'bun') return { program: 'bun', args: ['x', bin] };
  if (manager === 'pnpm') return { program: 'pnpm', args: ['exec', bin] };
  return { program: 'npx', args: ['--no-install', bin] };
}

/**
 * Build the command that runs `target`.
 *
 * `rel` scopes the run to one file; `testName` narrows it to a single case.
 * Omitting both runs the framework's whole suite.
 */
export function runSpec(
  framework: Framework,
  opts: { rel?: string; testName?: string; manager?: PackageManager },
): RunSpec {
  const manager = opts.manager ?? 'npm';
  switch (framework) {
    case 'vitest': {
      const base = jsRunner(manager, 'vitest');
      const args = [...base.args, 'run', '--reporter=basic'];
      if (opts.rel) args.push(opts.rel);
      if (opts.testName) args.push('-t', escapeRegex(opts.testName));
      return { program: base.program, args };
    }
    case 'jest': {
      const base = jsRunner(manager, 'jest');
      const args = [...base.args];
      if (opts.rel) args.push('--runTestsByPath', opts.rel);
      if (opts.testName) args.push('-t', escapeRegex(opts.testName));
      return { program: base.program, args };
    }
    case 'pytest': {
      const args = ['-q'];
      // pytest addresses a single test as `path::name`.
      if (opts.rel && opts.testName) args.push(`${opts.rel}::${opts.testName}`);
      else if (opts.rel) args.push(opts.rel);
      else if (opts.testName) args.push('-k', opts.testName);
      return { program: 'pytest', args };
    }
    case 'cargo': {
      const args = ['test'];
      // `cargo test <filter>` matches on the test's path, so the name alone
      // is the right filter; the file is only a hint for `--test <target>`.
      if (opts.rel && !opts.testName) {
        const target = opts.rel.split('/').pop()?.replace(/\.rs$/, '');
        if (target) args.push('--test', target);
      }
      if (opts.testName) args.push(opts.testName, '--exact');
      return { program: 'cargo', args };
    }
    case 'gotest': {
      // `go test` takes a package, not a file. A root-level `_test.go` maps
      // to `.`, a nested one to its directory, and "run everything" to `./...`.
      const dir = opts.rel ? opts.rel.split('/').slice(0, -1).join('/') : null;
      const pkg = dir === null ? './...' : dir === '' ? '.' : `./${dir}`;
      const args = ['test', pkg];
      if (opts.testName) args.push('-run', `^${escapeRegex(opts.testName)}$`);
      return { program: 'go', args };
    }
  }
}

/** Human label for the framework, shown as the tree's top-level row. */
export function frameworkLabel(framework: Framework): string {
  switch (framework) {
    case 'vitest':
      return 'Vitest';
    case 'jest':
      return 'Jest';
    case 'pytest':
      return 'pytest';
    case 'cargo':
      return 'cargo test';
    case 'gotest':
      return 'go test';
  }
}
