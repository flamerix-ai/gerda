import { walkTo } from "@/bot/missions/_goto-leg";
import { STATE } from "@/bot/profile/states";
import type { Vec3 } from "@/core/runtime/types";
// prospect mission — make the sustain loop's "shaft" DYNAMIC: pick the nearest un-mined vein
// from the HV prospector's cache and walk to it, instead of returning to a fixed dig site. The
// prospector (ext.js `prospect`) writes vein markers to mc_world.json's resources[]; this mission
// CONSUMES them (the worker can't drive the main-thread prospector GUI). It is the `goto` mission
// with a dynamically-resolved target: read the world-scoped model → pick the nearest non-depleted
// vein of the wanted ore (domain/prospect) → greedy-walk to its column. On arrival the next plan
// step (mine) SCANs the area and the normal scan→mine loop takes over (auto-marking/depleting as
// it goes, which is what feeds the depletion check next lap). Empty cache → PROSPECT_EMPTY + finish
// (found:false) so the plan can branch (pause for a human to run `prospect`, or a future
// worker→main auto-trigger).
import { pickProspectVein } from "@/shared/domain/prospect";
import { readWorldSection } from "@/shared/domain/world-model";
import type { Ctx } from "@/shared/kernel/capability";
import type { Mission } from "@/shared/kernel/mission";
import { defineSlice } from "@/shared/kernel/slice";
import { greedyRelease } from "@/shared/nav";

interface ProspectMem {
  kind: string;
  target: Vec3 | null;
  resolved: boolean; // have we read the cache + picked a vein yet?
  found: boolean; // a matching, non-depleted vein existed
  arrived: boolean;
  done: boolean;
}

const PROSPECT_SLICE = defineSlice<ProspectMem>("prospectMission", () => ({
  kind: "",
  target: null,
  resolved: false,
  found: false,
  arrived: false,
  done: false,
}));

function prospectMem(ctx: Ctx): ProspectMem {
  return ctx.slice(PROSPECT_SLICE);
}

/** Read the world-scoped model off disk and pick the nearest non-depleted vein of mem.kind. */
function resolveTarget(ctx: Ctx, mem: ProspectMem): void {
  mem.resolved = true;
  const { rt, cfg } = ctx;
  const posR = rt.player.pos();
  const section = readWorldSection(ctx);
  if (!posR.ok || section === null) return; // world not ready → leave target null → PROSPECT_EMPTY this run
  const pick = pickProspectVein(
    section.resources,
    section.waypoints,
    posR.value,
    mem.kind,
    cfg.scan.radius,
  );
  if (pick) {
    mem.target = { x: pick.x, y: pick.y, z: pick.z };
    mem.found = true;
    ctx.log.info(ctx.st.tickCount, "PROSPECT_PICK", {
      kind: mem.kind,
      x: pick.x,
      z: pick.z,
      dist: Math.round(pick.dist),
    });
  }
}

function finish(
  ctx: Ctx,
  mem: ProspectMem,
  event: "PROSPECT_ARRIVED" | "PROSPECT_GAVE_UP" | "PROSPECT_EMPTY",
  note: string,
): void {
  greedyRelease(ctx.rt);
  mem.arrived = event === "PROSPECT_ARRIVED";
  mem.done = true;
  if (event === "PROSPECT_ARRIVED") {
    ctx.log.info(ctx.st.tickCount, event, { target: mem.target, note });
  } else {
    ctx.log.warn(ctx.st.tickCount, event, { kind: mem.kind, note });
  }
}

export const prospectMission: Mission = {
  name: "prospect",
  params: [
    {
      name: "ore",
      type: "string",
      required: false,
      desc: "vein kind to seek (PROSPECT_ORE_GROUPS key)",
    },
  ],

  // GOTO (walk to the picked vein) → done (kernel collapses to IDLE via isDone).
  edges: {
    [STATE.GOTO]: [STATE.IDLE],
  },
  initialPhase: STATE.GOTO,
  movementPhases: new Set([STATE.GOTO]),

  init(ctx: Ctx, params: Record<string, unknown>): void {
    const mem = prospectMem(ctx);
    const ore = params["ore"];
    mem.kind = typeof ore === "string" && ore.length > 0 ? ore : ctx.cfg.sustain.oreKind;
    mem.target = null;
    mem.resolved = false;
    mem.found = false;
    mem.arrived = false;
    mem.done = false;
  },

  handlers: {
    GOTO(ctx: Ctx): void {
      const mem = prospectMem(ctx);
      if (!mem.resolved) resolveTarget(ctx, mem);
      if (!mem.target) {
        finish(ctx, mem, "PROSPECT_EMPTY", "no prospected vein for this ore — run the prospector");
        return;
      }
      // Column approach (Y-free), best-effort — like goto: get as close as the terrain allows,
      // then the next step's SCAN finds the exposed ore.
      walkTo(ctx, mem.target, {
        onArrive: (via) =>
          finish(
            ctx,
            mem,
            "PROSPECT_ARRIVED",
            via === "radius" ? "within arrival radius" : "greedy arrived",
          ),
        onTimeout: () => finish(ctx, mem, "PROSPECT_GAVE_UP", "timeout"),
        onBlocked: () => finish(ctx, mem, "PROSPECT_GAVE_UP", "blocked, no path"),
      });
    },
  },

  isDone(ctx: Ctx): boolean {
    return prospectMem(ctx).done;
  },

  outputs(ctx: Ctx): Record<string, unknown> {
    const mem = prospectMem(ctx);
    return { found: mem.found, arrived: mem.arrived, target: mem.target };
  },

  onAbort(ctx: Ctx): void {
    ctx.rt.nav.stop();
  },
};
