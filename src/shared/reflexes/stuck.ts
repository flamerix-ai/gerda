// stuck reflex — wires cfg.safety.stuckTicksThreshold (declared but never used by the old
// bot). Only meaningful while the active mission is driving movement (Baritone): if
// the player position hasn't changed for cfg.safety.stuckTicksThreshold ticks in a movement
// phase, the path is wedged — #stop and bail to RECOVER. Outside movement phases the
// bot is legitimately stationary (mining/scanning), so the timer resets.
import { dist } from "@/core/prim/pos";
import type { Vec3 } from "@/core/runtime/types";
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { LIFECYCLE, REFLEX_SETTLED } from "@/shared/kernel/phase";
import { PLAYER } from "@/shared/kernel/resource";
import { defineSlice } from "@/shared/kernel/slice";
import {
  type WindowCounter,
  bump,
  freshCounter,
  resetCounter,
} from "@/shared/reflexes/window-counter";

interface StuckMem {
  last: Vec3 | null;
  still: WindowCounter;
}
const STUCK_SLICE = defineSlice<StuckMem>("stuck", () => ({ last: null, still: freshCounter() }));

export const stuck: Capability = {
  name: "stuck",
  requires: [PLAYER],

  guard(ctx: Ctx): boolean {
    const { cfg, st } = ctx;
    const mem = ctx.slice(STUCK_SLICE);

    // Only a phase that is actively DRIVING movement can be "stuck". A movement phase that has
    // deliberately released its keys to hold position — e.g. a follower waiting on a stationary
    // leader (FOLLOW_HOLD) — is legitimately still, not wedged; counting it would teleport-RECOVER
    // a bot that is doing exactly the right thing. Gate on a held movement key.
    if (REFLEX_SETTLED.has(st.phase) || !ctx.isMovementPhase() || !ctx.rt.keys.movementHeld()) {
      mem.last = null;
      resetCounter(mem.still);
      return false;
    }

    const pos = ctx.res(PLAYER).pos;
    // "still" = we had a prior sample and barely moved from it. bump() counts consecutive still
    // ticks and reports the fire once the run reaches the threshold.
    const still = mem.last !== null && dist(mem.last, pos) < cfg.safety.stuckMovedEpsilon;
    mem.last = pos;

    if (bump(mem.still, still, cfg.safety.stuckTicksThreshold)) {
      mem.last = null;
      ctx.bus.emit("stuck", { phase: st.phase, ticks: cfg.safety.stuckTicksThreshold });
      ctx.divert(LIFECYCLE.RECOVER, "stuck_no_progress");
      return true;
    }
    return false;
  },
};
