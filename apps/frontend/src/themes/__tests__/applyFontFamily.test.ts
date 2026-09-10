import { afterEach, describe, expect, it } from 'vitest';
import { applyFontFamily } from '../index';

// The suite runs in the `node` environment, so stand up just enough of a
// document for the one property write under test.
function stubDocument(): Record<string, string> {
  const props: Record<string, string> = {};
  (globalThis as unknown as { document: unknown }).document = {
    documentElement: {
      style: {
        setProperty: (key: string, val: string) => {
          props[key] = val;
        },
      },
    },
  };
  return props;
}

afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document;
});

describe('applyFontFamily', () => {
  it('publishes a bundled font as --font-user', () => {
    const props = stubDocument();
    applyFontFamily('jetbrains-mono');
    expect(props['--font-user']).toContain('JetBrains Mono');
  });

  it('quotes an arbitrary system family and keeps a generic fallback', () => {
    const props = stubDocument();
    applyFontFamily('Comic Sans MS');
    expect(props['--font-user']).toBe('"Comic Sans MS", ui-monospace, monospace');
  });

  it('falls back to the default font when nothing is stored', () => {
    const props = stubDocument();
    applyFontFamily('');
    expect(props['--font-user']).toContain('SF Mono');
  });

  it('is a no-op without a document', () => {
    expect(() => applyFontFamily('jetbrains-mono')).not.toThrow();
  });
});
