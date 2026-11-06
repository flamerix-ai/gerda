import { MINING_SLICE, type MiningMem } from "@/bot/missions/mine/mining-mem";
import { STATE } from "@/bot/profile/states";
import { cellCenter, encodePos, floorVec } from "@/core/prim/pos";
import type { Runtime } from "@/core/runtime/Runtime";
import type { Vec3 } from "@/core/runtime/types";
// dig-to — the drill's 3D vein-chase executor (DIG_TO phase). Reaches an ore cell the greedy
// walker can't (offset/above, inside solid rock) by mining a staircase/tunnel to its stand
// position, then handing back to MINE. The geometry is pure (domain/dig-nav); this is the
// hands: read live blocks, break the planned cells (AIM→BREAK, lookAt-then-breakAsync — the
// breaker breaks what the player LOOKS at, not setTarget's coords), then let
// greedyStep walk/jump into the cleared cell. Fail-GRACEFUL: needPillar (straight up, needs
// filler), a hazard, or exceeding cfg.drill.digToMaxSteps caches the ore + falls back to SCAN — never
// ERROR, so the drill ends at PAUSED like the rest of the mission.
import { planDigStep } from "@/shared/domain/dig-nav";
import { hazardAt } from "@/shared/domain/senses";
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { defineSlice } from "@/shared/kernel/slice";
import { endPillarAscent, greedyRelease, greedyStep, isBlocked } from "@/shared/nav";
import { type BreakRun, freshBreakRun, stepBreak } from "@/shared/nav/break-cell";

const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);

interface DigToRun extends BreakRun {
  // The shared break-cell state machine + a step counter so a mis-plan can't dig forever
  // (capped at cfg.drill.digToMaxSteps) and the target this run is chasing (resets the budget).
  steps: number;
  startedFor: string;
  // Consecutive no-progress ticks (greedy blocked, nothing broken). steps only counts ARRIVALS, so a
  // permanently-unreachable target would never trip cfg.drill.digToMaxSteps → infinite re-plan storm. This bails.
  stall: number;
}
const DIG_RUN = defineSlice<DigToRun>("digToRun", () => ({
  ...freshBreakRun(),
  steps: 0,
  startedFor: "",
  stall: 0,
}));

type Read = (x: number, y: number, z: number) => string;

function reader(rt: Runtime): Read {
  return (x, y, z) => {
    const r = rt.world.blockId({ x, y, z });
    return r.ok ? r.value : "minecraft:stone"; // unreadable = solid (conservative, never a fake)
  };
}

/** Give up the current ore (it can't be dug to): cache it so SCAN/vein-follow won't re-pick it,
 *  then re-SCAN. Keeps the drill graceful (PAUSED when dry), never a hard ERROR. */
function skip(ctx: Ctx, mem: MiningMem, reason: string): void {
  greedyRelease(ctx.rt);
  endPillarAscent(ctx.rt); // restore the tool if we bailed mid-pillar (no filler / stalled)
  const t = mem.target;
  if (t) {
    const key = encodePos(t.x, t.y, t.z);
    mem.cache.add(key);
    mem.veinMined.add(key);
  }
  ctx.transition(STATE.SCAN, reason);
}

/** Break ONE staircase cell via the shared AIM→BREAK routine. Timeout → give up the ore (skip),
 *  graceful as ever; cleared/working → nothing (the handler re-plans next tick from new blocks). */
function breakCell(ctx: Ctx, target: Vec3): void {
  const outcome = stepBreak(ctx.rt, ctx.cfg, ctx.st.tickCount, ctx.slice(DIG_RUN), target, "TOP");
  if (outcome === "timeout") {
    ctx.log.warn(ctx.st.tickCount, "DIG_TO_BREAK_TIMEOUT", { at: target });
    skip(ctx, ctx.slice(MINING_SLICE), "dig-to break timeout");
  }
}

export const digTo: Capability = {
  name: "dig-to",

  handlers: {
    DIG_TO(ctx: Ctx): void {
      const { rt, cfg, st } = ctx;
      const mem = ctx.slice(MINING_SLICE);
      const run = ctx.slice(DIG_RUN);
      if (!mem.standPos || !mem.target || !mem.face) {
        ctx.transition(STATE.SCAN, "dig-to without target");
        return;
      }
      const targetKey = encodePos(mem.target.x, mem.target.y, mem.target.z);
      if (run.startedFor !== targetKey) {
        run.startedFor = targetKey;
        run.steps = 0;
        run.stall = 0;
        run.forKey = "";
      }

      const posR = rt.player.pos();
      if (!posR.ok) return;
      greedyRelease(rt); // re-asserted below if we move this tick
      const feet = floorVec(posR.value);
      const read = reader(rt);

      const groundedR = rt.player.onGround();
      const grounded = groundedR.ok ? groundedR.value : true;
      const plan = planDigStep(feet, mem.standPos);
      if (plan === "arrived") {
        // Gate the hand-off on being GROUNDED: while pillaring up to a straight-overhead stand pos
        // the jump apex transiently reads the stand height a block early (floor(y)), and handing to
        // MINE airborne drops the bot back down out of reach (live-caught). If still rising, keep
        // driving the climb this tick (greedy pillars — below); only a settled arrival → MINE.
        if (!grounded) {
          greedyStep(rt, cfg, cellCenter(mem.standPos), {
            arrivalRadius: cfg.drill.centerTol,
            bestEffort: true,
          });
          return;
        }
        endPillarAscent(rt); // restore the mining tool if we just pillared up (greedy can't here)
        ctx.log.info(st.tickCount, "DIG_TO_REACHED", { stand: mem.standPos, ore: mem.target });
        ctx.transition(STATE.MINE, "dig-to reached stand pos");
        return;
      }
      if (plan === "needPillar") {
        // straight-up with no horizontal offset — a digger can't staircase to it. The navigator now
        // owns the climb: greedyStep jump-places filler to rise (pillarUp movement-type) —
        // no dedicated PILLAR_UP phase. A block (no filler / stalled) caches the ore + SCANs, exactly
        // the old graceful behaviour. Arrival is detected next tick via planDigStep==="arrived" once
        // the bot is grounded at the stand height (above), so we ignore greedy's own (radius) arrive.
        // bestEffort: the pillar tops out ~0.87 from the cell CENTRE, never satisfying the tight
        // centre radius, so a strict goal returns null (= blocked). bestEffort returns the pillar
        // path itself; arrival is owned above (planDigStep + grounded), not greedy's radius test.
        const step = greedyStep(rt, cfg, cellCenter(mem.standPos), {
          arrivalRadius: cfg.drill.centerTol,
          bestEffort: true,
        });
        if (isBlocked(step)) {
          ctx.log.info(st.tickCount, "DIG_TO_PILLAR_BLOCKED", { stand: mem.standPos, step });
          skip(ctx, mem, "dig-to: pillar-up blocked (no filler / stalled) → skip");
        }
        return;
      }
      if (run.steps > cfg.drill.digToMaxSteps) {
        ctx.log.warn(st.tickCount, "DIG_TO_GAVE_UP", { steps: run.steps, stand: mem.standPos });
        skip(ctx, mem, "dig-to exceeded max steps → skip");
        return;
      }

      // A gap ahead toward an at-or-above ore no longer needs a dedicated BRIDGE phase: the dig-walk's
      // own greedyStep (below) bridges a void in-engine (driveBridgeStep, gated on cfg.nav.bridge) — it lays
      // filler then steps across rather than dropping into the pit. So we fall straight through to the
      // clear-and-step flow; a gap it genuinely can't cross degrades to a graceful skip → SCAN.

      // Hazard veto: never mine a path into lava/etc — give up the cell instead.
      for (const c of plan.clear) {
        if (hazardAt(read, c)) {
          ctx.log.warn(st.tickCount, "DIG_TO_HAZARD", { at: c });
          skip(ctx, mem, "dig-to hit a hazard → skip");
          return;
        }
      }

      // Clear the path one solid cell at a time; only once it's all air do we step in.
      const solid = plan.clear.filter((c) => !AIR.has(read(c.x, c.y, c.z)));
      if (solid.length > 0) {
        const c = solid[0];
        if (c) breakCell(ctx, c);
        run.stall = 0; // breaking a cell IS progress — reset the no-progress counter
        return;
      }

      // Path clear → let greedy walk/jump INTO the next cell. Greedy's step-up climbs the tread, and
      // bridges a thin void in-engine (driveBridgeStep). "moving" = progress (incl. mid-bridge). Uses a
      // GoalBlock exact-cell arrival, NOT a sub-block radius around the cell centre — the latter can
      // never be satisfied by the planner for a DIFFERENT cell (integer-cell coords are ~0.87 from the
      // centre > cfg.drill.centerTol → blocked_no_path on every step; see excavate.ts + greedy-nav GreedyOpts).
      const step = greedyStep(rt, cfg, cellCenter(plan.next), { block: true, log: ctx.log });
      if (step === "arrived") {
        run.steps++; // advanced a cell — next tick re-plans from the new feet
        run.stall = 0;
      } else if (isBlocked(step)) {
        // Greedy can't reach the cleared next cell (e.g. an across-void ore it can't bridge to). steps
        // only counts arrivals, so re-planning this unreachable A* every tick would spin forever and
        // storm the render thread (the game-hang we hit). Bail after a few consecutive blocks → SCAN.
        run.stall++;
        if (run.stall >= cfg.drill.digToStallTicks) {
          ctx.log.info(st.tickCount, "DIG_TO_NO_PATH", {
            next: plan.next,
            stand: mem.standPos,
            step,
          });
          skip(ctx, mem, "dig-to: greedy can't reach the next cell → skip");
        }
      } else {
        run.stall = 0; // "moving" (walking / mid-bridge) is progress
      }
    },
  },
};
