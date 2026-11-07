import { descend } from "@/bot/missions/drill/descend";
import { digTo } from "@/bot/missions/drill/dig-to";
import { EXCAVATE_SLICE, excavate } from "@/bot/missions/drill/excavate";
import { selectDrillVein } from "@/bot/missions/drill/select-vein";
import { DRILL_RUN, DRILL_SLICE, resetDrillRun } from "@/bot/missions/drill/state";
import { drillProfile } from "@/bot/missions/harvest/profile";
import { mine } from "@/bot/missions/mine/mine";
import { MINING_SLICE, startHarvest } from "@/bot/missions/mine/mining-mem";
import { navigation } from "@/bot/missions/mine/navigation";
import { scan } from "@/bot/missions/mine/scan";
import { warnIfMissingTool } from "@/bot/missions/tool-check";
import { STATE, type State } from "@/bot/profile/states";
// drill — the prospect→drill-down→mine mission. The prospector (ext.js `prospect`, run first)
// caches veins as surface X/Z in mc_world.json; this mission reads the nearest cached vein of the
// requested ore, walks to that X/Z (real nav), digs a 1-wide shaft straight down (DESCEND, real
// hammer) until the shaft exposes the ore, then mines it with the shared MINE vein-follow. The
// mission never teleports or self-gives; the prospector is recharged legitimately (Turbo Charger).
import type { Ctx } from "@/shared/kernel/capability";
import type { PartialTransitionTable } from "@/shared/kernel/fsm";
import { type Mission, missionFromCaps } from "@/shared/kernel/mission";

/** Drill edges: walk to the vein (GOTO) → dig down (DESCEND) → strip-mine the vein VOLUME
 *  (EXCAVATE) → each exposed clump goes to MINE's vein-follow → back to EXCAVATE (via the
 *  excavate guard rerouting the MINE→SCAN handoff) → when the corridor plan is dug, SCAN → PAUSED. */
const DRILL_EDGES: PartialTransitionTable<State> = {
  GOTO: ["DESCEND", "DIG_TO", "MINE", "EXCAVATE", "SCAN", "PAUSED", "ERROR"],
  DESCEND: ["MINE", "EXCAVATE", "GOTO", "DIG_TO", "SCAN", "PAUSED", "ERROR"],
  EXCAVATE: ["MINE", "GOTO", "DIG_TO", "SCAN", "DESCEND", "PAUSED", "ERROR"],
  MINE: ["GOTO", "DIG_TO", "SCAN", "EXCAVATE", "DESCEND", "PAUSED", "ERROR"],
  DIG_TO: ["MINE", "SCAN", "GOTO", "EXCAVATE", "DESCEND", "PAUSED", "ERROR"],
  SCAN: ["GOTO", "MINE", "EXCAVATE", "DESCEND", "PAUSED", "ERROR"],
  RECOVER: ["IDLE", "PAUSED", "ERROR"],
  PAUSED: ["GOTO", "DESCEND", "EXCAVATE", "SCAN", "IDLE", "ERROR"],
  ERROR: ["IDLE"],
};

export const drillMission: Mission = missionFromCaps(
  "drill",
  [navigation, descend, digTo, excavate, mine, scan],
  {
    edges: DRILL_EDGES,
    initialPhase: STATE.GOTO,
    // GOTO walks, DIG_TO walks/jumps a staircase, jump-places filler to pillar up a straight-
    // overhead ore, AND bridges a gap in-engine (greedyStep's driveBridgeStep, gated on cfg.nav.bridge —
    // no separate BRIDGE phase any more) — all legitimate self-movement, so the human-input safety
    // reflex must NOT read them as a takeover. DESCEND is a movement phase too: it usually digs-and-
    // falls in place, but its step-1 walk-onto-the-marker-column (greedyStep) is a SUSTAINED walk
    // whenever GOTO times out short of the vein or the bot re-descends after a MINE leg — that walk
    // trips the human-input reflex (>cfg.safety.inputHoldTicks of forward input) and paused a live drill run. The
    // bot drives DESCEND, so its motion is never a human takeover; gate the reflex off here too.
    movementPhases: new Set([STATE.GOTO, STATE.DIG_TO, STATE.EXCAVATE, STATE.DESCEND]),
    params: [{ name: "ore", type: "string", required: false, desc: "ore group, e.g. iron/gold" }],
    // Seed the ore profile, then pick the nearest cached prospector vein of the requested group
    // and aim navigation at its X/Z (arrive → DESCEND). No cached vein → flag noTarget; the
    // descend guard turns that into a graceful PAUSE + DRILL_NEEDS_PROSPECT alert (recoverable by
    // recharge + prospect + resume), not a hard ERROR.
    init(ctx: Ctx, params: Record<string, unknown>): void {
      const mem = ctx.slice(MINING_SLICE);
      const oreParamRaw = params["ore"];
      const oreParam = typeof oreParamRaw === "string" ? oreParamRaw : undefined;
      // Scope the mining predicate to the requested ore group, so the drill mines ONLY that vein
      // and doesn't chase every other ore it grazes (the surface-scatter thrash on ore-rich terrain).
      startHarvest(mem, drillProfile(ctx.cfg, oreParam), 0);
      // 3D vein-chase: when greedy can't WALK to the next ore (offset/above in solid rock), mine a
      // staircase/tunnel to it (DIG_TO) instead of skipping. DIG_TO still caches + SCANs anything
      // even digging can't reach (straight-up/runaway), so the run still ends gracefully at PAUSED.
      mem.onBlocked = "dig";
      const drill = ctx.slice(DRILL_SLICE);
      drill.vein = null;
      drill.bbox = undefined;
      drill.bandsMined = 0; // multi-band descent counter (see excavate.done / descend depth-floor)
      drill.skip = []; // fresh unreachable-vein skip-set (session-only; see descend step-1 GOTO-stall guard)
      resetDrillRun(ctx.slice(DRILL_RUN)); // fresh shaft (slices persist across missions)
      // Clear any excavation plan left in the blackboard from a prior drill run (slices persist).
      const exc = ctx.slice(EXCAVATE_SLICE);
      exc.cells = [];
      exc.idx = 0;
      exc.active = false;
      exc.checkedIdx = -1;

      // Pick the nearest cached prospector vein + aim the navigator at it. Empty cache → noTarget;
      // the descend guard turns that into a graceful PAUSE (not ERROR) so a dead prospector is
      // recoverable by recharge + `prospect` + resume. selectDrillVein owns the marker read + nav.
      selectDrillVein(ctx, oreParam);

      // Pre-flight tool warning: no pickaxe-family tool, or a tier too low for this ore, is a
      // dead end that otherwise only surfaces as a break timeout minutes later.
      warnIfMissingTool(ctx, "pickaxe", { ore: oreParam });
    },
    outputs(ctx: Ctx): Record<string, unknown> {
      const mem = ctx.slice(MINING_SLICE);
      return { mined: mem.brokenCount, vein: ctx.slice(DRILL_SLICE).vein };
    },
  },
);
