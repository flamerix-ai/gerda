// air reflex — the drowning fix. The legacy bot only reacted at health<6, far too
// late underwater (it drowned). This fires on the REAL breath meter (player.air /
// maxAir), before any HP damage: once the remaining-air fraction drops to/under
// cfg.safety.airRecoverPct, bail to RECOVER. Reading the meter (not the old "eye block id
// contains water" heuristic) is strictly more honest — it catches every air-loss
// source, not just standing in water, and respects water-breathing (conduit power /
// aqua-affinity / potion), which the block sniff could never know about.
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { LIFECYCLE } from "@/shared/kernel/phase";
import { BODY } from "@/shared/kernel/resource";

export const air: Capability = {
  name: "air",
  survival: true, // drowning kills an IDLE bot too — must run with no mission active
  requires: [BODY],

  guard(ctx: Ctx): boolean {
    const { cfg, st } = ctx;
    // Drowning is a TERMINAL threat, so — unlike the other reflexes — this fires even in the
    // settled PAUSED/ERROR phases: a bot parked in water (errored after a water-clutch, or paused
    // by a human while submerged) must still bail before it drowns. Skip only RECOVER, where the
    // teleport-out is already in flight (and itself escapes the water).
    if (st.phase === LIFECYCLE.RECOVER) return false;
    const body = ctx.res(BODY);

    // Can breathe underwater → drowning is impossible; never trip.
    if (body.canBreatheWater) return false;
    // Guard the divisor: a non-positive max means the meter isn't meaningful → skip.
    if (body.maxAir <= 0) return false;

    if (body.air / body.maxAir <= cfg.safety.airRecoverPct) {
      ctx.bus.emit("lowAir", { air: body.air, maxAir: body.maxAir, phase: st.phase });
      ctx.divert(LIFECYCLE.RECOVER, `low_air_${body.air}`);
      return true;
    }
    return false;
  },
};
