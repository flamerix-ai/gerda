import type { Mob } from "@/core/runtime/Runtime";
// hunt domain — the hunt mission's SELECTION policy (which mob to chase). The generic pursuit
// primitives (re-find by uuid, reach gate, approach cell) live in domain/pursuit.ts, shared with
// follow; this keeps only what's specific to hunting: the huntable whitelist + live-target pick.
import { minBy } from "@/shared/domain/select";

/** Is this entity type one we're allowed to hunt? Exact id match against the whitelist
 *  (e.g. "minecraft:cow"). Keeping it a set means the config drives the policy, not code. */
export function isHuntable(type: string, huntable: ReadonlySet<string>): boolean {
  return huntable.has(type);
}

/** Pick the nearest huntable mob from a snapshot (already distance-sorted by the facade,
 *  but we re-min here so the function is correct on any input order). null = nothing to hunt. */
export function pickTarget(mobs: readonly Mob[], huntable: ReadonlySet<string>): Mob | null {
  const live = mobs.filter((m) => isHuntable(m.type, huntable) && m.health > 0);
  return minBy(live, (m) => m.distance);
}
