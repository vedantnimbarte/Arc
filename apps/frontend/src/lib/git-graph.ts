// Lane assignment for git commit graphs.
//
// Input: commits in newest-first order (the way `git log` emits them),
// each with their full parent SHAs. Output: per-commit lane index plus the
// set of edges that should be drawn between this row and the next.
//
// Algorithm (a textbook left-pack):
//   Walk top-down. Maintain `lanes` — an array of pending child OIDs,
//   one per lane. For each commit C:
//     * find the leftmost lane whose pending OID equals C.oid; if none,
//       allocate a fresh one at the end. That's C's column.
//     * sweep every OTHER lane that was also pending C.oid and "fold" it
//       into C's column (octopus merges, or a commit reached from two
//       refs) — those lanes go vacant.
//     * substitute C's first parent into C's lane (or vacate it if C has
//       no parents — a root commit).
//     * for each additional parent of C, find an existing lane already
//       pointing at it (forks rejoin) or allocate a new lane.
//     * compact trailing vacant lanes so the graph hugs the left edge.
//
// The output edges are tuples (fromLane, toLane) describing where each
// of this row's "outgoing" connections should land in the NEXT row.

import type { GitLogEntry } from './tauri';

export interface GraphRow {
  /** Commit at this row. */
  commit: GitLogEntry;
  /** Zero-based lane index where this commit's dot is drawn. */
  lane: number;
  /** Lane indices that pass straight through this row without bending.
   *  (i.e. lanes whose pending child isn't this commit.) */
  throughLanes: number[];
  /** Edges leaving this row: (lane in THIS row, lane in NEXT row).
   *  A vertical edge has from === to. */
  edges: Array<[number, number]>;
  /** Total lane width at this row, used for stable horizontal sizing. */
  width: number;
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Max lane width seen across all rows — useful for sizing the graph column. */
  maxWidth: number;
}

export function layoutGraph(commits: GitLogEntry[]): GraphLayout {
  // `lanes[i]` is the OID the lane is currently waiting to encounter. An
  // empty string means the lane is vacant and can be reused.
  const lanes: string[] = [];
  const rows: GraphRow[] = [];
  let maxWidth = 0;

  const findOrAllocateLane = (oid: string): number => {
    for (let i = 0; i < lanes.length; i += 1) {
      if (lanes[i] === oid) return i;
    }
    for (let i = 0; i < lanes.length; i += 1) {
      if (lanes[i] === '') {
        lanes[i] = oid;
        return i;
      }
    }
    lanes.push(oid);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    // 1. Locate this commit's lane (the leftmost lane awaiting its OID,
    //    or a fresh lane for a branch tip that has no descendants in our
    //    window).
    let myLane = lanes.findIndex((l) => l === commit.oid);
    if (myLane === -1) {
      myLane = findOrAllocateLane(commit.oid);
    }

    // 2. Fold any other lanes that were also expecting this OID — they
    //    converge into myLane here. The previous row emitted a vertical
    //    pass-through (siblingLane, siblingLane); rewrite it to bend
    //    into myLane so the line actually terminates at the dot.
    const convergingLanes: number[] = [];
    for (let i = 0; i < lanes.length; i += 1) {
      if (i !== myLane && lanes[i] === commit.oid) {
        convergingLanes.push(i);
        lanes[i] = '';
      }
    }
    if (convergingLanes.length > 0 && rows.length > 0) {
      const prev = rows[rows.length - 1]!;
      for (const src of convergingLanes) {
        const idx = prev.edges.findIndex(([f, t]) => f === src && t === src);
        if (idx !== -1) {
          prev.edges[idx] = [src, myLane];
        }
      }
    }

    // 3. Mutate lanes for the NEXT row based on this commit's parents.
    if (commit.parents.length === 0) {
      lanes[myLane] = '';
    } else {
      const first = commit.parents[0]!;
      const rest = commit.parents.slice(1);
      lanes[myLane] = first;
      for (const p of rest) {
        // If a sibling lane is already heading to this parent, just
        // bend our extra edge into it; otherwise allocate.
        let existing = lanes.findIndex((l, idx) => l === p && idx !== myLane);
        if (existing === -1) {
          existing = findOrAllocateLane(p);
        }
        // The edge from myLane → existing is recorded in step 5 below.
        void existing;
      }
    }

    // 4. Compact trailing vacant lanes so the graph stays tidy. We don't
    //    compact mid-row vacancies — that would force every right-of-me
    //    lane to bend, which makes the picture much harder to read.
    while (lanes.length > 0 && lanes[lanes.length - 1] === '') {
      lanes.pop();
    }
    const widthAfter = lanes.length;

    // 5. Compute edges from THIS row → NEXT row.
    //    Vertical pass-through for every lane that is not myLane and
    //    still has the same pending OID it had before this row (which we
    //    detect by checking lanes[i] !== '' && i !== myLane). For myLane
    //    itself we emit one edge per parent (or none if root).
    const edges: Array<[number, number]> = [];
    const throughLanes: number[] = [];
    for (let i = 0; i < widthAfter; i += 1) {
      if (i === myLane) continue;
      if (lanes[i] === '') continue;
      edges.push([i, i]);
      throughLanes.push(i);
    }
    if (commit.parents.length > 0) {
      // First parent: continues in myLane.
      edges.push([myLane, myLane]);
      // Additional parents: edge from myLane into whichever lane now
      // holds that parent OID.
      for (let pi = 1; pi < commit.parents.length; pi += 1) {
        const targetLane = lanes.findIndex((l) => l === commit.parents[pi]);
        if (targetLane !== -1 && targetLane !== myLane) {
          edges.push([myLane, targetLane]);
        }
      }
    }
    const widthHere = Math.max(myLane + 1, widthAfter);
    if (widthHere > maxWidth) maxWidth = widthHere;

    rows.push({
      commit,
      lane: myLane,
      throughLanes,
      edges,
      width: widthHere,
    });
  }

  return { rows, maxWidth };
}

/** Stable per-lane colour. Cycles through a small palette so lanes are
 *  distinguishable but the visual noise stays bounded. */
export function laneColor(lane: number, palette: string[]): string {
  return palette[lane % palette.length]!;
}
