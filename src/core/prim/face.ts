// Face geometry — the vanilla "place against a face" offset table + its inverse, shared by the
// mock runtime (where a placed block lands) and the placement planners (which pick a support
// block + face so a new block lands at a chosen cell). A block placed against `face` of `against`
// lands at `against + FACE_OFFSET[face]` (Minecraft right-click-with-block semantics). Pure data.
import type { Face, Vec3 } from "@/core/runtime/types";

/** Where a block lands when placed against a face (vanilla semantics: against + offset). */
export const FACE_OFFSET: Record<Face, Vec3> = {
  TOP: { x: 0, y: 1, z: 0 },
  BOTTOM: { x: 0, y: -1, z: 0 },
  NORTH: { x: 0, y: 0, z: -1 },
  SOUTH: { x: 0, y: 0, z: 1 },
  EAST: { x: 1, y: 0, z: 0 },
  WEST: { x: -1, y: 0, z: 0 },
  CENTER: { x: 0, y: 0, z: 0 },
};

/** The face whose placement offset equals the unit step `(dx,dy,dz)`, or null when the step is
 *  not a single ±1 axis move. Used to place a block at `support + (dx,dy,dz)`: pick the face of
 *  `support` pointing that way so the new block lands in the intended cell. */
export function offsetToFace(dx: number, dy: number, dz: number): Face | null {
  if (dx === 0 && dy === 1 && dz === 0) return "TOP";
  if (dx === 0 && dy === -1 && dz === 0) return "BOTTOM";
  if (dx === 0 && dy === 0 && dz === -1) return "NORTH";
  if (dx === 0 && dy === 0 && dz === 1) return "SOUTH";
  if (dx === 1 && dy === 0 && dz === 0) return "EAST";
  if (dx === -1 && dy === 0 && dz === 0) return "WEST";
  return null;
}
