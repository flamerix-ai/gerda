import { must } from "@/core/prim/invariant";
// Pure: where do I stand to break this block? Ported from
// harness/solve_mining_target.js (behavior-identical), now typed.
import { dist } from "@/core/prim/pos";
import type { BreakFaceHint, Face, StandSolution, Vec3 } from "@/core/runtime/types";
import { type BlockReader, walkableAt } from "@/shared/domain/senses";

const SAME_POS_EPSILON = 0.5;

interface Neighbor extends Vec3 {
  readonly face: Face;
}

/** The same-level side neighbors of a target, nearest-first label set (x+1 ⇒ look WEST, etc.). */
function sideNeighbors(target: Vec3): Neighbor[] {
  return [
    { x: target.x + 1, y: target.y, z: target.z, face: "WEST" },
    { x: target.x - 1, y: target.y, z: target.z, face: "EAST" },
    { x: target.x, y: target.y, z: target.z + 1, face: "NORTH" },
    { x: target.x, y: target.y, z: target.z - 1, face: "SOUTH" },
  ];
}

/** Nearest same-level side neighbor the bot can actually STAND on (walkable: clear feet+head, a
 *  standable block below) to break the target's side face — or null if none (an embedded ore with
 *  no open, floored side). World-aware → needs a reader. */
function standableSideStand(
  reader: BlockReader,
  target: Vec3,
  currentPos: Vec3 | null,
): StandSolution | null {
  let best: Neighbor | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const n of sideNeighbors(target)) {
    if (!walkableAt(reader, n)) continue; // must be a real standable spot, not air or a wall
    const score = currentPos ? dist(currentPos, n) : 0;
    if (score < bestScore) {
      bestScore = score;
      best = n;
    }
  }
  if (!best) return null;
  return {
    standPos: { x: best.x, y: best.y, z: best.z },
    face: best.face,
    sameStandPos: currentPos ? bestScore < SAME_POS_EPSILON : false,
  };
}

export function solveMiningTarget(
  target: Vec3,
  strategy: { aoeDepth: number; breakTargetFace: BreakFaceHint },
  currentPos: Vec3 | null,
  reader?: BlockReader,
): StandSolution {
  // TOP hint: stand directly above the target and break its top face (flat AOE) — the right
  // approach when drilling DOWN (the target is at or below us) or when we don't know where we are.
  // But if the target is ABOVE us, standing above it is higher still and usually unreachable
  // (through solid rock, or — for ore straight overhead — through the ore itself; that's what made
  // pillar-up stall). Instead stand TWO below it (feet at y−2, head at y−1, the ore one block above
  // the head) and break the bottom face looking up — the break routine now lookAt's the target, so
  // an upward break works. Two below, not one: standing one below would put the head INSIDE the
  // ore.
  if (strategy.breakTargetFace === "TOP") {
    // World-aware (when a reader is given): an EXPOSED ore — one with a standable, open same-level
    // neighbor — is broken from BESIDE it on stable ground, NOT by climbing on top of the very
    // block we break. Standing-on-top is fragile on a thin/exposed body (the exposed-slab gap): it
    // breaks, we fall, and we can't re-climb the shrinking platform → blocked_no_path. A side stand
    // keeps the floor under us. Embedded ore (no open floored side) falls through to TOP/BOTTOM.
    if (reader) {
      const side = standableSideStand(reader, target, currentPos);
      if (side) return side;
    }
    if (!currentPos || target.y <= currentPos.y) {
      const standAbove: Vec3 = { x: target.x, y: target.y + 1, z: target.z };
      const same = currentPos ? dist(currentPos, standAbove) < SAME_POS_EPSILON : false;
      return { standPos: standAbove, face: "TOP", sameStandPos: same };
    }
    const standBelow: Vec3 = { x: target.x, y: target.y - 2, z: target.z };
    return {
      standPos: standBelow,
      face: "BOTTOM",
      sameStandPos: dist(currentPos, standBelow) < SAME_POS_EPSILON,
    };
  }

  // SIDE/CENTER face: stand on the nearest adjacent block at the same Y.
  const neighbors = sideNeighbors(target);
  let best: Neighbor = must(neighbors[0], "sideNeighbors yields 4 cells");
  let bestScore = Number.POSITIVE_INFINITY;
  for (const n of neighbors) {
    const score = currentPos ? dist(currentPos, n) : Number.POSITIVE_INFINITY;
    if (score < bestScore) {
      bestScore = score;
      best = n;
    }
  }

  const sameStandPos = currentPos ? bestScore < SAME_POS_EPSILON : false;
  return { standPos: { x: best.x, y: best.y, z: best.z }, face: best.face, sameStandPos };
}
