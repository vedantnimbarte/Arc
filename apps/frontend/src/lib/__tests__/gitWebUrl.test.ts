import { describe, expect, it } from 'vitest';
import { commitWebUrl, remoteHost } from '../gitWebUrl';

const OID = '9e40bcf1234567890abcdef1234567890abcdef1';

describe('commitWebUrl', () => {
  it('handles the three shapes a git remote comes in', () => {
    const expected = `https://github.com/vedantnimbarte/Arc/commit/${OID}`;
    expect(commitWebUrl('git@github.com:vedantnimbarte/Arc.git', OID)).toBe(expected);
    expect(commitWebUrl('ssh://git@github.com/vedantnimbarte/Arc.git', OID)).toBe(expected);
    expect(commitWebUrl('https://github.com/vedantnimbarte/Arc.git', OID)).toBe(expected);
    expect(commitWebUrl('https://github.com/vedantnimbarte/Arc', OID)).toBe(expected);
  });

  it('keeps nested groups and drops an ssh port', () => {
    expect(commitWebUrl('git@gitlab.com:team/sub/proj.git', OID)).toBe(
      `https://gitlab.com/team/sub/proj/commit/${OID}`,
    );
    expect(remoteHost('ssh://git@git.example.com:2222/team/proj.git')).toEqual({
      host: 'git.example.com',
      repo: 'team/proj',
    });
  });

  it('returns null for remotes with no web page', () => {
    expect(commitWebUrl('/srv/repos/arc.git', OID)).toBeNull();
    expect(commitWebUrl('C:\\repos\\arc', OID)).toBeNull();
    expect(commitWebUrl('', OID)).toBeNull();
  });
});
