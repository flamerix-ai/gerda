import { STATE, type State } from "@/bot/profile/states";
// loot — opportunistic pickup. A throttled guard scans dropped item entities while
// SCAN/MINE; if a valuable one is near, divert to LOOT, greedy-walk to it (own navigator;
// vanilla auto-pickup grabs it), then resume the exact phase we left. Ported from the
// reverse-engineered loot.js; uses the filtered world.items() facade.
import { dist } from "@/core/prim/pos";
import type { Vec3 } from "@/core/runtime/types";
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { defineSlice } from "@/shared/kernel/slice";
import { greedyRelease, greedyStep } from "@/shared/nav";

const PRIORITY = [
  "gtceu:",
  "minecraft:diamond",
  "minecraft:emerald",
  "minecraft:gold_nugget",
  "minecraft:iron_nugget",
  "minecraft:redstone",
  "minecraft:lapis",
  "minecraft:coal",
  "minecraft:copper",
  "minecraft:raw",
  // Felled logs: chop's stand pos leaves them outside vanilla pickup range — without
  // this the whole harvest despawned on the ground (chop reuses this capability).
  "_log",
];

const isPriority = (id: string): boolean => PRIORITY.some((p) => id.includes(p));

/** Count of empty carry slots — vanilla pickup needs one to land in. `null` = the inventory
 *  is unreadable RIGHT NOW (facade hiccup / empty slot list — a real carry inventory always
 *  has 36 slots), which callers must treat as "unknown", never as "full": a transient read
 *  failure killed a healthy chop with 25 free slots (live, CHOP_BAG_FULL at
 *  broken:2). Exported for chop's bag-watch guard. */
export function bagFreeSlots(rt: Ctx["rt"]): number | null {
  const invR = rt.inv.open();
  if (!invR.ok) return null;
  const inv = invR.value;
  const slots = inv.slots();
  if (slots.length === 0) return null;
  return slots.filter((s) => inv.slot(s) === null).length;
}

interface LootMem {
  target: (Vec3 & { id: string }) | null;
  returnPhase: State;
}
const LOOT_SLICE = defineSlice<LootMem>("loot", () => ({ target: null, returnPhase: STATE.SCAN }));

export const loot: Capability = {
  name: "loot",

  guard(ctx: Ctx): boolean {
    const { rt, cfg, st } = ctx;
    if (st.phase !== STATE.SCAN && st.phase !== STATE.MINE) return false;
    if (st.tickCount % cfg.loot.scanInterval !== 0) return false;

    const posR = rt.player.pos();
    if (!posR.ok) return false;
    const here = posR.value;
    const itemsR = rt.world.items(cfg.loot.scanRadius);
    if (!itemsR.ok) return false;
    const items = itemsR.value.filter((it) => isPriority(it.id));
    if (items.length === 0) return false;
    items.sort((a, b) => dist(a, here) - dist(b, here));
    const best = items[0];
    if (!best) return false;
    // A full bag can't pick anything up — the divert would walk to the drop and stall there.
    if (bagFreeSlots(rt) === 0) {
      ctx.log.warn(st.tickCount, "LOOT_BAG_FULL", { id: best.id });
      return false;
    }

    const lm = ctx.slice(LOOT_SLICE);
    lm.target = { x: best.x, y: best.y, z: best.z, id: best.id };
    lm.returnPhase = st.phase;
    ctx.bus.emit("lootSpotted", { x: best.x, y: best.y, z: best.z, id: best.id });
    ctx.transition(STATE.LOOT, `loot ${best.id}`);
    return true;
  },

  handlers: {
    LOOT(ctx: Ctx): void {
      const { rt, cfg, st } = ctx;
      const lm = ctx.slice(LOOT_SLICE);
      const target = lm.target;
      if (!target) {
        ctx.transition(lm.returnPhase, "loot: no target");
        return;
      }
      // VERIFIED pickup: done only when the drop ENTITY is gone from the world, never on
      // "we are near where it was spotted" — proximity fired one tick after the divert while
      // the item stayed on the ground (an entire chop harvest despawned off this,
      // live). Same-id drift/cluster mates within cfg.loot.verifyRadius keep the phase
      // alive so a felled tree's whole drop pile is vacuumed in one divert.
      let goal = target;
      const itemsR = rt.world.items(cfg.loot.scanRadius);
      if (itemsR.ok) {
        const live = itemsR.value
          .filter((it) => it.id === target.id && dist(it, target) <= cfg.loot.verifyRadius)
          .sort((a, b) => dist(a, target) - dist(b, target))[0];
        if (!live) {
          greedyRelease(rt);
          lm.target = null;
          ctx.transition(lm.returnPhase, "loot picked up");
          return;
        }
        // Walk to where the drop IS now (items pop with velocity and drift off the spot).
        goal = { x: live.x, y: live.y, z: live.z, id: target.id };
        lm.target = goal;
      }
      if (st.phaseTicks > cfg.loot.timeoutTicks) {
        greedyRelease(rt);
        lm.target = null;
        ctx.transition(lm.returnPhase, "loot timeout");
        return;
      }
      // Greedy-walk INTO the drop (arrival ≈ cfg.loot.pickupDist ≤ the vanilla pickup reach).
      // On arrival hold position — the gone-check above ends the phase once the entity
      // despawns into the bag (vanilla pickup delay is ~10 ticks after a block-break drop).
      // A block isn't fatal for opportunistic loot — the timeout above resumes the prior phase.
      const step = greedyStep(rt, cfg, goal, { arrivalRadius: cfg.loot.pickupDist });
      if (step === "arrived") {
        greedyRelease(rt);
        return;
      }
      if (step !== "moving") {
        greedyRelease(rt);
        lm.target = null;
        ctx.transition(lm.returnPhase, `loot ${step}`);
      }
    },
  },
};
