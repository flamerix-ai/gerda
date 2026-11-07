import type { Runtime } from "@/core/runtime/Runtime";
import type { Vec3 } from "@/core/runtime/types";
// — Ladder executor ————————————————————————————————————————————————————————————————————————————
// Climbing an EXISTING ladder/vine is the clean, non-destructive way to change level (vs pillaring
// up or mining down) — the planner offers it only where a climbable block already exists. Unlike the
// pillar's jump-place machine this is STATELESS: vanilla climbs you while you press INTO the ladder's
// backing wall, so each tick we just face that wall and hold forward (+ jump to ascend). The outer
// greedyStep re-plans from the new cell next tick and re-enters until the column ends, where a plain
// stepUp/traverse dismounts onto the adjacent floor. No teardown needed (greedyRelease clears the keys).
import { type BlockReader, isFullSolid } from "@/shared/domain/senses";
import { type GreedyStep, clearSprint, liveReader, mustSetYaw } from "@/shared/nav/core";

const CARDINALS_NAV: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** The wall a ladder/vine at `cell` backs onto, as a unit cardinal (dx,dz) — the player climbs by
 *  pressing INTO it. Scans the 4 cardinal neighbours for the first full-solid block; null when none is
 *  found (a free-standing vine / unloaded neighbour) → the caller keeps the current yaw. */
function ladderWall(reader: BlockReader, cell: Vec3): { dx: number; dz: number } | null {
  for (const [dx, dz] of CARDINALS_NAV) {
    const id = reader(cell.x + dx, cell.y, cell.z);
    if (id !== null && isFullSolid(id)) return { dx, dz };
  }
  return null;
}

/** Drive ONE tick of riding a ladder toward `next` (straight up or down, same column). Aims at the
 *  column CENTRE projected DEEP into the backing wall, then holds forward: vanilla climbs you while
 *  pressing into a ladder, and aiming at the centre also drifts the 0.6-wide box onto the column axis
 *  — so it doesn't clip a block flanking a constricted top (the city's terracotta-boxed ladder exits,
 *  where an edge-clinging climb stalled live at the cap) and can rise past it. Jump only when ascending
 *  (it reinforces the climb; a descent is forward-hold + gravity). Always "moving" — a stuck climb is
 *  caught by the navigation capability's per-leg timeout (escalate), not aborted mid-rung by a read. */
export function ladderStep(rt: Runtime, feet: Vec3, next: Vec3): GreedyStep {
  const up = next.y > feet.y;
  const live = liveReader(rt);
  const posR = rt.player.pos();
  const wall = ladderWall(live, next) ?? ladderWall(live, feet);
  if (wall && posR.ok) {
    // Centre on the axis ⊥ to the wall (next.*+0.5), push 2 blocks INTO the wall on the facing axis so
    // forward keeps pressing the ladder while the perpendicular component recentres the box.
    const aimX = next.x + 0.5 + wall.dx * 2;
    const aimZ = next.z + 0.5 + wall.dz * 2;
    const yaw = Math.atan2(-(aimX - posR.value.x), aimZ - posR.value.z) * (180 / Math.PI);
    mustSetYaw(rt, yaw); // a failed turn ends the drive before forward is pressed
  }
  rt.keys.set("key.forward", true);
  rt.keys.set("key.jump", up);
  rt.keys.set("key.sprint", false);
  clearSprint(rt); // a ladder climb never sprints; drop the flag without churning the attribute map
  return "moving";
}
