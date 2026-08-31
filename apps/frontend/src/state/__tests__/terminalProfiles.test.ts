import { describe, expect, it } from 'vitest';
import { coerceTerminalProfiles, resolveTerminalProfile } from '../settings';
import { splitArgs } from '../../components/SettingsPage';

// Profiles come back out of a user-editable settings row and feed straight
// into a PTY spawn, so the coercion is a trust boundary, not a formality.

describe('coerceTerminalProfiles', () => {
  it('keeps a complete profile intact', () => {
    const input = [
      {
        id: 'p1',
        name: 'Login shell',
        shell: '/bin/zsh',
        args: ['-l'],
        cwd: '/home/u',
        env: { FOO: 'bar' },
      },
    ];
    expect(coerceTerminalProfiles(input)).toEqual(input);
  });

  it('drops entries without a usable id or name', () => {
    const input = [
      { id: '', name: 'x', shell: '' },
      { id: 'p1', name: '', shell: '' },
      { id: 'p2', shell: '' },
      { name: 'p3', shell: '' },
      { id: 'ok', name: 'ok', shell: '' },
    ];
    expect(coerceTerminalProfiles(input).map((p) => p.id)).toEqual(['ok']);
  });

  it('defaults a non-string shell to empty rather than passing it to the spawn', () => {
    expect(coerceTerminalProfiles([{ id: 'p', name: 'p', shell: 42 }])[0]!.shell).toBe('');
  });

  it('filters non-string args and env values', () => {
    const out = coerceTerminalProfiles([
      { id: 'p', name: 'p', shell: '', args: ['-l', 7, null], env: { A: 'a', B: 3 } },
    ])[0]!;
    expect(out.args).toEqual(['-l']);
    expect(out.env).toEqual({ A: 'a' });
  });

  it('omits empty optional fields instead of storing blanks', () => {
    const out = coerceTerminalProfiles([
      { id: 'p', name: 'p', shell: '', args: [], cwd: '', env: {} },
    ])[0]!;
    expect(out).toEqual({ id: 'p', name: 'p', shell: '' });
  });

  it('de-duplicates by id, keeping the first', () => {
    const out = coerceTerminalProfiles([
      { id: 'p', name: 'first', shell: '' },
      { id: 'p', name: 'second', shell: '' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('first');
  });

  it('returns [] for anything that is not an array', () => {
    expect(coerceTerminalProfiles(null)).toEqual([]);
    expect(coerceTerminalProfiles({ id: 'p' })).toEqual([]);
    expect(coerceTerminalProfiles('nope')).toEqual([]);
  });
});

describe('resolveTerminalProfile', () => {
  const profiles = coerceTerminalProfiles([{ id: 'p1', name: 'one', shell: '/bin/sh' }]);

  it('finds a profile by id', () => {
    expect(resolveTerminalProfile(profiles, 'p1')?.name).toBe('one');
  });

  it('returns null for a deleted profile, so the spawn falls back to the default shell', () => {
    expect(resolveTerminalProfile(profiles, 'gone')).toBeNull();
  });

  it('returns null for a missing id', () => {
    expect(resolveTerminalProfile(profiles, null)).toBeNull();
    expect(resolveTerminalProfile(profiles, undefined)).toBeNull();
  });
});

describe('splitArgs', () => {
  it('splits on whitespace', () => {
    expect(splitArgs('-l -i')).toEqual(['-l', '-i']);
  });

  it('keeps a quoted path with spaces as one argument', () => {
    expect(splitArgs('--cd "C:/Program Files/x"')).toEqual(['--cd', 'C:/Program Files/x']);
    expect(splitArgs("--msg 'hello world'")).toEqual(['--msg', 'hello world']);
  });

  it('preserves an explicitly empty argument', () => {
    expect(splitArgs('-c ""')).toEqual(['-c', '']);
  });

  it('collapses runs of whitespace and trims', () => {
    expect(splitArgs('  -a   -b  ')).toEqual(['-a', '-b']);
  });

  it('returns [] for an empty string', () => {
    expect(splitArgs('')).toEqual([]);
    expect(splitArgs('   ')).toEqual([]);
  });
});
