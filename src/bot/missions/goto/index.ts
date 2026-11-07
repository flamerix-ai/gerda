import { walkTo } from "@/bot/missions/_goto-leg";
import { intParam } from "@/bot/missions/_params";
import { STATE } from "@/bot/profile/states";
import type { Vec3 } from "@/core/runtime/types";
// goto mission — the generic travel / return-to-base primitive: greedy-walk to a {x,y,z} and stop.
// It is the standalone form of fetch's GOTO leg with nothing after it — no withdraw, no deposit —
// so a plan can chain "walk to the furnace bank" or "return to base" as its own step. The sustain
// loop uses it as the base-return leg between mining a shaft and unloading at the chest/furnace bank.
//
// Shares the kernel + reflex layer + the GOTO movement phase with mine/fetch; brings only its own
// arrival/timeout bookkeeping. A block ends the trip (no ore-style dig escalation) — best-effort,
// like fetch: the bot gets as close as the terrain allows, then finishes (the loop re-evaluates).
import type { Ctx } from "@/shared/kernel/capability";
import type { Mission } from "@/shared/kernel/mission";
import { defineSlice } from "@/shared/kernel/slice";
import { greedyRelease } from "@/shared/nav";

interface GotoMem {
  target: Vec3 | null;
  done: boolean;
  arrived: boolean;
}

const GOTO_SLICE = defineSlice<GotoMem>("goto", () => ({
  target: null,
  done: false,
  arrived: false,
}));

function gotoMem(ctx: Ctx): GotoMem {
  return ctx.slice(GOTO_SLICE);
}

function finish(
  ctx: Ctx,
  mem: GotoMem,
  event: "GOTO_ARRIVED" | "GOTO_GAVE_UP",
  note: string,
): void {
  greedyRelease(ctx.rt);
  mem.arrived = event === "GOTO_ARRIVED";
  mem.done = true;
  if (event === "GOTO_ARRIVED") ctx.log.info(ctx.st.tickCount, event, { target: mem.target, note });
  else ctx.log.warn(ctx.st.tickCount, event, { target: mem.target, note });
}

export const gotoMission: Mission = {
  name: "goto",
  params: [
    { name: "x", type: "int", required: true, desc: "destination X" },
    { name: "y", type: "int", required: true, desc: "destination Y" },
    { name: "z", type: "int", required: true, desc: "destination Z" },
  ],

  // GOTO (walk) → done (kernel collapses to IDLE via isDone). No follow-on phase.
  edges: {
    [STATE.GOTO]: [STATE.IDLE],
  },
  initialPhase: STATE.GOTO,
  movementPhases: new Set([STATE.GOTO]),

  init(ctx: Ctx, params: Record<string, unknown>): void {
    const mem = gotoMem(ctx);
    const x = intParam(params, "x");
    const y = intParam(params, "y");
    const z = intParam(params, "z");
    mem.target = x !== null && y !== null && z !== null ? { x, y, z } : null;
    mem.done = false;
    mem.arrived = false;
  },

  handlers: {
    GOTO(ctx: Ctx): void {
      const mem = gotoMem(ctx);
      if (!mem.target) {
        finish(ctx, mem, "GOTO_GAVE_UP", "no target");
        return;
      }
      // Column approach (Y-free): the destination Y is the goal, the bot approaches its XZ over the
      // surface. A block ends the trip best-effort (no dig escalation), like fetch's GOTO leg.
      walkTo(ctx, mem.target, {
        onArrive: (via) =>
          finish(
            ctx,
            mem,
            "GOTO_ARRIVED",
            via === "radius" ? "within arrival radius" : "greedy arrived",
          ),
        onTimeout: () => finish(ctx, mem, "GOTO_GAVE_UP", "timeout"),
        onBlocked: () => finish(ctx, mem, "GOTO_GAVE_UP", "blocked, no path"),
      });
    },
  },

  isDone(ctx: Ctx): boolean {
    return gotoMem(ctx).done;
  },

  outputs(ctx: Ctx): Record<string, unknown> {
    return { arrived: gotoMem(ctx).arrived };
  },

  onAbort(ctx: Ctx): void {
    ctx.rt.nav.stop();
  },
};
