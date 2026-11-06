// hunger reflex — food awareness. Unlike the life-threat reflexes it does NOT divert
// (eating mid-mission and resuming is the maintenance tier's job, #15); it is the
// SENSOR half: when food drops to/under cfg.safety.lowFoodLevel it emits `lowFood` so a
// maintenance EAT interrupt can react. Emits only on the DOWNWARD crossing (tracked in
// a slice), not every tick, so the bus isn't spammed while the bar sits low. Always
// returns false — it never preempts a mission on its own.
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { REFLEX_SETTLED } from "@/shared/kernel/phase";
import { BODY } from "@/shared/kernel/resource";
import { defineSlice } from "@/shared/kernel/slice";

interface HungerMem {
  // whether we've already announced the current low-food episode (reset when food recovers)
  announced: boolean;
}
const HUNGER_SLICE = defineSlice<HungerMem>("hunger", () => ({ announced: false }));

export const hunger: Capability = {
  name: "hunger",
  requires: [BODY],

  guard(ctx: Ctx): boolean {
    const { cfg, st } = ctx;
    if (REFLEX_SETTLED.has(st.phase)) return false;
    const mem = ctx.slice(HUNGER_SLICE);
    const { food } = ctx.res(BODY);

    if (food > cfg.safety.lowFoodLevel) {
      mem.announced = false; // recovered (ate, or this episode ended) → re-arm
      return false;
    }
    if (!mem.announced) {
      mem.announced = true;
      ctx.bus.emit("lowFood", { food, phase: st.phase });
    }
    return false;
  },
};
