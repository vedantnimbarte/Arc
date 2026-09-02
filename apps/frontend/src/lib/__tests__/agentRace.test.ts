import { describe, expect, it } from 'vitest';
import { raceNames, slugify } from '../agentRace';

// These names become git refs and directories. A collision means two agents
// racing the same task share a checkout, which is the exact failure isolating
// them was meant to prevent — and an invalid ref means the launch dies partway
// through, leaving some worktrees created and some not.

describe('slugify', () => {
  it('keeps a plain task recognisable', () => {
    expect(slugify('Fix the login redirect', 'run')).toBe('fix-the-login-redirect');
  });

  it('strips what git refuses in a ref name', () => {
    // Spaces, ~ ^ : ? * [ \ and .. are all rejected by check-ref-format.
    const slug = slugify('a~b^c:d?e*f[g]h\\i..j', 'run');
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug).not.toContain('..');
  });

  it('never yields a leading or trailing dash', () => {
    expect(slugify('  ...hello...  ', 'run')).toBe('hello');
    expect(slugify('!!!', 'run')).toBe('run');
  });

  it('falls back when the label carries nothing usable', () => {
    expect(slugify('', 'run')).toBe('run');
    expect(slugify('   ', 'run')).toBe('run');
  });

  it('caps the length without leaving a trailing dash', () => {
    const slug = slugify('a'.repeat(20) + ' ' + 'b'.repeat(40), 'run');
    expect(slug.length).toBeLessThanOrEqual(32);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('raceNames', () => {
  it('gives every agent in a race a distinct branch and directory', () => {
    const names = [0, 1, 2, 3].map((i) => raceNames('arc', 'fix-login', 12345, i));
    expect(new Set(names.map((n) => n.branch)).size).toBe(4);
    expect(new Set(names.map((n) => n.dirName)).size).toBe(4);
  });

  it('numbers from one, so panes match branches', () => {
    expect(raceNames('arc', 'x', 0, 0).branch.endsWith('/1')).toBe(true);
    expect(raceNames('arc', 'x', 0, 3).branch.endsWith('/4')).toBe(true);
  });

  it('namespaces branches so they never collide with the user’s own', () => {
    expect(raceNames('arc', 'x', 0, 0).branch.startsWith('arc/')).toBe(true);
  });

  it('separates two races of the same task by their timestamp', () => {
    const a = raceNames('arc', 'same', 1, 0);
    const b = raceNames('arc', 'same', 2, 0);
    expect(a.branch).not.toBe(b.branch);
    expect(a.dirName).not.toBe(b.dirName);
  });

  it('separates two repos racing at once, since directories are flat', () => {
    const a = raceNames('arc', 'same', 7, 0);
    const b = raceNames('other', 'same', 7, 0);
    expect(a.dirName).not.toBe(b.dirName);
  });

  it('produces refs git will accept', () => {
    const { branch } = raceNames('arc', 'fix-login', Date.now(), 2);
    expect(branch).toMatch(/^[A-Za-z0-9/_-]+$/);
    expect(branch).not.toMatch(/\/\/|\.\.|\.lock$|\/$/);
  });
});
