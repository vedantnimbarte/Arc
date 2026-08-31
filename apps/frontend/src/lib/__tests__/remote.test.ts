import { describe, expect, it } from 'vitest';
import {
  isRemotePath,
  makeRemotePath,
  parseRemotePath,
  pathBasename,
  posixJoin,
  posixParent,
  remoteDisplayPath,
  remoteJoin,
  remoteParent,
} from '../remote';

// Every remote file read, write, and delete is addressed through these. A
// dropped leading slash or a doubled separator silently targets the wrong
// path on someone else's machine, so the edges are covered deliberately.

describe('isRemotePath', () => {
  it('recognises the ssh scheme and nothing else', () => {
    expect(isRemotePath('ssh://host-1/a')).toBe(true);
    expect(isRemotePath('/home/u/a')).toBe(false);
    expect(isRemotePath('C:\\Users\\u\\a')).toBe(false);
    expect(isRemotePath('sshfoo://x')).toBe(false);
    expect(isRemotePath(null)).toBe(false);
    expect(isRemotePath(undefined)).toBe(false);
  });
});

describe('makeRemotePath / parseRemotePath', () => {
  it('round-trips a host and path', () => {
    const uri = makeRemotePath('host-1', '/srv/app/main.rs');
    expect(uri).toBe('ssh://host-1/srv/app/main.rs');
    expect(parseRemotePath(uri)).toEqual({ hostId: 'host-1', path: '/srv/app/main.rs' });
  });

  it('normalizes a relative path to absolute', () => {
    expect(makeRemotePath('h', 'srv/app')).toBe('ssh://h/srv/app');
  });

  it('treats a host with no path as that host root', () => {
    expect(parseRemotePath('ssh://host-1')).toEqual({ hostId: 'host-1', path: '/' });
    expect(parseRemotePath('ssh://host-1/')).toEqual({ hostId: 'host-1', path: '/' });
  });

  it('returns null for non-remote or hostless input', () => {
    expect(parseRemotePath('/home/u')).toBeNull();
    expect(parseRemotePath('ssh://')).toBeNull();
    expect(parseRemotePath('ssh:///no-host')).toBeNull();
  });

  it('keeps a path containing the scheme text intact', () => {
    // A directory legitimately named "ssh:" must not confuse the split.
    const uri = makeRemotePath('h', '/srv/ssh:/notes.md');
    expect(parseRemotePath(uri)?.path).toBe('/srv/ssh:/notes.md');
  });
});

describe('posixJoin', () => {
  it('collapses separators from either side', () => {
    expect(posixJoin('/home/u', 'a.txt')).toBe('/home/u/a.txt');
    expect(posixJoin('/home/u/', 'a.txt')).toBe('/home/u/a.txt');
    expect(posixJoin('/home/u', '/a.txt')).toBe('/home/u/a.txt');
    expect(posixJoin('/home/u//', '//a.txt')).toBe('/home/u/a.txt');
  });

  it('produces an absolute path from an empty or root base', () => {
    expect(posixJoin('', 'a.txt')).toBe('/a.txt');
    expect(posixJoin('/', 'a.txt')).toBe('/a.txt');
  });
});

describe('posixParent', () => {
  it('walks up one level', () => {
    expect(posixParent('/home/u/a.txt')).toBe('/home/u');
    expect(posixParent('/home/u/')).toBe('/home');
  });

  it('stops at root rather than returning an empty string', () => {
    // An empty parent would make "go up" navigate to nowhere.
    expect(posixParent('/home')).toBe('/');
    expect(posixParent('/')).toBe('/');
    expect(posixParent('a.txt')).toBe('/');
  });
});

describe('remoteJoin / remoteParent', () => {
  it('preserves scheme and host across a join', () => {
    expect(remoteJoin('ssh://h/srv', 'app.rs')).toBe('ssh://h/srv/app.rs');
    expect(remoteJoin('ssh://h/srv/', '/app.rs')).toBe('ssh://h/srv/app.rs');
  });

  it('preserves scheme and host walking up', () => {
    expect(remoteParent('ssh://h/srv/app.rs')).toBe('ssh://h/srv');
  });

  it('does not walk above the host root', () => {
    expect(remoteParent('ssh://h/srv')).toBe('ssh://h/');
    expect(remoteParent('ssh://h/')).toBe('ssh://h/');
  });

  it('falls back to plain posix behaviour on a local path', () => {
    expect(remoteJoin('/home/u', 'a.txt')).toBe('/home/u/a.txt');
    expect(remoteParent('/home/u/a.txt')).toBe('/home/u');
  });
});

describe('remoteDisplayPath', () => {
  it('strips the scheme and host id, which are UUID noise in a breadcrumb', () => {
    expect(remoteDisplayPath('ssh://3f2a-uuid/srv/app')).toBe('/srv/app');
  });

  it('passes a local path through', () => {
    expect(remoteDisplayPath('/home/u')).toBe('/home/u');
  });
});

describe('pathBasename', () => {
  it('handles remote, posix, and windows paths', () => {
    expect(pathBasename('ssh://h/srv/app/main.rs')).toBe('main.rs');
    expect(pathBasename('/home/u/a.txt')).toBe('a.txt');
    expect(pathBasename('C:\\Users\\u\\a.txt')).toBe('a.txt');
  });

  it('ignores a trailing separator', () => {
    expect(pathBasename('/home/u/dir/')).toBe('dir');
    expect(pathBasename('ssh://h/srv/dir/')).toBe('dir');
  });
});
