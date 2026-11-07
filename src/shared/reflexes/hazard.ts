import type { Vec3 } from "@/core/runtime/types";
// hazard reflex — environmental kill-zones. Bails to RECOVER when the bot is in
// immediate danger that health-watching would catch too late:
//   - void: feet below cfg.safety.voidY (fell off the world)
//   - lava/fire: the feet or the block just below match a cfg.safety.hazardSubstrings id
// Reads the world via the existing facade at floored coords (aligned with
// World.getBlock). Cheap enough to run every tick.
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { LIFECYCLE, REFLEX_SETTLED } from "@/shared/kernel/phase";
import { PLAYER } from "@/shared/kernel/resource";

function isHazardId(id: string, subs: readonly string[]): boolean {
  return subs.some((s) => id.includes(s));
}

export const hazard: Capability = {
  name: "hazard",
  requires: [PLAYER],

  guard(ctx: Ctx): boolean {
    const { rt, cfg, st } = ctx;
    if (REFLEX_SETTLED.has(st.phase)) return false;

    const p = ctx.res(PLAYER).pos;

    if (p.y < cfg.safety.voidY) {
      ctx.divert(LIFECYCLE.RECOVER, "void_fall");
      return true;
    }

    const feet: Vec3 = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    const below: Vec3 = { x: feet.x, y: feet.y - 1, z: feet.z };
    const feetR = rt.world.blockId(feet);
    const belowR = rt.world.blockId(below);
    // Only a CONFIRMED hazard id trips RECOVER — an unreadable block is not assumed safe
    // OR dangerous, just skipped (the void-Y check above already catches falling).
    if (
      (feetR.ok && isHazardId(feetR.value, cfg.safety.hazardSubstrings)) ||
      (belowR.ok && isHazardId(belowR.value, cfg.safety.hazardSubstrings))
    ) {
      ctx.divert(LIFECYCLE.RECOVER, "hazard_block");
      return true;
    }
    return false;
  },
};
