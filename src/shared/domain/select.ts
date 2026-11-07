// Selection helpers. The "track the best item by a numeric score" loop — a running
// `best`/`bestScore` scan — was hand-rolled ~8× (nearest vein/waypoint/peer/mob/frame, backup
// tool). This is the one home. Pure, dependency-light (only pos geometry).
import { dist2 } from "@/core/prim/pos";
import type { Vec3 } from "@/core/runtime/types";

/** The item minimizing `score`. Ties keep the FIRST seen (matches the hand-rolled `s < best`
 *  scans it replaces). `null` for an empty input. */
export function minBy<T>(items: Iterable<T>, score: (item: T) => number): T | null {
  let best: T | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const s = score(item);
    if (s < bestScore) {
      bestScore = s;
      best = item;
    }
  }
  return best;
}

/** The item whose position (via `toVec`) is nearest `from` (squared 3-D distance — argmin is
 *  identical to true distance). Ties keep the first seen. `null` for an empty input. */
export function nearestBy<T>(items: Iterable<T>, from: Vec3, toVec: (item: T) => Vec3): T | null {
  return minBy(items, (item) => dist2(from, toVec(item)));
}
