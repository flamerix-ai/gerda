// vitals reflex — health floor + proactive distress. Mission-agnostic SURVIVAL guard: it runs
// even with no mission active (an idle/parked bot must not bleed out), and if HP is unsafe it
// bails to RECOVER (the universal safety landing: teleport out, then resume — or, idle, just
// teleport to safety + respawn). Runs first of the body reflexes so a near-death bot recovers
// before anything else reacts.
//
// PROACTIVE distress (added after a live drowning: a bot pinned in a flooded pocket lost
// 20→7 HP before the cfg.safety.minHealth=6 floor would even trip): react to sustained harm, not just the
// absolute floor. The FALSE-POSITIVE trap (why a naive "lost N HP" trips wrongly): a bot that
// takes ONE big fall (say 6 hearts) and then stands safely on the ground has "lost 6 from its
// recent peak" for the whole window — a naive check would teleport an idle bot that is already
// fine. So distress requires REPEATED harm: ≥ cfg.safety.distressMinEvents distinct damage ticks within
// cfg.safety.distressWindow AND a cumulative drop ≥ cfg.safety.distressDrop. A single fall is ONE event → never
// trips; active drowning / lava / suffocation / poison deal damage tick after tick → many events
// → trips. That "is it still hurting me" gate is the whole anti-false-positive design.
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { LIFECYCLE, REFLEX_SETTLED } from "@/shared/kernel/phase";
import { PLAYER } from "@/shared/kernel/resource";
import { defineSlice } from "@/shared/kernel/slice";

interface VitalsMem {
  // Recent HP samples {tick, hp} inside the distress window. Peak−current is the recent loss;
  // a DROP between consecutive samples counts as one damage event (repeated events = active
  // harm). Trimmed to the window each tick; cleared when a distress divert fires (so it doesn't
  // immediately re-trip on the way back).
  samples: { tick: number; hp: number }[];
}
const VITALS_SLICE = defineSlice<VitalsMem>("vitals", () => ({ samples: [] }));

export const vitals: Capability = {
  name: "vitals",
  survival: true, // an IDLE bot must still escape lava/drown/suffocation and near-death HP
  requires: [PLAYER],

  guard(ctx: Ctx): boolean {
    const { cfg, st } = ctx;
    if (REFLEX_SETTLED.has(st.phase)) return false;
    const { health } = ctx.res(PLAYER);

    // Absolute floor — near death, escape regardless of rate (you don't reach the floor from a
    // sensor glitch; no debounce needed, and speed matters most here).
    if (health < cfg.safety.minHealth) {
      ctx.bus.emit("lowHealth", { health, phase: st.phase });
      ctx.divert(LIFECYCLE.RECOVER, `health_${health}`);
      return true;
    }

    // Proactive distress — SUSTAINED harm means get out before the floor. False-positive-safe:
    // needs repeated damage events, not one survived hit (see header).
    if (cfg.safety.distressEnabled) {
      const mem = ctx.slice(VITALS_SLICE);
      mem.samples.push({ tick: st.tickCount, hp: health });
      while (mem.samples.length > 0) {
        const oldest = mem.samples[0];
        if (oldest && st.tickCount - oldest.tick > cfg.safety.distressWindow) mem.samples.shift();
        else break;
      }
      // peak in the window + count of distinct damage ticks (hp fell vs the previous sample).
      let peak = health;
      let events = 0;
      for (let i = 0; i < mem.samples.length; i++) {
        const s = mem.samples[i];
        if (!s) continue;
        if (s.hp > peak) peak = s.hp;
        const prev = i > 0 ? mem.samples[i - 1] : undefined;
        if (prev && s.hp < prev.hp) events++;
      }
      const lost = peak - health;
      if (lost >= cfg.safety.distressDrop && events >= cfg.safety.distressMinEvents) {
        mem.samples = [];
        ctx.bus.emit("distress", { health, lost, phase: st.phase });
        ctx.divert(LIFECYCLE.RECOVER, `distress_lost_${lost}`);
        return true;
      }
    }
    return false;
  },
};
