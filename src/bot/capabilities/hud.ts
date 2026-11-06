// hud — paints a small status overlay (phase, held tool durability, waypoint/dump/
// vein counts) via the Draw2D facade. A throttled cross-cutting guard that never
// short-circuits. Reads the persistence slice for counters; purely cosmetic, so a
// missing slice just shows zeros.
import { PERSIST_SLICE } from "@/bot/capabilities/persistence";
import { type HudData, formatHudLines } from "@/shared/domain/hud";
import { heldStack } from "@/shared/held";
import type { Capability, Ctx } from "@/shared/kernel/capability";

export const hud: Capability = {
  name: "hud",
  // Heartbeat: the status overlay must render EVERY tick, including when no mission is
  // running. Without this the guard only fires while `running`, so an idle/paused bot
  // shows no HUD at all and formatHudLines' `!running → "STOPPED"` branch is dead code.
  always: true,

  guard(ctx: Ctx): boolean {
    const { cfg, st, rt } = ctx;
    if (!cfg.hudEnabled) return false;
    if (st.tickCount % cfg.hudInterval !== 0) return false;

    const tool = heldStack(rt);
    // Typed read of the persistence slice (created-if-absent) — counters show zero on a
    // fresh slice; no cast, no defensive optional chaining.
    const persist = ctx.slice(PERSIST_SLICE);
    const data: HudData = {
      phase: st.phase,
      running: st.running,
      phaseTicks: st.phaseTicks,
      toolId: tool?.id ?? null,
      toolPct: tool?.durabilityPct ?? null,
      waypoints: persist.waypoints.length,
      dumps: persist.stats.dumps,
      veinsFound: persist.stats.veinsFound,
    };
    rt.hud.setLines(formatHudLines(data));
    return false;
  },
};
