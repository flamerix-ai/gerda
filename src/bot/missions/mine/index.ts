import { oreProfile } from "@/bot/missions/harvest/profile";
// The mining mission — GTCEu ore extraction, assembled from the focused mining
// capabilities under src/bot/missions/mine/. One pluggable mission: the kernel
// activates it via `mission_start mine` and can swap it for another with no reload.
// The scan/navigation/mine capabilities are shared with `chop` and parameterised by the
// HarvestProfile seeded in init (ore here, wood there). The edges are the mining
// TRANSITIONS table; movementPhases tells the reflexes which phases are Baritone-driven
// (so they don't read its motion as human input). Lifecycle (core), reflexes (safety) and
// persistence stay GLOBAL — they are not part of the mission.
import { homeReturn } from "@/bot/missions/mine/home-return";
import { inventory } from "@/bot/missions/mine/inventory";
import { loot } from "@/bot/missions/mine/loot";
import { mine } from "@/bot/missions/mine/mine";
import { MINING_SLICE, type MiningMem, startHarvest } from "@/bot/missions/mine/mining-mem";
import { navigation } from "@/bot/missions/mine/navigation";
import { scan } from "@/bot/missions/mine/scan";
import { storage } from "@/bot/missions/mine/storage";
import { STATE, TRANSITIONS } from "@/bot/profile/states";
import type { Ctx } from "@/shared/kernel/capability";
import { type Mission, missionFromCaps } from "@/shared/kernel/mission";

/** Mining-specific edges — the canonical TRANSITIONS table from profile/states.ts. */
export const MINE_EDGES = TRANSITIONS;

export const mineMission: Mission = missionFromCaps(
  "mine",
  // Guard order matters: inventory (dump trigger) is evaluated before loot (pickup
  // divert), matching the legacy registration order.
  [inventory, loot, scan, navigation, mine, homeReturn, storage],
  {
    edges: MINE_EDGES,
    initialPhase: STATE.SCAN,
    // LOOT is bot-driven greedy movement too (walk to a drop) — without it the human reflex
    // reads greedy's own key.forward as a human takeover and pauses mid-pickup.
    movementPhases: new Set([STATE.GOTO, STATE.HOME, STATE.RETURN, STATE.LOOT]),
    params: [
      {
        name: "count",
        type: "int",
        required: false,
        desc: "stop after N ore broken (0/omit = unlimited — mine until aborted/exhausted)",
      },
    ],
    // Seed the ORE profile + clear last run's scratch. goalCount 0 = unlimited (mine runs until
    // aborted, never self-completes by count); a `count` lets a plan mine a fixed batch then
    // advance (the sustain-loop's mine leg → load the furnaces with what it dug). Mirrors chop.
    init(ctx: Ctx, params: Record<string, unknown>): void {
      const c = params["count"];
      const goal = typeof c === "number" && c > 0 ? Math.floor(c) : 0;
      const mem: MiningMem = ctx.slice(MINING_SLICE);
      startHarvest(mem, oreProfile(ctx.cfg), goal);
      // Surface mining is resilient, not fail-loud: when a dense patch walls off the walkable
      // side-stand solveMiningTarget picks for the next vein cell, greedy reports blocked_no_path.
      // "skip" caches that ore + re-SCANs for a REACHABLE one (navigation.ts) instead of ERRORing
      // the whole run — the batch still completes from the ore the bot can actually reach. (drill
      // opts into "dig" to tunnel there; mine just harvests what's walkable and moves on.) This is
      // what killed the sustain loop on a solid ore patch: the 3rd vein cell was walled → ERROR.
      mem.onBlocked = "skip";
    },
    isDone(ctx: Ctx): boolean {
      const mem = ctx.slice(MINING_SLICE);
      // A batch run completes on count OR on exhaustion (the area is mined out before N — let the
      // plan move on to prospect a fresh vein rather than spin SCAN forever). `exhausted` is only
      // set for goalCount>0 here (an unlimited run parks at PAUSED, where isDone isn't consulted).
      return mem.goalCount > 0 && (mem.brokenCount >= mem.goalCount || mem.exhausted);
    },
    outputs(ctx: Ctx): Record<string, unknown> {
      const mem = ctx.slice(MINING_SLICE);
      return { mined: mem.brokenCount, origin: mem.origin, exhausted: mem.exhausted };
    },
  },
);
