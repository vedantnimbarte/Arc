import { describe, expect, it } from 'vitest';
import { decodeTerminalBlob, encodeTerminalBlob } from '../workspace';

/**
 * What a terminal tab remembers across a relaunch. This is the whole of
 * terminal "session restore" now: a profile, a directory, and which agent it
 * ran — never the screen contents, whose replay used to leave restored tabs
 * unable to take input.
 */
describe('terminal tab persistence', () => {
  it('round-trips profile, live cwd and agent', () => {
    const blob = encodeTerminalBlob({ profileId: 'p1', cwd: 'C:\code\arc', agentCliId: 'claude-cli' });
    expect(decodeTerminalBlob(blob)).toEqual({
      profileId: 'p1',
      restoreCwd: 'C:\code\arc',
      agentCliId: 'claude-cli',
    });
  });

  it('keeps the restored cwd of a tab that has not spawned yet', () => {
    expect(decodeTerminalBlob(encodeTerminalBlob({ restoreCwd: '/home/me' })).restoreCwd).toBe('/home/me');
    // A live cwd wins over the one it was restored with.
    expect(JSON.parse(encodeTerminalBlob({ cwd: '/b', restoreCwd: '/a' })!)).toEqual({ cwd: '/b' });
  });

  it('stores null for a plain shell, exactly as before', () => {
    expect(encodeTerminalBlob({})).toBeNull();
  });

  it('never persists a remote path a local PTY cannot start in', () => {
    expect(encodeTerminalBlob({ cwd: 'ssh://host/home/me' })).toBeNull();
  });

  it('drops unknown agents and survives corrupt blobs', () => {
    expect(decodeTerminalBlob('{"agentCliId":"rm -rf","profileId":7}')).toEqual({
      profileId: undefined,
      restoreCwd: undefined,
      agentCliId: undefined,
    });
    expect(decodeTerminalBlob('{not json')).toEqual({});
    expect(decodeTerminalBlob(null)).toEqual({});
  });
});
