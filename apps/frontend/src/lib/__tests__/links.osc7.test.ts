import { describe, expect, it } from 'vitest';
import { osc7Path } from '../links';

describe('osc7Path', () => {
  it('strips the host and keeps a posix path', () => {
    expect(osc7Path('file://box/home/me/proj', false)).toBe('/home/me/proj');
  });

  it('unwraps a drive-letter path', () => {
    expect(osc7Path('file://box/C:/Users/me/proj', true)).toBe('C:/Users/me/proj');
  });

  it('converts an MSYS path to a real Windows one', () => {
    expect(osc7Path('file://box/c/Users/me/proj', true)).toBe('C:/Users/me/proj');
  });

  it('leaves /c/ alone off Windows — it is a real directory there', () => {
    expect(osc7Path('file://box/c/Users/me/proj', false)).toBe('/c/Users/me/proj');
  });

  it('decodes percent escapes', () => {
    expect(osc7Path('file://box/home/me/my%20proj', false)).toBe('/home/me/my proj');
  });

  it('rejects anything that is not a file URL', () => {
    expect(osc7Path('http://example.com/x', false)).toBeNull();
  });
});
