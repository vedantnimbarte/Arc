import { describe, expect, it } from 'vitest';
import { maskPassword, sqliteUrl } from '../connectionUrl';

describe('maskPassword', () => {
  it('hides only the password', () => {
    expect(maskPassword('postgres://me:s3cr@t@db.local:5432/app')).toBe('postgres://me:••••@db.local:5432/app');
    expect(maskPassword('mysql://root:pw@localhost/x?ssl=1')).toBe('mysql://root:••••@localhost/x?ssl=1');
  });
  it('leaves URLs without a password alone', () => {
    for (const u of ['postgres://me@host/db', 'postgres://host:5432/db', 'sqlite:///C:/data/app.db', '']) {
      expect(maskPassword(u)).toBe(u);
    }
  });
});

describe('sqliteUrl', () => {
  it('matches what the backend parses', () => {
    expect(sqliteUrl('/home/me/app.db')).toBe('sqlite:///home/me/app.db');
    expect(sqliteUrl('C:\\data\\app.db')).toBe('sqlite:///C:/data/app.db');
  });
});
