import { floorVec } from "@/core/prim/pos";
import type { Runtime } from "@/core/runtime/Runtime";
// swim-out reflex — the "get out of the water" half of the drowning fix (Layer 2). The air reflex
// is the TERMINAL escape: at critical breath it teleports home (RECOVER), aborting the leg. This is
// the gentler, earlier response: the instant the bot is SUBMERGED (feet + head both water = a drown
// trap) but breath is still fine, hold jump to float straight up to the surface IN PLACE, then hand
// the mission back — so a bot that slipped into a flooded ravine climbs out and keeps working instead
// of burning a home teleport. It's a pre-dispatch guard (like water-clutch), not an FSM divert: it
// manages the rise over a few ticks and returns control the moment the head clears water.
//
// Layering (see reflexes/index.ts order): air runs FIRST — if breath is already critical we want the
// guaranteed teleport-out, not more swimming. So swim-out only owns the tick while air is still OK.
// If a COVERED pocket won't let us surface within cfg.safety.swimOutMaxTicks, we give up and hand back, letting
// the air reflex (which keeps ticking) escalate to the teleport once breath runs low.
import { isWater } from "@/shared/domain/block-traits";
import { type BlockReader, submergesAt } from "@/shared/domain/senses";
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { REFLEX_SETTLED } from "@/shared/kernel/phase";
import { BODY, PLAYER } from "@/shared/kernel/resource";
import { defineSlice } from "@/shared/kernel/slice";

interface SwimMem {
  active: boolean;
  ticks: number; // total ticks submerged this run (informational, logged on exit)
  bestY: number; // highest feet.y reached this run — rising resets the stall counter
  stall: number; // consecutive ticks WITHOUT gaining height (give up past cfg.safety.swimOutMaxTicks)
}
const SWIM_SLICE = defineSlice<SwimMem>("swimOut", () => ({
  active: false,
  ticks: 0,
  bestY: Number.NEGATIVE_INFINITY,
  stall: 0,
}));

/** A senses BlockReader backed by the live world (err/unloaded → null, never "air"). */
const readerFrom =
  (rt: Runtime): BlockReader =>
  (x, y, z) => {
    const r = rt.world.blockId({ x, y, z });
    return r.ok ? r.value : null;
  };

/** Release the swim keys and clear the run. */
function endSwim(ctx: Ctx, mem: SwimMem, event: string, fields: Record<string, unknown>): void {
  ctx.rt.keys.set("key.jump", false);
  mem.active = false;
  mem.ticks = 0;
  mem.bestY = Number.NEGATIVE_INFINITY;
  mem.stall = 0;
  ctx.log.info(ctx.st.tickCount, event, fields);
}

export const swimOut: Capability = {
  name: "swimOut",
  survival: true, // an IDLE bot shoved into water must float out on its own
  requires: [PLAYER, BODY],

  guard(ctx: Ctx): boolean {
    const { rt, cfg, st } = ctx;
    if (!cfg.safety.swimOutEnabled) return false;
    if (REFLEX_SETTLED.has(st.phase)) return false;

    const body = ctx.res(BODY);
    if (body.canBreatheWater) return false; // never drowns → nothing to escape

    const mem = ctx.slice(SWIM_SLICE);
    const feet = floorVec(ctx.res(PLAYER).pos);
    const reader = readerFrom(rt);

    // Surfaced? head cell is clear of water (submergesAt false) → the drown trap is broken, hand back.
    if (!submergesAt(reader, feet)) {
      if (mem.active) endSwim(ctx, mem, "SWIM_OUT_DONE", { at: feet, ticks: mem.ticks });
      return false;
    }

    // Submerged. Start a run on the first tick.
    if (!mem.active) {
      mem.active = true;
      mem.ticks = 0;
      mem.bestY = feet.y;
      mem.stall = 0;
      ctx.bus.emit("submerged", { x: feet.x, y: feet.y, z: feet.z, air: body.air });
      ctx.log.info(st.tickCount, "SWIM_OUT_START", {
        at: feet,
        air: body.air,
        maxAir: body.maxAir,
      });
    }
    mem.ticks++;

    // STALL, not slow: a bot swimming steadily up (through a deep column) must NOT give up just
    // because it's taking a while — only a bot that CAN'T gain height (a covered pocket) should. So
    // reset the stall counter every time we reach a new high; give up only after cfg.safety.swimOutMaxTicks of
    // no upward progress. Then the air reflex (runs before this, terminal) owns the escape.
    if (feet.y > mem.bestY) {
      mem.bestY = feet.y;
      mem.stall = 0;
    } else {
      mem.stall++;
    }
    if (mem.stall > cfg.safety.swimOutMaxTicks) {
      endSwim(ctx, mem, "SWIM_OUT_GIVEUP", {
        at: feet,
        ticks: mem.ticks,
        stall: mem.stall,
        air: body.air,
      });
      return false;
    }

    // Hold jump to swim straight up; drop horizontal drift so we rise cleanly toward the surface
    // rather than swimming deeper into a wall. Re-asserted each tick until the head clears water.
    rt.keys.set("key.forward", false);
    rt.keys.set("key.sprint", false);
    rt.keys.set("key.jump", true);
    // Belt-and-suspenders: if we've risen so the feet cell is no longer water at all we're effectively
    // out; the submergesAt check above catches it next tick, but log the transition for trace clarity.
    const feetId = reader(feet.x, feet.y, feet.z);
    if (feetId !== null && !isWater(feetId)) {
      ctx.log.info(st.tickCount, "SWIM_OUT_RISEN", { at: feet });
    }
    return true;
  },
};
