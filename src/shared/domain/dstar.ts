import { encodePos } from "@/core/prim/pos";
import type { Vec3 } from "@/core/runtime/types";
// D* Lite — incremental replanning over the movement-type graph (the planner's
// "the right algorithm is incremental" thesis). Where planPath (A*) re-searches from scratch
// every time the route invalidates, D* Lite keeps a GOAL-rooted search tree and REPAIRS it as
// the agent moves and the world changes under it — the cost of an update is proportional to
// the changed region, not the whole map. This is the differentiator for a self-modifying mining
// world: the bot plans far (e.g. to a mountain peak) ONCE and follows a per-tick-cheap repair.
//
// Faithful to Koenig & Likhachev, "D* Lite" (AAAI 2002): backward search from the goal, g/rhs
// one-step-lookahead values, a priority queue keyed by [min(g,rhs)+h(start,·)+km, min(g,rhs)],
// and a km key-modifier that lets the start MOVE without re-keying the whole queue.
//
// SCOPE: the graph is the BOUNDED move set (walk / step / drop / diagonal / parkour). The
// backward search needs PREDECESSORS, which we compute by reverse-enumeration over the SSOT
// `neighbors()` within a bounded box — correct only while every move has bounded reach. The
// constructive/destructive moves (bridge / pillar / mine / waterDrop) have large, asymmetric
// reach, so the navigator keeps A* for those (see greedy-nav). `engageable()` enforces the gate.
import { type Goal, octileXZ } from "@/shared/domain/goal";
import { BinaryHeap } from "@/shared/domain/heap";
import {
  type MoveKind,
  type MoveResult,
  type PlanOpts,
  neighbors,
} from "@/shared/domain/movement-types";
import {
  type CostContext,
  DEFAULT_COST,
  type PathKind,
  type PlannerOpts,
} from "@/shared/domain/planner";
import { type BlockReader, climbableAt, walkableAt } from "@/shared/domain/senses";

const INF = Number.POSITIVE_INFINITY;

/** ADMISSIBLE feet-cell→feet-cell estimate (ticks) — octile HORIZONTAL distance only (Baritone
 *  GoalXZ). It focuses the backward search toward the moving start via h(start, ·). Deliberately
 *  drops the vertical |dy|·WALK term that GoalBlock adds: a single move (a drop, a stepUp) covers
 *  horizontal AND vertical at once for LESS than octile+level summed, so the summed form
 *  OVERESTIMATES such a move and is inadmissible — which silently prunes the optimal vertex and
 *  yields a costlier path. Horizontal octile alone is a true lower bound (you must cover the XZ
 *  distance, ≥ WALK per cardinal / √2·WALK per diagonal block, whatever the altitude change), so
 *  D* Lite stays optimal. */
function cellHeuristic(a: Vec3, b: Vec3): number {
  return octileXZ(a.x - b.x, a.z - b.z);
}

/** A move kind has bounded reach ⇔ D* Lite can enumerate its predecessors. The large/asymmetric
 *  constructive+destructive moves are A*-only. Mirrors which PlanOpts flags the navigator may set
 *  before choosing the D* Lite path. */
export function engageable(opts: PlanOpts): boolean {
  return !opts.bridge && !opts.canPillar && !opts.mine && !opts.waterDrop;
}

/** Lazy-deletion min-heap of (lexicographic key, cellKey). D* Lite needs decrease-key + remove;
 *  the authoritative current key of each queued vertex lives in `open`, and a heap entry whose key
 *  no longer matches `open` is stale and skipped on peek. No position map, no non-null assertions. */
class DStarQueue {
  private readonly heap = new BinaryHeap<{ k1: number; k2: number; ck: string }>((a, b) =>
    keyLess(a.k1, a.k2, b.k1, b.k2),
  );
  // Authoritative current key of each queued vertex — a heap entry whose key no longer matches
  // this map is stale (lazily discarded on peek).
  private readonly open = new Map<string, readonly [number, number]>();

  has(ck: string): boolean {
    return this.open.has(ck);
  }

  /** Insert or re-key a vertex. The previous heap entry (if any) becomes stale. */
  set(ck: string, k1: number, k2: number): void {
    this.open.set(ck, [k1, k2]);
    this.heap.push({ k1, k2, ck });
  }

  remove(ck: string): void {
    this.open.delete(ck); // entry skipped lazily on peek
  }

  /** Smallest live key, or undefined if empty. Pops stale entries it passes (so it terminates). */
  private peek(): { k1: number; k2: number; ck: string } | undefined {
    while (this.heap.size > 0) {
      const top = this.heap.peek();
      if (top === undefined) return undefined;
      const cur = this.open.get(top.ck);
      if (cur && cur[0] === top.k1 && cur[1] === top.k2) return top;
      this.heap.pop(); // stale — discard and look again
    }
    return undefined;
  }

  topKey(): readonly [number, number] | undefined {
    const t = this.peek();
    return t ? [t.k1, t.k2] : undefined;
  }

  topCell(): string | undefined {
    return this.peek()?.ck;
  }
}

function keyLess(a1: number, a2: number, b1: number, b2: number): boolean {
  return a1 < b1 || (a1 === b1 && a2 < b2);
}

/** Relative tolerance for a lexicographic-key k1 comparison. Movement costs are floats, and the SAME
 *  path cost summed via different groupings rounds differently — e.g. a queued vertex's key
 *  `min(g,rhs) + h(start,·)` (2 edge-costs + a 3-cell octile heuristic) vs the start's `g` (5 edge
 *  costs accumulated) are mathematically 5 walk-edges but can differ by a single ULP. */
const KEY_EPS = 1e-9;

/** Float-tolerant "key A is lexicographically BELOW key B" for the convergence test. A k1 gap within
 *  a relative ULP is a heuristic-rounding TIE, so it must fall through to the k2 tiebreak instead of
 *  reading as "A ≥ B". Without this, a tied-but-slightly-larger queue top halts D* Lite's increase-
 *  wave one pop early, leaving stale g on the vertices upstream of a severed route — the intermittent
 *  incremental-repair miss (a raise that buries a cell reports the goal unreachable / a stale cost).
 *  Used ONLY by converged(); the heap order + expandTop re-key stay on the exact keyLess (a tie there
 *  is a harmless no-op, and an exact heap comparator keeps a valid strict-weak ordering). */
function keyLessTol(a1: number, a2: number, b1: number, b2: number): boolean {
  const eps = KEY_EPS * (1 + Math.max(Math.abs(a1), Math.abs(b1)));
  if (a1 < b1 - eps) return true;
  if (a1 > b1 + eps) return false;
  return a2 < b2; // k1 within float tolerance → a true tie, break on k2
}

/** Result of a D* Lite path query — same shape as planner.PlanResult so it drops into the executor.
 *  `kinds` is the parallel move-policy array: `kinds[0] === "start"`, `kinds[i≥1]` = the kind
 *  of the g-descent edge that reached `path[i]`. */
export interface DStarPath {
  readonly path: Vec3[];
  readonly kinds: PathKind[];
  readonly cost: number;
}

/**
 * A persistent D* Lite searcher rooted at a fixed goal cell. Build once per leg; then each tick:
 *   - setStart(feet)         — the agent moved; O(small) re-key, usually a no-op while on the tree.
 *   - notifyChanges(r,cells) — cells the executor mutated (mine/place) changed; repair locally.
 *   - extractPath()          — the current optimal path start→goal (or null if unreachable).
 * The reader is the world snapshot succ/pred read; pass a fresh live reader into notifyChanges so a
 * repair sees current blocks. Pure + jsMacros-free (BlockReader is plain data) → unit-testable.
 */
export class DStarLite {
  private reader: BlockReader;
  private readonly opts: PlannerOpts;
  private readonly cost: CostContext;
  private readonly goalK: string;
  private startK: string;
  private lastStartK: string; // s_last for the km accumulation
  private km = 0;

  private readonly g = new Map<string, number>();
  private readonly rhs = new Map<string, number>();
  private readonly cell = new Map<string, Vec3>();
  private readonly q = new DStarQueue();
  // predecessor cache, invalidated wholesale on a world change (epoch bump keeps it simple + correct)
  private predCache = new Map<string, string[]>();
  // Per-epoch neighbors() memo. neighbors(reader, cell, opts) is PURE and the world is fixed within an
  // epoch, but the COLD search hammers it: pred() runs neighbors() over a (2rH+1)²×(maxDrop+2) box for
  // every expanded vertex, and succ() re-runs it on every vertex update during the wavefront — the same
  // cells, thousands of times. Memoizing by cell collapses that to one compute per cell, the dominant
  // cold-start cost (each neighbors() is ~15 movement-type applies × several reader/classify lookups).
  // Invalidated wholesale alongside predCache on a world change (rare here — D* runs only on the
  // bounded non-mining move set, so notifyChanges fires from re-sense corrections, not active mining).
  private neighborCache = new Map<string, MoveResult[]>();

  /** Cap on computeShortestPath pops per repair — the search-bound analogue of A*'s maxExpansions. */
  private readonly maxPops: number;
  /** Anytime per-call expansion budget (≤ maxPops). See the constructor note. */
  private readonly budget: number;

  constructor(
    reader: BlockReader,
    start: Vec3,
    goalCell: Vec3,
    opts: PlannerOpts,
    cost: CostContext = DEFAULT_COST,
    budget?: number,
  ) {
    if (!engageable(opts)) {
      throw new Error(
        "DStarLite: opts enable an unbounded-reach move (bridge/pillar/mine/waterDrop)",
      );
    }
    this.reader = reader;
    this.opts = opts;
    this.cost = cost;
    this.maxPops = opts.maxExpansions;
    // Anytime budget: the MAX vertex expansions any one computeShortestPath() call runs before it
    // yields back (so the caller can act on a partial tree and resume next tick). Omitted → maxPops,
    // i.e. run the search to completion in one call — the original synchronous behaviour the offline
    // optimality tests assert. A small budget time-slices the cold search across ticks so the bot
    // walks a best-effort step (bestEffortStep) WHILE the wavefront reaches it.
    this.budget = budget ?? this.maxPops;

    this.goalK = encodePos(goalCell.x, goalCell.y, goalCell.z);
    this.startK = encodePos(start.x, start.y, start.z);
    this.lastStartK = this.startK;
    this.cell.set(this.goalK, { ...goalCell });
    this.cell.set(this.startK, { ...start });

    this.rhs.set(this.goalK, 0);
    this.q.set(this.goalK, ...this.calcKey(this.goalK));
    this.computeShortestPath();
  }

  private gOf(k: string): number {
    return this.g.get(k) ?? INF;
  }
  private rhsOf(k: string): number {
    return this.rhs.get(k) ?? INF;
  }
  private cellOf(k: string): Vec3 {
    const c = this.cell.get(k);
    if (c) return c;
    // every key we ever queue/relax is registered in `cell` first; a miss is a logic error.
    throw new Error(`DStarLite: no cell for key ${k}`);
  }

  private startCell(): Vec3 {
    return this.cellOf(this.startK);
  }

  /** Memoized neighbors() — one forward expansion per cell per epoch (see neighborCache). The cached
   *  array is read-only to callers (succ/pred never mutate it), so sharing the reference is safe. */
  private nbrs(cell: Vec3): MoveResult[] {
    const k = encodePos(cell.x, cell.y, cell.z);
    let cached = this.neighborCache.get(k);
    if (!cached) {
      cached = neighbors(this.reader, cell, this.opts);
      this.neighborCache.set(k, cached);
    }
    return cached;
  }

  private calcKey(k: string): [number, number] {
    const m = Math.min(this.gOf(k), this.rhsOf(k));
    const h = m === INF ? INF : m + cellHeuristic(this.startCell(), this.cellOf(k)) + this.km;
    return [h, m];
  }

  /** Forward edges out of `k` (the SSOT graph), each with its domain-overlaid cost. Registers
   *  every destination cell so calcKey/relaxation can resolve it. */
  private succ(k: string): Array<{ to: string; cost: number; kind: MoveKind }> {
    const from = this.cellOf(k);
    const out: Array<{ to: string; cost: number; kind: MoveKind }> = [];
    for (const move of this.nbrs(from)) {
      const tk = encodePos(move.to.x, move.to.y, move.to.z);
      if (!this.cell.has(tk)) this.cell.set(tk, move.to);
      out.push({ to: tk, cost: this.cost.edgeCost(from, move), kind: move.kind });
    }
    return out;
  }

  /** Cells with an edge INTO `k`, by reverse-enumeration over `neighbors()` within the bounded
   *  reach of the active move set (correct-by-construction: a predecessor is exactly a cell whose
   *  forward expansion lands on `k`). Memoized per world epoch. */
  private pred(k: string): string[] {
    const cached = this.predCache.get(k);
    if (cached) return cached;
    const v = this.cellOf(k);
    const rH = this.predReachXZ();
    const yLo = v.y - 1; // a stepUp predecessor sits one below
    const yHi = v.y + this.opts.maxDrop; // a drop predecessor sits up to maxDrop above
    const found: string[] = [];
    for (let dx = -rH; dx <= rH; dx++) {
      for (let dz = -rH; dz <= rH; dz++) {
        for (let y = yLo; y <= yHi; y++) {
          if (dx === 0 && dz === 0 && y === v.y) continue; // not its own predecessor
          const u = { x: v.x + dx, y, z: v.z + dz };
          if (!this.hasEdgeInto(u, v)) continue;
          const uk = encodePos(u.x, u.y, u.z);
          if (!this.cell.has(uk)) this.cell.set(uk, u);
          found.push(uk);
        }
      }
    }
    this.predCache.set(k, found);
    return found;
  }

  /** The HORIZONTAL half-width of the predecessor-enumeration box: how many cells away a forward move
   *  can originate. Parkour reaches `maxParkour` cells; the bounded walk/step/drop/diagonal set reaches
   *  1. The SSOT for that reach — notifyChanges' dirty box must mirror it (a mismatch there was the
   *  quarantined incremental-repair bug), so both read it from here rather than re-deriving it. */
  private predReachXZ(): number {
    return Math.max(1, this.opts.parkour ? (this.opts.maxParkour ?? 4) : 1);
  }

  /** Does `u`'s forward expansion land exactly on `v` — i.e. is `u` a predecessor of `v`? This IS the
   *  reverse-edge test (correct-by-construction against the SSOT `neighbors()`), kept separate from
   *  pred()'s box scan so the scan reads as pure enumeration. */
  private hasEdgeInto(u: Vec3, v: Vec3): boolean {
    for (const move of this.nbrs(u)) {
      if (move.to.x === v.x && move.to.y === v.y && move.to.z === v.z) return true;
    }
    return false;
  }

  /** Can a body occupy `k` as a path WAYPOINT in the current world — i.e. is it a valid standing/
   *  climbing cell? A vertex that isn't (a cell an edit BURIED under a raised column, say) can never
   *  relay a path, so its rhs must be INF regardless of what outgoing edges `succ` still enumerates.
   *  The INITIAL search never needs this (every non-start/goal vertex it reaches was emitted by
   *  `neighbors()` as a move target, hence already occupiable) — it exists only so an incremental
   *  repair can PURGE a vertex the world just invalidated. Exemptions:
   *   - the START: the agent is already standing there, so it's a valid path root even mid-air / buried
   *     (planPath likewise treats `start` as occupiable without a walkability test) — guarding it
   *     unconditionally is exactly what regressed start edits in an earlier attempt;
   *   - the GOAL: handled by the `k !== goalK` branch in updateVertex (rhs(goal) is pinned at 0).
   *  Includes climbable (ladder/vine) cells so a repair can't wrongly kill a valid ladder vertex. */
  private occupiable(k: string): boolean {
    if (k === this.startK) return true;
    const c = this.cellOf(k);
    return walkableAt(this.reader, c) || climbableAt(this.reader, c);
  }

  private updateVertex(k: string): void {
    if (k !== this.goalK) {
      let best = INF;
      // A cell you cannot stand on can't be a waypoint — leave its rhs at INF so a world edit that
      // buries it propagates the severed route instead of keeping a phantom finite cost (via its
      // still-enumerable outgoing edges) that stalls the increase-wave. No-op on the initial search.
      if (this.occupiable(k)) {
        for (const e of this.succ(k)) {
          const v = e.cost + this.gOf(e.to);
          if (v < best) best = v;
        }
      }
      this.rhs.set(k, best);
    }
    this.q.remove(k);
    if (this.gOf(k) !== this.rhsOf(k)) this.q.set(k, ...this.calcKey(k));
  }

  private computeShortestPath(): void {
    let pops = 0;
    // Stop after `budget` expansions even if the start isn't settled yet — the caller resumes us next
    // tick (anytime). budget defaults to maxPops, so the un-budgeted case runs to completion as before.
    while (pops++ < this.budget) {
      if (this.converged()) break;
      const top = this.q.topKey();
      if (!top) break;
      const k = this.q.topCell();
      if (k === undefined) break;
      this.expandTop(k, top);
    }
  }

  /** The D* Lite termination test: the start is locally consistent AND nothing queued can lower it.
   *  When true the search has produced the optimal start→goal cost (or proved it unreachable, with an
   *  empty/exhausted queue). Used to tell "still computing, keep walking" from "genuinely blocked". */
  converged(): boolean {
    const top = this.q.topKey();
    if (!top) return true; // queue drained → fully settled
    const startKey = this.calcKey(this.startK);
    const consistentStart = this.gOf(this.startK) === this.rhsOf(this.startK);
    return !keyLessTol(top[0], top[1], startKey[0], startKey[1]) && consistentStart;
  }

  /** Process the queue's current top vertex `k` (whose live key was `top`) — the body of the D* Lite
   *  loop: re-key a stale entry, settle an overconsistent vertex, or invalidate an underconsistent one. */
  private expandTop(k: string, top: readonly [number, number]): void {
    const kNew = this.calcKey(k);
    if (keyLess(top[0], top[1], kNew[0], kNew[1])) {
      // out-of-date key (km moved it) — re-insert at the corrected key
      this.q.set(k, kNew[0], kNew[1]);
    } else if (this.gOf(k) > this.rhsOf(k)) {
      // overconsistent: accept the better rhs, propagate to predecessors
      this.g.set(k, this.rhsOf(k));
      this.q.remove(k);
      for (const p of this.pred(k)) this.updateVertex(p);
    } else {
      // underconsistent: cost rose — invalidate and re-evaluate this vertex + its predecessors
      this.g.set(k, INF);
      this.updateVertex(k);
      for (const p of this.pred(k)) this.updateVertex(p);
    }
  }

  /** The agent moved to `next`. Accumulate the heuristic drift into km (so queued keys stay valid
   *  without a full re-key) and repair. Cheap while `next` is on the optimal tree (no pops). */
  setStart(next: Vec3): void {
    const nk = encodePos(next.x, next.y, next.z);
    if (nk === this.startK) return;
    if (!this.cell.has(nk)) this.cell.set(nk, { ...next });
    this.km += cellHeuristic(this.cellOf(this.lastStartK), next);
    this.lastStartK = nk;
    this.startK = nk;
    this.computeShortestPath();
  }

  /** Cells whose block changed (the executor mined/placed, or a re-sense corrected the world).
   *  Re-read the affected region against `reader` and repair. Bounded by the change count. */
  notifyChanges(reader: BlockReader, changed: Vec3[]): void {
    if (changed.length === 0) return;
    this.reader = reader;
    this.predCache = new Map(); // succ-sets near the change shift → drop the reverse-edge cache
    this.neighborCache = new Map(); // the world moved → the memoized forward expansions are stale
    // Dirty region: every vertex whose neighbors() output could reference a changed cell — i.e.
    // every vertex that can have an edge into/near the change. This MUST mirror pred()'s
    // enumeration reach, and getting it wrong was the quarantined incremental-repair bug:
    //   - horizontal ±1 missed PARKOUR predecessors (reach up to rH=maxParkour cells away), so a
    //     jump edge into a raised/buried stand cell kept its stale rhs → phantom route;
    //   - vertical c.y-maxDrop..c.y+2 extended DOWN, but drop-move PREDECESSORS sit up to maxDrop
    //     ABOVE their landing (pred() scans yHi = v.y + maxDrop) → lowering a column never
    //     propagated the new cheaper drop edge → repair missed the improvement.
    // Box: ±(rH+1) horizontally; vertically from c.y-3 (a vertex one BELOW reads c as its head
    // clearance, ±margin) up to c.y + maxDrop + 2 (a drop predecessor above the changed stand
    // level, +head margin). Superset-conservative: an extra updateVertex is a cheap no-op.
    const rH = this.predReachXZ() + 1;
    const dirty = new Set<string>();
    for (const c of changed) {
      for (let dx = -rH; dx <= rH; dx++) {
        for (let dz = -rH; dz <= rH; dz++) {
          for (let y = c.y - 3; y <= c.y + this.opts.maxDrop + 2; y++) {
            const u = { x: c.x + dx, y, z: c.z + dz };
            const uk = encodePos(u.x, u.y, u.z);
            if (!this.cell.has(uk)) this.cell.set(uk, u);
            dirty.add(uk);
          }
        }
      }
    }
    for (const uk of dirty) this.updateVertex(uk);
    this.computeShortestPath();
  }

  /** Is the goal currently reachable from the start? */
  reachable(): boolean {
    return this.gOf(this.startK) !== INF;
  }

  /** A reactive one-step fallback toward the goal for the ticks BEFORE the backward wavefront has
   *  reached the start (anytime mode, g(start)=INF). Picks the cheapest immediate successor that most
   *  reduces the straight-line (octile-horizontal) distance to the goal — i.e. walk roughly the right
   *  way while the optimal tree finishes. The executor's live step-hazard veto still guards it; once
   *  g(start) becomes finite, extractPath() takes over with the real (improving) path. Null if boxed
   *  in (no walkable successor) — the caller then holds. */
  bestEffortStep(): Vec3 | null {
    const from = this.startCell();
    const goal = this.cellOf(this.goalK);
    let best: Vec3 | null = null;
    let bestVal = INF;
    for (const move of neighbors(this.reader, from, this.opts)) {
      const val = this.cost.edgeCost(from, move) + cellHeuristic(move.to, goal);
      if (val < bestVal) {
        bestVal = val;
        best = move.to;
      }
    }
    return best;
  }

  /** The current optimal path start→goal by greedy g-descent (the standard D* Lite extraction), or
   *  null if the goal is unreachable / the descent stalls. Length-bounded against a cost-tie cycle. */
  extractPath(): DStarPath | null {
    if (!this.reachable()) return null;
    const path: Vec3[] = [this.startCell()];
    const kinds: PathKind[] = ["start"];
    let cur = this.startK;
    let total = 0;
    let guard = 0;
    while (cur !== this.goalK && guard++ < this.maxPops) {
      let best: { to: string; cost: number; kind: MoveKind } | null = null;
      let bestVal = INF;
      for (const e of this.succ(cur)) {
        const val = e.cost + this.gOf(e.to);
        if (val < bestVal) {
          bestVal = val;
          best = e;
        }
      }
      if (!best || bestVal === INF) return null; // stalled — no descending successor
      total += best.cost;
      path.push(this.cellOf(best.to));
      kinds.push(best.kind); // the g-descent edge that reached this cell = its policy
      cur = best.to;
    }
    if (cur !== this.goalK) return null;
    return { path, kinds, cost: total };
  }
}

/** Build a D* Lite searcher whose goal is the cell `goalCell`. The arrival SEMANTICS still live in
 *  the executor's `Goal` (radius/column) — D* Lite roots at a concrete cell and the executor stops
 *  early when its Goal.isInGoal fires along the path. Returns null if the move set is unbounded. */
export function dstarFor(
  reader: BlockReader,
  start: Vec3,
  goalCell: Vec3,
  opts: PlannerOpts,
  cost: CostContext = DEFAULT_COST,
  _goal?: Goal,
  budget?: number,
): DStarLite | null {
  if (!engageable(opts)) return null;
  return new DStarLite(reader, start, goalCell, opts, cost, budget);
}
