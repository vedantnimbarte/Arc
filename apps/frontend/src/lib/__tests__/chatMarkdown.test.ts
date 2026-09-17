import { describe, expect, it } from 'vitest';
import { pathToLanguageId } from '@arc/editor';
import { fenceLanguageFile, inlineCodeTarget, splitPath } from '../chatMarkdown';

describe('fenceLanguageFile', () => {
  it('maps fence names agents use onto the editor grammar table', () => {
    expect(pathToLanguageId(fenceLanguageFile('typescript'))).toBe('typescript');
    expect(pathToLanguageId(fenceLanguageFile('ts'))).toBe('typescript');
    expect(pathToLanguageId(fenceLanguageFile('Rust title="lib.rs"'))).toBe('rust');
    expect(pathToLanguageId(fenceLanguageFile('python3'))).toBe('python');
    expect(pathToLanguageId(fenceLanguageFile('golang'))).toBe('go');
    expect(pathToLanguageId(fenceLanguageFile('yml'))).toBe('yaml');
  });

  it('has no grammar for languages the editor lacks', () => {
    expect(pathToLanguageId(fenceLanguageFile('bash'))).toBeNull();
    expect(pathToLanguageId(fenceLanguageFile(''))).toBeNull();
  });
});

describe('inlineCodeTarget', () => {
  it('resolves a relative path with a line against the root', () => {
    expect(inlineCodeTarget('src/batching.rs:42', '/work/arc')).toEqual({
      path: '/work/arc/src/batching.rs',
      line: 42,
      column: undefined,
    });
    expect(inlineCodeTarget('src\\generate.rs', 'C:\\work\\arc')?.path).toBe('C:\\work\\arc\\src\\generate.rs');
  });

  it('ignores commands, identifiers, URLs and missing roots', () => {
    expect(inlineCodeTarget('npm run build', '/w')).toBeNull();
    expect(inlineCodeTarget('start_session', '/w')).toBeNull();
    expect(inlineCodeTarget('https://example.com/a.ts', '/w')).toBeNull();
    expect(inlineCodeTarget('src/a.ts', null)).toBeNull();
  });
});

describe('splitPath', () => {
  it('splits on either separator', () => {
    expect(splitPath('/w/src/a.ts')).toEqual({ dir: '/w/src', name: 'a.ts' });
    expect(splitPath('C:\\w\\a.ts')).toEqual({ dir: 'C:\\w', name: 'a.ts' });
    expect(splitPath('/a.ts')).toEqual({ dir: '/', name: 'a.ts' });
  });
});
