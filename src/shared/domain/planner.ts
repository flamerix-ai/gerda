import { encodePos } from "@/core/prim/pos";
import type { Vec3 } from "@/core/runtime/types";
// Planner — A* over the movement-type registry, the navigator's local pathfinder.
// Pure: searches a BlockReader (a world-view snapshot) from `start` to `goal`, returning
// a cell-by-cell path or null. The cost model is core/prim/movement-physics (walk/jump/
// fall ticks); the heuristic is admissible (Euclidean × walk cost ≤ any real path cost), so
// A* is optimal. JPS and a domain cost function (ore-cheap / lava-∞ / teleport-aware) are
// later optimizations layered on this same neighbor expansion.
import type { Goal } from "@/shared/domain/goal";
import { BinaryHeap } from "@/shared/domain/heap";
import {
  DEFAULT_PLAN_OPTS,
  type MoveKind,
  type MoveResult,
  type PlanOpts,
  neighbors,
} from "@/shared/domain/movement-types";
import { type BlockReader, hazardAt, passableCell, walkableAt } from "@/shared/domain/senses";

/**
 * Domain cost overlay — the seam that lets ONE search serve every behaviour. The planner asks the
 * CostContext for the effective cost of each move; missions overlay knowledge here (ore cheap,
 * hazard-adjacent dear, never-break-a-build = ∞) WITHOUT touching the planner. Default = the raw
 * movement cost. This is also where a future D* Lite reads edge costs to repair a path. Must stay
 * ≥ 0 and not undercut the heuristic (admissibility), or A* optimality breaks.
 */
export interface CostContext {
  edgeCost(from: Vec3, move: MoveResult): number;
}

export const DEFAULT_COST: CostContext = { edgeCost: (_from, move) => move.cost };

export interface PlannerOpts extends PlanOpts {
  /** Hard cap on node expansions — bounds the search so a hopeless goal can't spin. */
  readonly maxExpansions: number;
  /** If the EXACT goal cell is unreachable, return the path to the closest reached cell (lowest
   *  heuristic) instead of null. Lets the navigator APPROACH a goal it can't land on exactly —
   *  e.g. a walk-to-vein goal whose Y was guessed (bot's current Y) but the column's real surface
   *  is a couple blocks off, so the exact cell floats in air. Null only if it can't beat `start`.
   *  Off by default: an exact ore target must still return null→blocked so the drill routes to
   *  DIG_TO/BRIDGE instead of stopping short. */
  readonly bestEffort?: boolean;
}

export const DEFAULT_PLANNER_OPTS: PlannerOpts = { ...DEFAULT_PLAN_OPTS, maxExpansions: 5000 };

/** The move POLICY that arrived at a path cell. `"start"` is the sentinel for `path[0]` (no
 *  move arrives at the start cell); every other element is the `MoveKind` of the edge that reached it. */
export type PathKind = MoveKind | "start";

export interface PlanResult {
  /** Cells from `start` (inclusive) to `goal` (inclusive). */
  readonly path: Vec3[];
  /** The move policy that ARRIVED at each `path[i]`: `kinds[0] === "start"`, and for i ≥ 1
   *  `kinds[i]` is the `MoveKind` of the edge `path[i-1] → path[i]`. Parallel to `path` (same length).
   *  The executor dispatches on this instead of re-deriving the move from geometry. */
  readonly kinds: PathKind[];
  readonly cost: number;
  readonly expanded: number;
}

/**
 * A* from `start` (an integer feet cell) toward `goal` (a Goal — point, column, or radius). Returns
 * the optimal path + total tick cost to the first cell satisfying `goal.isInGoal`, or null if the
 * goal is unreachable within `maxExpansions`. `start` need not be walkable (the player is already
 * there). `cost` overlays domain edge costs (DEFAULT_COST = raw movement cost).
 */
export function planPath(
  reader: BlockReader,
  start: Vec3,
  goal: Goal,
  opts: PlannerOpts = DEFAULT_PLANNER_OPTS,
  cost: CostContext = DEFAULT_COST,
): PlanResult | null {
  const startK = encodePos(start.x, start.y, start.z);

  const gScore = new Map<string, number>([[startK, 0]]);
  const cameFrom = new Map<string, string>();
  // The move kind that arrived at each relaxed cell (keyed by cell key) — threaded to the executor so
  // it dispatches on the planner's policy instead of re-deriving it from geometry.
  const cameKind = new Map<string, MoveKind>();
  const cell = new Map<string, Vec3>([[startK, start]]);
  const closed = new Set<string>();
  const open = new BinaryHeap<{ p: number; k: string }>((a, b) => a.p < b.p);
  open.push({ p: goal.heuristic(start), k: startK });

  // Closest reached cell to the goal (lowest heuristic), for the bestEffort fallback. Seeded at
  // `start` so "can't beat start" ⇒ bestK stays startK ⇒ null (genuinely blocked, no approach).
  let bestK = startK;
  let bestH = goal.heuristic(start);

  let expanded = 0;
  while (open.size > 0) {
    const top = open.pop();
    if (top === undefined) continue;
    const curK = top.k;
    if (closed.has(curK)) continue;
    const cur = cell.get(curK);
    if (!cur) continue;

    // First popped node in the goal is optimal (the heuristic is admissible) — works for a point,
    // an XZ column (any Y), or a radius, since the Goal owns the arrival test.
    if (goal.isInGoal(cur))
      return reconstruct(cameFrom, cameKind, cell, curK, gScore.get(curK) ?? 0, expanded);

    closed.add(curK);
    const curH = goal.heuristic(cur);
    if (curH < bestH) {
      bestH = curH;
      bestK = curK;
    }
    if (++expanded > opts.maxExpansions) break;

    const baseG = gScore.get(curK) ?? Number.POSITIVE_INFINITY;
    for (const move of neighbors(reader, cur, opts)) {
      const nk = encodePos(move.to.x, move.to.y, move.to.z);
      if (closed.has(nk)) continue;
      const ng = baseG + cost.edgeCost(cur, move);
      if (ng < (gScore.get(nk) ?? Number.POSITIVE_INFINITY)) {
        gScore.set(nk, ng);
        cameFrom.set(nk, curK);
        cameKind.set(nk, move.kind);
        cell.set(nk, move.to);
        open.push({ p: ng + goal.heuristic(move.to), k: nk });
      }
    }
  }
  // Goal unreachable. bestEffort → return the path to the closest cell we could stand on (so the
  // navigator APPROACHES a floating/wrong-Y goal instead of giving up); else a hard null.
  if (opts.bestEffort && bestK !== startK) {
    return reconstruct(cameFrom, cameKind, cell, bestK, gScore.get(bestK) ?? 0, expanded);
  }
  return null;
}

/** Integer cells from `a` (EXCLUSIVE) to `b` (INCLUSIVE) on the same Y, each step Chebyshev-adjacent
 *  (≤1 in x and z). The straight-line re-interpolation string-pull leans on. */
function lineCellsFlat(a: Vec3, b: Vec3): Vec3[] {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const steps = Math.max(Math.abs(dx), Math.abs(dz));
  const cells: Vec3[] = [];
  for (let k = 1; k <= steps; k++) {
    cells.push({
      x: a.x + Math.round((dx * k) / steps),
      y: a.y,
      z: a.z + Math.round((dz * k) / steps),
    });
  }
  return cells;
}

/** Is the straight SAME-Y corridor `a`→`b` clear to walk — every cell walkable + non-hazard, every
 *  diagonal hop corner-safe? Mirrors MovementDiagonal's corner-cut guard so a string-pull can never
 *  cut a wall corner the planner itself forbade. */
function losClearFlat(reader: BlockReader, a: Vec3, b: Vec3): boolean {
  let prev = a;
  for (const c of lineCellsFlat(a, b)) {
    if (!walkableAt(reader, c)) return false;
    if (hazardAt(reader, c) || hazardAt(reader, { x: c.x, y: c.y + 1, z: c.z })) return false;
    if (c.x !== prev.x && c.z !== prev.z) {
      // Diagonal hop prev→c: both grazed orthogonal corners open at feet + head, or the 0.6-wide
      // player snags the corner (same rule MovementDiagonal enforces).
      for (const o of [
        { x: c.x, z: prev.z },
        { x: prev.x, z: c.z },
      ]) {
        if (!passableCell(reader, { x: o.x, y: c.y, z: o.z })) return false;
        if (!passableCell(reader, { x: o.x, y: c.y + 1, z: o.z })) return false;
      }
    }
    prev = c;
  }
  return true;
}

/**
 * String-pull a planned path: collapse A*'s equal-cost zigzag on contiguous SAME-Y walkable runs to
 * the straightest adjacent-cell line, leaving every NON-flat cell (step / drop / parkour / bridge /
 * mine — any Y change) exactly where the planner put it. Fewer heading changes → the executor's
 * guarded sprint holds through a detour instead of dropping at each jog (the +14 % detour loss).
 *
 * Re-interpolates each kept segment back to ADJACENT cells (lineCellsFlat), so the executor's
 * "next is ≤1 cell away" dispatch invariant is preserved — this is purely a route-tightening pass,
 * never a waypoint-skip. Pure; LOS uses the SAME walkability the planner trusts, and the executor's
 * live per-step hazard veto still guards every step. A no-op (returns the input) below 3 cells.
 */
export function smoothPath(
  reader: BlockReader,
  path: Vec3[],
  kinds: PathKind[],
): { path: Vec3[]; kinds: PathKind[] } {
  const first = path[0];
  if (path.length <= 2 || !first) return { path, kinds };
  const outP: Vec3[] = [first];
  const outK: PathKind[] = [kinds[0] ?? "start"];
  let i = 0;
  while (i < path.length - 1) {
    const a = path[i];
    const nxt = path[i + 1];
    if (!a || !nxt) break;
    // A Y change is a vertical/step/jump/bridge move the executor must drive explicitly — preserve the
    // cell AND its policy kind (a stepUp / drop / mine / pillar / ladder must not be flattened to a walk).
    // A PARKOUR is the one SAME-Y move that spans >1 cell (a 2–4 cell sprint-jump over an open gap):
    // string-pulling it would lineCellsFlat the takeoff→landing jump, INSERTING the air cells over the
    // void as bogus `parkour` steps — the executor then parkours to the first air cell, whose floor is
    // gone → ABORT_FLOOR_GONE every tick (and that abort never latches parkourGaveUp → an infinite
    // retreat/abort loop that never bridges). Preserve it verbatim like a Y-change move.
    if (nxt.y !== a.y || kinds[i + 1] === "parkour") {
      outP.push(nxt);
      outK.push(kinds[i + 1] ?? "traverse");
      i++;
      continue;
    }
    // Farthest same-Y cell reachable from `a` by a clear straight corridor (string-pull target).
    let far = i + 1;
    for (let j = i + 2; j < path.length; j++) {
      const pj = path[j];
      if (!pj || pj.y !== a.y) break;
      if (losClearFlat(reader, a, pj)) far = j;
    }
    const dest = path[far];
    if (dest) {
      const cells = lineCellsFlat(a, dest);
      for (const c of cells) {
        outP.push(c);
        // A GENUINE collapse (far > i+1) replaces a run of same-Y walkable cells (losClearFlat verified
        // the whole corridor is walkable) with interpolated cells → all `traverse`. A no-op segment (far
        // == i+1, a single adjacent cell) is NOT re-interpolated — preserve its original move kind so a
        // same-Y non-walk move (mineTraverse / bridgePlace / ladderEnter) keeps its policy.
        outK.push(far === i + 1 ? (kinds[far] ?? "traverse") : "traverse");
      }
    }
    i = far;
  }
  return { path: outP, kinds: outK };
}

function reconstruct(
  cameFrom: Map<string, string>,
  cameKind: Map<string, MoveKind>,
  cell: Map<string, Vec3>,
  goalK: string,
  cost: number,
  expanded: number,
): PlanResult {
  const path: Vec3[] = [];
  const kinds: PathKind[] = [];
  let k: string | undefined = goalK;
  while (k !== undefined) {
    const c = cell.get(k);
    if (c) {
      path.push(c);
      // The move that arrived at THIS cell; the start cell has none → the "start" sentinel.
      kinds.push(cameKind.get(k) ?? "start");
    }
    k = cameFrom.get(k);
  }
  path.reverse();
  kinds.reverse();
  return { path, kinds, cost, expanded };
}
