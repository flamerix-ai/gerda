// Fleet assignment geometry — pure predicate over the XZ regions the coordinator hub pushes
// down. The mine scan calls inAssignment() to drop ore outside this bot's region
// or inside a peer's claim, so two bots in one world never path to the same vein. jsMacros-free.
import type { Box, FleetAssignment } from "@/core/runtime/types";

function inBox(x: number, z: number, b: Box): boolean {
  return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
}

/** True when (x,z) is mineable under `a`: inside `allowed` (or `allowed` is null = whole world)
 *  AND not inside any forbidden region. A *null* assignment (no assignment at all) is the
 *  caller's concern — it means "mine anywhere" and should skip this check entirely. */
export function inAssignment(x: number, z: number, a: FleetAssignment): boolean {
  if (a.allowed !== null && !inBox(x, z, a.allowed)) return false;
  for (const f of a.forbidden) {
    if (inBox(x, z, f)) return false;
  }
  return true;
}
