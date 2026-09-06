import {
  CheckCircle2,
  CircleDot,
  CircleSlash,
  Clock,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  MinusCircle,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { GitHostPrSummary } from '../../lib/tauri';

/**
 * The state gutter.
 *
 * Every list in the GitHub tab puts a glyph in the same left column, and its
 * colour is the only saturated colour on the screen. Scanning that one column
 * top to bottom answers "what's open, what merged, what failed" without
 * reading a word — so these mappings are load-bearing, not decoration.
 *
 * The glyphs are GitHub's own semantics (a merged PR is an arrow joining, a
 * failed check is a cross), because that vocabulary is already in the reader's
 * head.
 */
export interface Glyph {
  icon: LucideIcon;
  className: string;
  /** Screen-reader wording, since colour and shape carry the meaning. */
  label: string;
}

export function issueGlyph(state: 'open' | 'closed'): Glyph {
  return state === 'open'
    ? { icon: CircleDot, className: 'text-status-ok', label: 'Open' }
    : { icon: CheckCircle2, className: 'text-status-merged', label: 'Closed' };
}

export function prGlyph(pr: Pick<GitHostPrSummary, 'state' | 'draft'>): Glyph {
  if (pr.state === 'merged') {
    return { icon: GitMerge, className: 'text-status-merged', label: 'Merged' };
  }
  if (pr.state === 'closed') {
    return { icon: CircleSlash, className: 'text-status-err', label: 'Closed' };
  }
  if (pr.draft) {
    return { icon: GitPullRequestDraft, className: 'text-fg-subtle', label: 'Draft' };
  }
  return { icon: GitPullRequest, className: 'text-status-ok', label: 'Open' };
}

/**
 * A workflow run, check run, or job — all three use GitHub's status/conclusion
 * pair, so one mapping covers them.
 *
 * `status` wins while the thing is still moving: a run that is `in_progress`
 * has a stale `conclusion` from nothing at all, and showing last time's result
 * as if it were this time's is the one wrong answer here.
 */
export function runGlyph(status: string, conclusion: string): Glyph {
  if (status !== 'completed') {
    return status === 'queued' || status === 'waiting' || status === 'requested'
      ? { icon: Clock, className: 'text-fg-subtle', label: 'Queued' }
      : { icon: Clock, className: 'text-status-warn', label: 'Running' };
  }
  switch (conclusion) {
    case 'success':
      return { icon: CheckCircle2, className: 'text-status-ok', label: 'Passed' };
    case 'failure':
    case 'timed_out':
      return { icon: XCircle, className: 'text-status-err', label: 'Failed' };
    case 'cancelled':
      return { icon: CircleSlash, className: 'text-fg-subtle', label: 'Cancelled' };
    case 'action_required':
      return { icon: CircleDot, className: 'text-status-warn', label: 'Needs action' };
    default:
      // neutral, skipped, stale, and anything GitHub adds later.
      return { icon: MinusCircle, className: 'text-fg-subtle', label: conclusion || 'Done' };
  }
}
