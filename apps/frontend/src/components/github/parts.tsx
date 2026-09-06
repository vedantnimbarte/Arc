import { useState, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { shellOpenExternal, type GitHostComment } from '../../lib/tauri';
import { cn } from '../../lib/cn';
import { relative } from './format';
import type { Glyph } from './stateGlyph';

/**
 * The shape every repo-scoped section wears: a filter row across the top, a
 * scannable list on the left, and the selected thing on the right.
 *
 * The list keeps a fixed width so the state gutter stays in the same place
 * when you move between sections — that column is the thing the eye learns.
 */
export function SplitPane({
  toolbar,
  list,
  detail,
}: {
  toolbar: ReactNode;
  list: ReactNode;
  detail: ReactNode;
}) {
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge-1 px-3 py-2">
        {toolbar}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-[380px] shrink-0 overflow-y-auto border-r border-edge-1 px-2 py-1.5">
          {list}
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto">{detail}</div>
      </div>
    </div>
  );
}

/** Segmented open/closed/all switch. Values are the caller's own strings. */
export function StateFilter({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-surface-1 p-0.5 ring-1 ring-inset ring-edge-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            'rounded-md px-2 py-0.5 font-display text-2xs transition-colors',
            'focus-visible:outline-none focus-visible:shadow-focus',
            value === o.value
              ? 'bg-surface-3 text-fg-base'
              : 'text-fg-subtle hover:text-fg-muted',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ErrorTray({ message }: { message: string }) {
  return (
    <div className="mb-2 flex items-start gap-2 rounded-xl bg-status-err/[0.08] px-3 py-2 font-display text-xs text-status-err/90 ring-1 ring-inset ring-status-err/20">
      <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-status-err" />
      <span className="min-w-0 break-words">{message}</span>
    </div>
  );
}

/** Title block at the top of a detail pane: state glyph, number, title, and
 *  whatever actions the section allows. */
export function DetailHeader({
  glyph,
  number,
  title,
  subtitle,
  htmlUrl,
  actions,
}: {
  glyph: Glyph;
  number: number;
  title: string;
  subtitle: string;
  htmlUrl: string;
  actions?: ReactNode;
}) {
  const Icon = glyph.icon;
  return (
    <div className="shrink-0 px-4 pb-2 pt-3.5">
      <div className="flex items-start gap-2">
        <span className="mt-[3px] flex w-5 shrink-0 justify-center">
          <Icon size={15} strokeWidth={2} className={glyph.className} />
          <span className="sr-only">{glyph.label}</span>
        </span>
        <h2 className="min-w-0 flex-1 font-display text-sm font-semibold leading-snug tracking-tight text-fg-base">
          {title}
        </h2>
        {actions}
      </div>
      <p className="mt-1 pl-7 font-mono text-2xs tabular-nums text-fg-subtle">
        #{number} · {subtitle}
      </p>
      <button
        onClick={() => void shellOpenExternal(htmlUrl)}
        className="mt-1 ml-7 flex items-center gap-1 font-display text-2xs text-fg-subtle transition-colors hover:text-accent-bright focus-visible:outline-none focus-visible:shadow-focus"
      >
        <ExternalLink size={10} strokeWidth={2} />
        Open on github.com
      </button>
    </div>
  );
}

/**
 * The conversation: the opening body, then each comment, then a box to add
 * one. The body is rendered as plain text rather than Markdown — a Markdown
 * renderer is a dependency and an XSS surface for content written by strangers,
 * and the point here is to read what was said, not to reproduce github.com.
 */
export function CommentThread({
  body,
  author,
  comments,
  onPost,
}: {
  body: string;
  author: string;
  comments: GitHostComment[];
  onPost: (body: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = async () => {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      await onPost(text);
      setDraft('');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
        {body.trim() ? (
          <Entry author={author} when="" body={body} />
        ) : (
          <p className="border-t border-edge-1 py-3 font-display text-xs italic text-fg-subtle">
            No description.
          </p>
        )}
        {comments.map((c) => (
          <Entry key={c.id} author={c.author} when={c.created_at} body={c.body} />
        ))}
      </div>

      <div className="shrink-0 border-t border-edge-1 p-3">
        {error && <ErrorTray message={error} />}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Leave a comment"
          rows={3}
          className="w-full resize-y rounded-lg bg-surface-1 p-2.5 font-display text-xs leading-relaxed text-fg-base ring-1 ring-inset ring-edge-2 placeholder:text-fg-subtle/70 focus:outline-none focus:shadow-focus"
        />
        <button
          onClick={() => void post()}
          disabled={busy || !draft.trim()}
          className="mt-2 h-7 rounded-lg bg-surface-2 px-3 font-display text-xs font-medium text-fg-base ring-1 ring-inset ring-edge-2 transition-all duration-200 ease-apple hover:bg-surface-3 active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-40"
        >
          {busy ? 'Posting…' : 'Comment'}
        </button>
      </div>
    </div>
  );
}

function Entry({ author, when, body }: { author: string; when: string; body: string }) {
  return (
    <div className="border-t border-edge-1 py-3 first:border-t-0">
      <p className="font-mono text-2xs text-fg-subtle">
        {author}
        {when && ` · ${relative(when)}`}
      </p>
      <p className="mt-1.5 whitespace-pre-wrap break-words font-display text-xs leading-relaxed text-fg-base/90">
        {body}
      </p>
    </div>
  );
}
