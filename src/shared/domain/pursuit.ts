// pursuit domain — the shared primitives for any mission that CHASES a moving entity (hunt a mob,
// follow a peer). jsMacros-free: operates on the snapshot (data) the facade produced. hunt.ts and
// follow.ts had byte-identical copies of these (rangeTo≡dist, findByUuid/findPeerByUuid, chaseCell/
// followCell≡floorVec, inReach/withinGap≡dist≤r) — this is the one home. Each mission
// keeps only its own SELECTION predicate (target whitelist / peer name-match).
import { dist, floorVec } from "@/core/prim/pos";
import type { Vec3 } from "@/core/runtime/types";

/** A pursuable entity — a positioned record with a stable uuid (to re-find it as it moves) and the
 *  facade-computed distance (nearest-first ordering). Mob and Peer both satisfy this. */
export interface Pursuable extends Vec3 {
  readonly uuid: string;
  readonly distance: number;
}

/** Re-find a locked target by uuid in a fresh snapshot (it moves every tick). null = it left the
 *  snapshot — killed / fled / logged off. The chase loop's "lost target" signal. */
export function byUuid<T extends { uuid: string }>(list: readonly T[], uuid: string): T | null {
  for (const e of list) if (e.uuid === uuid) return e;
  return null;
}

/** Is `target` within `range` blocks of `self` (3-D)? The strike/hold gate — reach for a melee
 *  swing, the follow gap for holding position. */
export function withinRange(self: Vec3, target: Vec3, range: number): boolean {
  return dist(self, target) <= range;
}

/** The floor cell to navigate toward when pursuing — the target's block column (its feet cell). The
 *  navigator walks here with arrivalRadius = reach/gap, so we stop a step short rather than trying
 *  to occupy the target's space (a mob/peer y is its feet; flooring gives the standable target). */
export function approachCell(target: Vec3): Vec3 {
  return floorVec(target);
}
