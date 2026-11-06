// dig-nav — pure planner for "mine your way to a target stand cell" (3D vein-chase). Greedy nav
// only walks/jumps through ALREADY-open space; this computes the next feet cell to advance toward
// a target plus the blocks to clear so greedy can step into it — turning the bot into a
// staircase/tunnel digger that reaches offset/above ore inside a solid-rock vein.
//
// Division of labour: this planner is geometric only (no block reads). It returns the next cell +
// the cells that must be AIR for the bot to occupy/jump into it; the DIG_TO capability reads the
// live world, breaks whichever of those are solid, then lets greedyStep walk/jump into `next`
// (greedy's own step-up climbs the tread). Pure + jsMacros-free → unit-tested.
import type { Vec3 } from "@/core/runtime/types";

export interface DigStep {
  /** The cell the bot should move its feet into next (one step toward the target). */
  readonly next: Vec3;
  /** Cells that must be air for the bot to occupy / jump into `next` (break the solid ones). */
  readonly clear: readonly Vec3[];
  /** `next` is +1 in Y — greedy will jump onto the tread (the solid block under `next`). */
  readonly ascend: boolean;
}

/** "arrived" → feet already at the target. "needPillar" → the target is straight up with no
 *  horizontal offset, which a digger can't reach without placing filler (the caller skips it). */
export type DigPlan = DigStep | "arrived" | "needPillar";

const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

/** One greedy step (in mining terms) from `feet` toward `target`: advance along the dominant
 *  horizontal axis, climbing/descending one Y per step (a staircase). */
export function planDigStep(feet: Vec3, target: Vec3): DigPlan {
  const dx = target.x - feet.x;
  const dy = target.y - feet.y;
  const dz = target.z - feet.z;
  if (dx === 0 && dy === 0 && dz === 0) return "arrived";

  // Pick the horizontal step: the larger-|delta| axis (ties → X). Only one axis moves per step
  // so the shaft/staircase stays a clean 1-wide line greedy can follow.
  let hx = 0;
  let hz = 0;
  if (Math.abs(dx) >= Math.abs(dz)) {
    if (dx !== 0) hx = sign(dx);
    else hz = sign(dz);
  } else {
    hz = sign(dz);
  }
  const vy = sign(dy);

  if (hx === 0 && hz === 0) {
    // Directly above/below the target column.
    if (vy > 0) return "needPillar"; // straight up needs filler blocks — not a dig move
    const next = { x: feet.x, y: feet.y - 1, z: feet.z };
    return { next, clear: [next], ascend: false }; // straight down: break the floor, drop in
  }

  const next = { x: feet.x + hx, y: feet.y + vy, z: feet.z + hz };
  const head = { x: next.x, y: next.y + 1, z: next.z };
  const clear: Vec3[] = [next, head];
  if (vy > 0) {
    // Jumping up onto the tread (feet+horizontal): also clear the headroom above the current
    // stand so the bot can rise. The tread itself (next.y-1) is deliberately NOT cleared — it's
    // the solid block greedy's step-up lands on.
    clear.push({ x: feet.x, y: feet.y + 2, z: feet.z });
  }
  return { next, clear, ascend: vy > 0 };
}
