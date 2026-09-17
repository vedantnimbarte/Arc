// Remote-workspace path addressing.
//
// A remote file is named by a URI: `ssh://<hostId>/abs/posix/path`. That one
// decision is what lets the file tree, the editor, tabs, and session
// persistence carry remote files without any of them learning a second path
// type — they keep passing strings to `fsReadDir`/`fsReadFile`/`fsWriteFile`,
// which route on the prefix (see lib/tauri.ts).
//
// Host ids are UUIDs from the SSH host table, so they never contain `/` and
// the split below is unambiguous.
//
// Every function here is pure. `remoteJoin`/`remoteParent` mirror
// `posix_join`/`posix_parent` in rust/ssh/src/sftp.rs; both sides are tested
// because a `//` or a lost leading slash silently addresses the wrong file.

export const REMOTE_SCHEME = 'ssh://';

export interface RemoteRef {
  hostId: string;
  /** Absolute POSIX path on the remote host. Always starts with `/`. */
  path: string;
}

/** True when `path` addresses a file on a remote host. */
export function isRemotePath(path: string | null | undefined): boolean {
  return typeof path === 'string' && path.startsWith(REMOTE_SCHEME);
}

/** Build a remote URI. `path` is normalized to an absolute POSIX path. */
export function makeRemotePath(hostId: string, path: string): string {
  const abs = path.startsWith('/') ? path : `/${path}`;
  return `${REMOTE_SCHEME}${hostId}${abs}`;
}

/** Split a remote URI into its host and path, or null if it isn't one. */
export function parseRemotePath(uri: string): RemoteRef | null {
  if (!isRemotePath(uri)) return null;
  const rest = uri.slice(REMOTE_SCHEME.length);
  const slash = rest.indexOf('/');
  // `ssh://host` with no path at all addresses that host's root.
  if (slash < 0) return rest ? { hostId: rest, path: '/' } : null;
  const hostId = rest.slice(0, slash);
  if (!hostId) return null;
  return { hostId, path: rest.slice(slash) || '/' };
}

/** Join a POSIX parent and child, collapsing the separator. */
export function posixJoin(base: string, name: string): string {
  const b = base.replace(/\/+$/, '');
  const n = name.replace(/^\/+/, '');
  return b ? `${b}/${n}` : `/${n}`;
}

/** POSIX dirname. Returns `/` at the top rather than an empty string, so
 *  "go to parent" always lands somewhere navigable. */
export function posixParent(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

/** Join onto a remote URI, keeping the scheme and host. */
export function remoteJoin(uri: string, name: string): string {
  const ref = parseRemotePath(uri);
  if (!ref) return posixJoin(uri, name);
  return makeRemotePath(ref.hostId, posixJoin(ref.path, name));
}

/** Parent of a remote URI. At the remote root this returns the root itself,
 *  matching the local tree's behaviour of not walking above it. */
export function remoteParent(uri: string): string {
  const ref = parseRemotePath(uri);
  if (!ref) return posixParent(uri);
  return makeRemotePath(ref.hostId, posixParent(ref.path));
}

/** Display form: the path without the `ssh://<hostId>` prefix. Host ids are
 *  UUIDs, so showing them in a breadcrumb would be noise. */
export function remoteDisplayPath(uri: string): string {
  return parseRemotePath(uri)?.path ?? uri;
}

/** Quote `s` as one POSIX shell word — the frontend twin of `shell_quote` in
 *  rust/ssh/src/exec.rs. Single quotes make everything literal; an embedded
 *  `'` is spelled `'\''`. Always quotes, so there is no "safe" heuristic to
 *  get wrong. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Rewrite a command's arguments for its remote host: every `ssh://` string —
 * at any depth, in arrays and nested option objects — becomes its POSIX path,
 * which is what the tools on the host understand. Returns null when
 * `args.path` isn't remote, meaning the command runs locally as-is.
 */
export function toRemoteArgs(
  args: Record<string, unknown>,
): { hostId: string; args: Record<string, unknown> } | null {
  const ref = typeof args.path === 'string' ? parseRemotePath(args.path) : null;
  if (!ref) return null;
  const strip = (v: unknown): unknown => {
    if (typeof v === 'string') return parseRemotePath(v)?.path ?? v;
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x)]));
    }
    return v;
  };
  return { hostId: ref.hostId, args: strip(args) as Record<string, unknown> };
}

/** Where a checker's reported file lives. Checkers print paths relative to
 *  the directory they ran in, or absolute ones (eslint); on a remote root an
 *  absolute path is a path on that host, not on this machine. */
export function resolveRemoteFile(root: string, file: string): string {
  const ref = parseRemotePath(root);
  if (!ref) return file;
  return file.startsWith('/') ? makeRemotePath(ref.hostId, file) : remoteJoin(root, file);
}

/** Last path segment of a local or remote path. Handles both separators so
 *  one call works for either kind. */
export function pathBasename(path: string): string {
  const p = isRemotePath(path) ? remoteDisplayPath(path) : path;
  const cleaned = p.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}
