// Goal — the navigator's target abstraction, modelled on the goal types of Baritone's pathfinder
// (GoalXZ, GoalBlock; see NOTICE). A Goal answers the ONLY two questions the planner and executor need, and
// nothing else:
//   - heuristic(p)  — admissible estimate (ticks) from feet cell p to the goal; orders the A*.
//   - isInGoal(p)   — arrival test; the planner's success condition and the executor's stop.
//
// This is the clean seam that replaces the ad-hoc trio we accreted — a single `Vec3 goal`, a fixed
// 3D-Euclidean heuristic, and arrival SEMANTICS bolted on as booleans threaded through greedyStep
// (`navMode`, `xzArrival`, `bestEffort`). Each semantics is now a Goal TYPE, so the planner and the
// greedy executor are goal-agnostic: they call heuristic()/isInGoal() and never branch on "is this
// an xz leg". The walk-to-vein wander was a heuristic bug — 3D Euclidean toward an UNKNOWN column Y
// (the drill guessed the bot's current Y) pulled the search uphill to a floating cell. GoalXZ fixes
// it at the root: Y is ignored in BOTH heuristic and arrival, exactly like Baritone's GoalXZ.
import { WALK_ONE_BLOCK_TICKS } from "@/core/prim/movement-physics";
import type { Vec3 } from "@/core/runtime/types";

// Octile (diagonal-aware) horizontal distance, in ticks — the standard octile heuristic for an
// 8-connected grid (Baritone's GoalXZ uses the same one): a path can step diagonally (√2 per
// block) or straight, so this is admissible AND tighter than a raw Euclidean×walk estimate.
export function octileXZ(dx: number, dz: number): number {
  const x = Math.abs(dx);
  const z = Math.abs(dz);
  return (Math.max(x, z) - Math.min(x, z) + Math.SQRT2 * Math.min(x, z)) * WALK_ONE_BLOCK_TICKS;
}

/** A vertical level cost (ticks) — Baritone GoalYLevel: climbing/falling Y is ~one walk per block. */
function levelY(dy: number): number {
  return Math.abs(dy) * WALK_ONE_BLOCK_TICKS;
}

export interface Goal {
  /** Admissible estimate (ticks) from cell/pos `p` to the goal — drives the A* priority. */
  heuristic(p: Vec3): number;
  /** Has `p` reached the goal? Planner success + executor stop test. Accepts a float position
   *  (the executor passes raw player pos) — cell-typed goals floor it; radius goals use it as-is. */
  isInGoal(p: Vec3): boolean;
  /** Stable identity for caching a plan to this goal (the incremental planner / future D* Lite key
   *  their cache on it, so a goal CHANGE forces a fresh search but the SAME goal reuses the path). */
  key(): string;
}

/** Reach an EXACT feet cell. Baritone GoalBlock = horizontal octile + vertical level, summed. */
export class GoalBlock implements Goal {
  constructor(private readonly t: Vec3) {}
  heuristic(p: Vec3): number {
    return octileXZ(p.x - this.t.x, p.z - this.t.z) + levelY(p.y - this.t.y);
  }
  isInGoal(p: Vec3): boolean {
    return (
      Math.floor(p.x) === this.t.x && Math.floor(p.y) === this.t.y && Math.floor(p.z) === this.t.z
    );
  }
  key(): string {
    return `block:${this.t.x},${this.t.y},${this.t.z}`;
  }
}

/** Reach an X/Z COLUMN at ANY height — Baritone GoalXZ. Y is ignored in heuristic AND arrival, so
 *  the search never chases an unknown/floating column Y (the cause of the walk-to-vein wander). The
 *  caller that owns Y (e.g. the drill's DESCEND) takes over once the column is reached. */
export class GoalXZ implements Goal {
  constructor(
    private readonly x: number,
    private readonly z: number,
  ) {}
  heuristic(p: Vec3): number {
    return octileXZ(p.x - this.x, p.z - this.z);
  }
  isInGoal(p: Vec3): boolean {
    return Math.floor(p.x) === this.x && Math.floor(p.z) === this.z;
  }
  key(): string {
    return `xz:${this.x},${this.z}`;
  }
}

/** Reach within `radius` blocks (3D) of a point — "good enough to act" arrivals (the old
 *  cfg.nav.gotoArrivalDist tolerance, now a goal type instead of a scalar threaded through the executor).
 *  Continuous: arrival is tested against the raw position, so a tight radius still lands precisely. */
export class GoalNear implements Goal {
  constructor(
    private readonly t: Vec3,
    private readonly radius: number,
  ) {}
  heuristic(p: Vec3): number {
    return octileXZ(p.x - this.t.x, p.z - this.t.z) + levelY(p.y - this.t.y);
  }
  isInGoal(p: Vec3): boolean {
    const dx = p.x - this.t.x;
    const dy = p.y - this.t.y;
    const dz = p.z - this.t.z;
    return dx * dx + dy * dy + dz * dz <= this.radius * this.radius;
  }
  key(): string {
    return `near:${this.t.x},${this.t.y},${this.t.z},${this.radius}`;
  }
}
