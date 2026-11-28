/** `postgres://user:secret@host/db` → `postgres://user:••••@host/db`, for
 *  showing a URL without its password. Anything without one is unchanged. */
export function maskPassword(url: string): string {
  return url.replace(/^([a-z][\w+.-]*:\/\/[^:/?#@]*):[^/?#]*@/i, '$1:••••@');
}

/** A picked file as the SQLite URL the backend parses: `sqlite:///home/me/app.db`,
 *  or `sqlite:///C:/data/app.db` on Windows (forward slashes, a slash before the drive). */
export function sqliteUrl(path: string): string {
  const p = path.replace(/\\/g, '/');
  return `sqlite://${p.startsWith('/') ? '' : '/'}${p}`;
}
