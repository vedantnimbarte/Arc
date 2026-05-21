import { useMemo } from 'react';
import { MOCHA } from '@arc/ui';
import { cn } from '../../lib/cn';
import { layoutGraph } from '../../lib/git-graph';
import type { GitLogEntry } from '../../lib/tauri';
import { colorForAuthor } from './AuthorsSidebar';

interface Props {
  commits: GitLogEntry[];
  emptyHint?: string;
}

const ROW_HEIGHT = 28;
const LANE_WIDTH = 14;
const LEFT_PAD = 12;

// Lane palette — cycles through a handful of Mocha hues that contrast
// against the dark surface and against each other.
const LANE_COLORS = [
  MOCHA.blue,
  MOCHA.green,
  MOCHA.peach,
  MOCHA.mauve,
  MOCHA.teal,
  MOCHA.yellow,
  MOCHA.red,
  MOCHA.sapphire,
  MOCHA.pink,
];

export function CommitGraph({ commits, emptyHint }: Props) {
  const layout = useMemo(() => layoutGraph(commits), [commits]);

  if (commits.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10 font-display text-[12px] text-fg-subtle">
        {emptyHint ?? 'No commits match the current filters.'}
      </div>
    );
  }

  const graphWidth = LEFT_PAD + Math.max(1, layout.maxWidth) * LANE_WIDTH + 8;
  const totalHeight = layout.rows.length * ROW_HEIGHT;

  return (
    <div className="relative flex-1 overflow-y-auto">
      <div className="relative" style={{ height: totalHeight }}>
        {/* SVG occupies its own column on the left; rows scroll together. */}
        <svg
          width={graphWidth}
          height={totalHeight}
          className="absolute left-0 top-0 shrink-0"
          aria-hidden
        >
          {layout.rows.map((row, idx) => {
            const next = layout.rows[idx + 1];
            const y = idx * ROW_HEIGHT + ROW_HEIGHT / 2;
            const yNext = (idx + 1) * ROW_HEIGHT + ROW_HEIGHT / 2;
            const cx = LEFT_PAD + row.lane * LANE_WIDTH;

            return (
              <g key={row.commit.oid}>
                {/* Edges from this row → next row */}
                {next &&
                  row.edges.map(([from, to], j) => {
                    const x1 = LEFT_PAD + from * LANE_WIDTH;
                    const x2 = LEFT_PAD + to * LANE_WIDTH;
                    const stroke = LANE_COLORS[to % LANE_COLORS.length];
                    if (x1 === x2) {
                      return (
                        <line
                          key={j}
                          x1={x1}
                          y1={y}
                          x2={x2}
                          y2={yNext}
                          stroke={stroke}
                          strokeWidth={1.5}
                          strokeLinecap="round"
                        />
                      );
                    }
                    // Diagonal-ish curve: a smooth S so merges/forks
                    // read as a join rather than a kink.
                    const my = (y + yNext) / 2;
                    return (
                      <path
                        key={j}
                        d={`M ${x1} ${y} C ${x1} ${my}, ${x2} ${my}, ${x2} ${yNext}`}
                        stroke={stroke}
                        strokeWidth={1.5}
                        fill="none"
                        strokeLinecap="round"
                      />
                    );
                  })}

                {/* The commit dot itself, painted on top of the edges. */}
                <circle
                  cx={cx}
                  cy={y}
                  r={4}
                  fill={colorForAuthor(row.commit.author, row.commit.email)}
                  stroke="#11111b"
                  strokeWidth={1.5}
                />
              </g>
            );
          })}
        </svg>

        {/* Right-side metadata rows. Positioned absolutely so they line
            up exactly with the SVG dots regardless of scroll. */}
        <ul
          className="absolute right-0 top-0"
          style={{ left: graphWidth, height: totalHeight }}
        >
          {layout.rows.map((row, idx) => (
            <li
              key={row.commit.oid}
              className={cn(
                'flex items-center gap-2 border-b border-border-hairline/40 px-3',
                'transition-colors hover:bg-white/[0.03]',
              )}
              style={{ height: ROW_HEIGHT }}
              title={row.commit.oid}
            >
              <span className="shrink-0 font-mono text-[11px] text-fg-subtle">
                {row.commit.short}
              </span>
              <span className="min-w-0 flex-1 truncate font-display text-[12.5px] text-fg-base">
                {row.commit.subject || (
                  <span className="italic text-fg-subtle">(no subject)</span>
                )}
              </span>
              {row.commit.parents.length > 1 && (
                <span className="rounded-sm bg-white/[0.05] px-1.5 py-[1px] font-display text-[9.5px] uppercase tracking-widest2 text-fg-subtle">
                  merge
                </span>
              )}
              <span className="shrink-0 truncate font-display text-[11px] text-fg-muted">
                {row.commit.author}
              </span>
              <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-fg-subtle">
                {formatRelative(row.commit.time)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function formatRelative(unixSeconds: number): string {
  if (!unixSeconds) return '—';
  const diff = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 30 * 86_400) return `${Math.floor(diff / 86_400)}d`;
  if (diff < 365 * 86_400) return `${Math.floor(diff / (30 * 86_400))}mo`;
  return `${Math.floor(diff / (365 * 86_400))}y`;
}
