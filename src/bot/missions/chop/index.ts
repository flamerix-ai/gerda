import { woodProfile } from "@/bot/missions/harvest/profile";
import { bagFreeSlots, loot } from "@/bot/missions/mine/loot";
import { mine } from "@/bot/missions/mine/mine";
import { MINING_SLICE, startHarvest } from "@/bot/missions/mine/mining-mem";
import { navigation } from "@/bot/missions/mine/navigation";
import { scan } from "@/bot/missions/mine/scan";
import { warnIfMissingTool } from "@/bot/missions/tool-check";
import { STATE, type State } from "@/bot/profile/states";
// chop-wood mission — find a tree, walk to it, fell the trunk, repeat until `count` logs
// are gathered (or, with no count, until no trees remain → PAUSED). It is the SAME loop as
// mine (scan → goto → break + local cluster drain) reusing the very same scan/navigation/
// mine capabilities — the only difference is the WOOD harvest profile (log predicate, taller
// spiral, no VEIN escalation, no origin bias). Reflexes (vitals/air/stuck/hazard) stay
// global, so "cross a lake to the trees without drowning" is covered by the air reflex, not
// this mission. Drops are collected by the shared `loot` divert — felling from a stand pos
// leaves the logs 2-3 blocks away, OUTSIDE vanilla pickup range; without the divert every
// log despawned on the ground while the mission reported "done" (live).
import type { Capability, Ctx } from "@/shared/kernel/capability";
import type { PartialTransitionTable } from "@/shared/kernel/fsm";
import { type Mission, missionFromCaps } from "@/shared/kernel/mission";

// A full bag ends the run gracefully instead of felling trees whose drops can't be
// banked (pickup needs a free slot; everything broken past that point rots on the
// ground). Reuses the `exhausted` completion path so isDone/outputs stay the SSOT.
const bagWatch: Capability = {
  name: "chop-bag-watch",
  guard(ctx: Ctx): boolean {
    const { st, cfg } = ctx;
    if (st.tickCount % cfg.loot.scanInterval !== 0) return false;
    const mem = ctx.slice(MINING_SLICE);
    if (mem.exhausted) return false;
    const free = bagFreeSlots(ctx.rt);
    if (free !== 0) return false; // free slots, or null = unreadable (unknown ≠ full)
    ctx.log.warn(st.tickCount, "CHOP_BAG_FULL", { broken: mem.brokenCount });
    mem.exhausted = true; // isDone completes on this same tick — a graceful "can't bank more"
    return false; // no divert — normal dispatch continues while the kernel picks up isDone
  },
};

const CHOP_EDGES: PartialTransitionTable<State> = {
  SCAN: ["GOTO", "MINE", "LOOT", "PAUSED", "ERROR"],
  GOTO: ["MINE", "SCAN", "PAUSED", "ERROR"],
  MINE: ["GOTO", "SCAN", "LOOT", "PAUSED", "ERROR"],
  LOOT: ["SCAN", "MINE", "PAUSED", "ERROR"],
};

export const chopMission: Mission = missionFromCaps(
  "chop",
  [bagWatch, loot, scan, navigation, mine],
  {
    edges: CHOP_EDGES,
    initialPhase: STATE.SCAN,
    // LOOT is bot-driven greedy movement (walk to a drop) — same reflex exemption as mine.
    movementPhases: new Set([STATE.GOTO, STATE.LOOT]),
    params: [
      {
        name: "count",
        type: "int",
        required: false,
        desc: "stop after N logs (0/omit = until none)",
      },
    ],
    init(ctx: Ctx, params: Record<string, unknown>): void {
      const c = params["count"];
      const goal = typeof c === "number" && c > 0 ? Math.floor(c) : 0;
      startHarvest(ctx.slice(MINING_SLICE), woodProfile(ctx.cfg), goal);
      // An unreachable log is a SKIP, not an ERROR — canopy logs routinely sit past a safe-fall
      // hazard veto after the bot pillared up a trunk (live: blocked_hazard at y81 walled
      // a healthy 30-log run). Skip caches the log as unreachable + re-SCANs the next tree, the same
      // policy the drill uses for unreachable veins. Forest = many trees; walling on one is absurd.
      ctx.slice(MINING_SLICE).onBlocked = "skip";
      // Pre-flight: felling without an axe still works but is painfully slow — warn loudly.
      warnIfMissingTool(ctx, "axe");
    },
    isDone(ctx: Ctx): boolean {
      const mem = ctx.slice(MINING_SLICE);
      // Complete on count OR on exhaustion, exactly like mine's batch runs — a treeless area
      // (e.g. a bot respawn-displaced to the void base) otherwise spins CHOP_SCAN_EXHAUSTED
      // forever: goalCount>0 suppresses the scan's PAUSED park expecting isDone to fire, and
      // isDone never counted `exhausted` (live: 23+ scan cycles in the void).
      return mem.goalCount > 0 && (mem.brokenCount >= mem.goalCount || mem.exhausted);
    },
    outputs(ctx: Ctx): Record<string, unknown> {
      const mem = ctx.slice(MINING_SLICE);
      return { logs: mem.brokenCount, exhausted: mem.exhausted };
    },
    onAbort(ctx: Ctx): void {
      ctx.rt.keys.releaseAll();
      ctx.rt.nav.stop();
    },
  },
);
