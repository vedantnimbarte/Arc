import { resolveWorkspacePath } from './links';
import { isRemotePath } from './remote';

/**
 * Link + image resolution for the editor's markdown preview. Pure so the
 * preview's click handler and image rewrite share one tested rule set.
 */

/** Window event the `toggle-markdown-preview` shortcut dispatches; `detail`
 *  is the target tab id. Lives here, not in the lazy-loaded Editor chunk. */
export const CYCLE_MARKDOWN_PREVIEW_EVENT = 'arc:cycle-markdown-preview';

export type MarkdownLink =
  | { kind: 'external'; url: string }
  | { kind: 'file'; path: string }
  | { kind: 'none' };

const WEB_RE = /^https?:/i;
// Two+ chars before the colon so a Windows drive (`C:\`) isn't read as a scheme.
const SCHEME_RE = /^[a-z][\w+.-]+:/i;
const MARKDOWN_RE = /\.(md|markdown|mdx)$/i;

/**
 * Resolve a relative (or absolute) reference inside the markdown file at
 * `filePath` to a local absolute path. Drops `?query` / `#fragment` and
 * undoes percent-encoding. Returns null for URLs, protocol-relative refs, bare
 * fragments, and remote files.
 * ponytail: remote files resolve nothing — their links and images need the
 * remote fs, not the asset protocol.
 */
export function resolveMarkdownPath(filePath: string, ref: string): string | null {
  if (isRemotePath(filePath)) return null;
  const raw = ref.trim();
  if (SCHEME_RE.test(raw) || raw.startsWith('//')) return null;
  let target = raw.replace(/[?#].*$/, '');
  try {
    target = decodeURIComponent(target);
  } catch {
    // Malformed escape — use the reference as written.
  }
  if (!target) return null;
  const dir = filePath.replace(/[\\/][^\\/]*$/, '') || filePath.slice(0, 1);
  return resolveWorkspacePath(dir, target);
}

/** Decide what clicking `href` in the preview of `filePath` should do. */
export function classifyMarkdownLink(filePath: string, href: string): MarkdownLink {
  const raw = href.trim();
  if (WEB_RE.test(raw)) return { kind: 'external', url: raw };
  const path = resolveMarkdownPath(filePath, raw);
  return path && MARKDOWN_RE.test(path) ? { kind: 'file', path } : { kind: 'none' };
}
