/**
 * Turn a git remote URL into a browsable web URL for one commit.
 *
 * Remotes come in three shapes — `git@host:owner/repo.git`,
 * `ssh://git@host/owner/repo.git` and `https://host/owner/repo.git` — and all
 * three point at the same page. `/commit/<oid>` is GitHub's path and the one
 * GitLab and Gitea redirect from, so a non-GitHub host still lands somewhere
 * sensible rather than nowhere.
 *
 * Returns null for anything that isn't a recognisable http/ssh remote (a
 * local path, a file:// URL), so the caller can leave the action out.
 */
export function commitWebUrl(remoteUrl: string, oid: string): string | null {
  const host = remoteHost(remoteUrl);
  if (!host) return null;
  return `https://${host.host}/${host.repo}/commit/${oid}`;
}

/** Host + `owner/repo` of a remote URL, or null if it isn't one. */
export function remoteHost(remoteUrl: string): { host: string; repo: string } | null {
  const url = remoteUrl.trim();
  if (!url) return null;

  // scp-like: git@host:owner/repo.git  (no scheme, colon separates the path).
  // The host has to be dotted, or a Windows drive path parses as host "C".
  const scp = /^(?:[\w.-]+@)?([\w-]+(?:\.[\w-]+)+):(?!\/)(.+)$/.exec(url);
  const parsed = scp
    ? { host: scp[1] ?? '', path: scp[2] ?? '' }
    : (() => {
        const m = /^(?:ssh|git|https?):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/.exec(url);
        return m ? { host: (m[1] ?? '').replace(/:\d+$/, ''), path: m[2] ?? '' } : null;
      })();
  if (!parsed || !parsed.host) return null;

  const repo = parsed.path.replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
  if (!repo) return null;
  return { host: parsed.host, repo };
}
