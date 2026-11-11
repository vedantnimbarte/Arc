import { useState, type ReactNode } from 'react';
import { ExternalLink, GitBranch, RefreshCw, type LucideIcon } from 'lucide-react';
import { shellOpenExternal, type GitHostComment } from '../../lib/tauri';
import { cn } from '../../lib/cn';
import { laneColor, relative } from './format';
import type { Glyph } from './stateGlyph';

/**
 * The shape every repo-scoped section wears: a toolbar across the top, the
 * timeline on the left, and the selected thing on the right.
 *
 * The list keeps a fixed width so the lane stays in the same place when you
 * move between sections — that column is the thing the eye learns.
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
      <Toolbar>{toolbar}</Toolbar>
      <div className="flex min-h-0 flex-1">
        <div className="w-[400px] shrink-0 overflow-y-auto border-r border-edge-1 bg-surface-1/40 px-1.5 py-2">
          {list}
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto">{detail}</div>
      </div>
    </div>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-edge-1 px-3">{children}</div>
  );
}

/** Segmented switch. Values are the caller's own strings. */
export function StateFilter({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; count?: number }[];
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-surface-1 p-0.5 ring-1 ring-inset ring-edge-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            'flex h-6 items-center gap-1.5 rounded-md px-2.5 font-display text-2xs font-medium transition-colors',
            'focus-visible:outline-none focus-visible:shadow-focus',
            value === o.value
              ? 'bg-surface-3 text-fg-base shadow-control'
              : 'text-fg-subtle hover:text-fg-muted',
          )}
        >
          {o.label}
          {o.count != null && (
            <span className="font-mono tabular-nums text-fg-subtle">{o.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export function RefreshButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Refresh"
      title="Refresh"
      className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base focus-visible:outline-none focus-visible:shadow-focus"
    >
      <RefreshCw size={13} strokeWidth={2} className={cn(loading && 'animate-spin')} />
    </button>
  );
}

/** How many items the toolbar is showing, in words. */
export function Count({ n, one, many }: { n: number; one: string; many: string }) {
  return (
    <span className="font-display text-2xs text-fg-subtle">
      <span className="font-mono tabular-nums text-fg-muted">{n}</span> {n === 1 ? one : many}
    </span>
  );
}

export function ErrorTray({ message }: { message: string }) {
  return (
    <div className="mb-2 flex items-start gap-2 rounded-lg bg-status-err/[0.08] px-3 py-2 font-display text-xs text-status-err/90 ring-1 ring-inset ring-status-err/20">
      <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-status-err" />
      <span className="min-w-0 break-words">{message}</span>
    </div>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 py-10 text-center font-display text-xs leading-relaxed text-fg-subtle">
      {children}
    </p>
  );
}

export function Loading() {
  return (
    <div className="flex h-full items-center justify-center py-10">
      <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-accent" />
    </div>
  );
}

// ─── Chips ─────────────────────────────────────────────────────────────────

/** "5h ago", or "just now" without a trailing "ago". */
export function ago(iso: string): string {
  const r = relative(iso);
  return r && r !== 'just now' ? `${r} ago` : r;
}

/** A fact with an icon: author, age, comment count. No separators — the gap
 *  and the icon do that job. */
export function Fact({ icon: Icon, children }: { icon?: LucideIcon; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-1 font-mono text-2xs tabular-nums text-fg-subtle">
      {Icon && <Icon size={10} strokeWidth={2.2} className="shrink-0" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

export function Avatar({ src, login }: { src?: string; login: string }) {
  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-1 font-mono text-2xs text-fg-muted">
      {src ? (
        <img src={src} alt="" className="h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-edge-2" />
      ) : (
        <span className="h-3.5 w-3.5 shrink-0 rounded-full bg-surface-3" />
      )}
      <span className="truncate">{login}</span>
    </span>
  );
}

/** A branch or tag, tagged like a git client's graph: its own lane colour,
 *  stable per name, so `main` looks the same in every row. */
export function BranchChip({ name, icon: Icon = GitBranch }: { name: string; icon?: LucideIcon }) {
  const c = laneColor(name);
  return (
    <span
      className="inline-flex h-[18px] min-w-0 max-w-[160px] shrink items-center gap-1 rounded px-1.5 font-mono text-2xs"
      style={{ color: c, backgroundColor: `${c}1f`, boxShadow: `inset 0 0 0 1px ${c}40` }}
      title={name}
    >
      <Icon size={10} strokeWidth={2.2} className="shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** `head → base`, read the way the merge goes. */
export function BranchFlow({ head, base }: { head: string; base: string }) {
  return (
    <span className="inline-flex min-w-0 shrink items-center gap-1">
      <BranchChip name={head} />
      <span className="font-mono text-2xs text-fg-subtle" aria-label="into">
        →
      </span>
      {/* The base is usually short and the one you check — keep it whole. */}
      <span className="flex shrink-0">
        <BranchChip name={base} />
      </span>
    </span>
  );
}

/** A repository label in the maintainers' own colour. */
export function LabelChip({ name, color }: { name: string; color: string }) {
  const c = `#${color || '888888'}`;
  return (
    <span
      className="inline-flex h-[18px] shrink-0 items-center rounded-full px-2 font-display text-2xs font-medium"
      style={{ color: c, backgroundColor: `${c}1f`, boxShadow: `inset 0 0 0 1px ${c}40` }}
    >
      {name}
    </span>
  );
}

/** State as a filled badge: the glyph's colour, its icon and its word. */
export function StateBadge({ glyph }: { glyph: Glyph }) {
  const Icon = glyph.icon;
  return (
    <span
      className={cn(
        'relative inline-flex h-6 shrink-0 items-center gap-1.5 overflow-hidden rounded-full px-2.5 font-display text-2xs font-semibold',
        glyph.className,
      )}
    >
      <span className="absolute inset-0 bg-current opacity-[0.14]" aria-hidden />
      <span className="absolute inset-0 rounded-full ring-1 ring-inset ring-current opacity-30" aria-hidden />
      <Icon size={12} strokeWidth={2.2} className="relative" />
      <span className="relative">{glyph.label}</span>
    </span>
  );
}

export function GitHubLink({ url, label = 'Open on GitHub' }: { url: string; label?: string }) {
  return (
    <button
      onClick={() => void shellOpenExternal(url)}
      title={label}
      aria-label={label}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base focus-visible:outline-none focus-visible:shadow-focus"
    >
      <ExternalLink size={13} strokeWidth={2} />
    </button>
  );
}

/** Title block at the top of a detail pane: state badge, number, title, facts
 *  and whatever actions the section allows. */
export function DetailHeader({
  glyph,
  number,
  title,
  facts,
  htmlUrl,
  actions,
}: {
  glyph: Glyph;
  number: ReactNode;
  title: string;
  facts: ReactNode;
  htmlUrl: string;
  actions?: ReactNode;
}) {
  return (
    <div className="shrink-0 border-b border-edge-1 px-5 pb-3.5 pt-4">
      <div className="flex items-center gap-2">
        <StateBadge glyph={glyph} />
        <span className="font-mono text-xs tabular-nums text-fg-subtle">{number}</span>
        <div className="flex-1" />
        {actions}
        <GitHubLink url={htmlUrl} />
      </div>
      <h2 className="mt-2.5 font-display text-lg font-semibold leading-snug tracking-tight text-fg-base">
        {title}
      </h2>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">{facts}</div>
    </div>
  );
}

/** Primary and quiet button styles, shared so every section's actions match. */
export const buttonPrimary =
  'flex h-7 items-center gap-1.5 rounded-md bg-accent px-3 font-display text-xs font-semibold text-bg-base transition-all duration-150 hover:bg-accent-bright active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none disabled:opacity-40';
export const buttonQuiet =
  'flex h-7 items-center gap-1.5 rounded-md bg-surface-2 px-3 font-display text-xs font-medium text-fg-base ring-1 ring-inset ring-edge-2 transition-all duration-150 hover:bg-surface-3 active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none disabled:opacity-40';
export const buttonGhost =
  'flex h-7 items-center gap-1.5 rounded-md px-2.5 font-display text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none disabled:opacity-40';

/**
 * The conversation: the opening body, then each comment, then a box to add
 * one. The body is rendered as plain text rather than Markdown — a Markdown
 * renderer is a dependency and an XSS surface for content written by strangers,
 * and the point here is to read what was said, not to reproduce github.com.
 *
 * Drawn as a timeline: each entry is a node on the same lane the lists use.
 */
export function CommentThread({
  body,
  author,
  authorAvatar,
  comments,
  onPost,
}: {
  body: string;
  author: string;
  authorAvatar?: string;
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
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <ol className="relative">
          <span aria-hidden className="absolute bottom-3 left-[7px] top-3 w-px bg-edge-2" />
          <Entry author={author} avatar={authorAvatar} when="" body={body} opening />
          {comments.map((c) => (
            <Entry key={c.id} author={c.author} when={c.created_at} body={c.body} />
          ))}
        </ol>
      </div>

      <div className="shrink-0 border-t border-edge-1 p-3">
        {error && <ErrorTray message={error} />}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void post();
          }}
          placeholder="Leave a comment"
          rows={3}
          className="w-full resize-y rounded-lg bg-surface-1 p-2.5 font-display text-xs leading-relaxed text-fg-base ring-1 ring-inset ring-edge-2 placeholder:text-fg-subtle/70 focus:outline-none focus:shadow-focus"
        />
        <div className="mt-2 flex items-center gap-2">
          <button onClick={() => void post()} disabled={busy || !draft.trim()} className={buttonQuiet}>
            {busy ? 'Posting…' : 'Comment'}
          </button>
          <span className="font-display text-2xs text-fg-subtle">Ctrl+Enter to post</span>
        </div>
      </div>
    </div>
  );
}

function Entry({
  author,
  avatar,
  when,
  body,
  opening,
}: {
  author: string;
  avatar?: string;
  when: string;
  body: string;
  opening?: boolean;
}) {
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      <span className="relative mt-[3px] flex h-[15px] w-[15px] shrink-0 items-center justify-center">
        {avatar ? (
          <img src={avatar} alt="" className="h-[15px] w-[15px] rounded-full ring-2 ring-bg-base" />
        ) : (
          <span
            className={cn(
              'h-[9px] w-[9px] rounded-full ring-2 ring-bg-base',
              opening ? 'bg-accent' : 'bg-fg-subtle',
            )}
          />
        )}
      </span>
      <div className="min-w-0 flex-1 rounded-lg bg-surface-1 ring-1 ring-inset ring-edge-1">
        <p className="flex items-center gap-2 border-b border-edge-1 px-3 py-1.5 font-mono text-2xs text-fg-muted">
          <span className="font-medium text-fg-base/85">{author}</span>
          {opening ? (
            <span className="text-fg-subtle">opened this</span>
          ) : (
            when && <span className="text-fg-subtle">{ago(when)}</span>
          )}
        </p>
        {body.trim() ? (
          <p className="whitespace-pre-wrap break-words px-3 py-2.5 font-display text-xs leading-relaxed text-fg-base/90">
            {body}
          </p>
        ) : (
          <p className="px-3 py-2.5 font-display text-xs italic text-fg-subtle">No description.</p>
        )}
      </div>
    </li>
  );
}
