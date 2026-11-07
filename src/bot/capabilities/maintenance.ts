import { STATE } from "@/bot/profile/states";
import type { Container } from "@/core/runtime/Runtime";
import { equipSlot, heldFrom } from "@/shared/held";
// maintenance tier — resumable interrupts. Unlike the safety reflexes (which divert to
// RECOVER and re-enter the mission at its START, losing progress), a maintenance
// interrupt SUSPENDS the exact phase, performs upkeep, and RESUMES that same phase via
// ctx.interrupt()/ctx.resume(). The first one is EAT; SWAP_TOOL/DEPOSIT can follow the
// same shape.
//
// EAT: when food is low AND a food item is in the bag, interrupt → equip food → take a
// bite → resume once fed (or out of food / timeout). Eating is driven by rt.interact.eat()
// (the held item's finishUsingItem — applies nutrition + consumes one), NOT input
// simulation: live testing showed jsMacros re-asserts held keys every tick, so a held
// key.use keeps resetting the use-item timer to 32 and the eat NEVER completes. A bite is
// instant via finishUsingItem, but bites are still PACED cfg.safety.eatBiteTicks apart so food
// updates settle between them and a single tick can't drain the whole stack.
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { REFLEX_SETTLED } from "@/shared/kernel/phase";
import { defineSlice } from "@/shared/kernel/slice";

interface EatMem {
  // tick we entered EAT — bounds the meal so a stuck "can't actually eat" can't hang it.
  started: number;
  // tick of the last bite (useItem) — paces bites cfg.safety.eatBiteTicks apart.
  lastBite: number;
}
const EAT_SLICE = defineSlice<EatMem>("eat", () => ({ started: 0, lastBite: 0 }));

/** First inventory slot holding one of `foodItems`, or null. */
function findFoodSlot(inv: Container, foodItems: readonly string[]): number | null {
  for (const slot of inv.slots()) {
    const s = inv.slot(slot);
    if (s && foodItems.includes(s.id)) return slot;
  }
  return null;
}

/** Equip a food item into the held hotbar slot. Returns false if the bag has none. */
function equipFood(inv: Container, foodItems: readonly string[]): boolean {
  const slot = findFoodSlot(inv, foodItems);
  if (slot === null) return false;
  equipSlot(inv, slot);
  return true;
}

function holdingFood(inv: Container, foodItems: readonly string[]): boolean {
  const held = heldFrom(inv);
  return held !== null && foodItems.includes(held.id);
}

export const maintenance: Capability = {
  name: "maintenance",

  // GUARD — the interrupt trigger. Runs in the reflex pass (registered after the safety
  // reflexes so they preempt eating). Suspends the current phase into EAT when hungry.
  guard(ctx: Ctx): boolean {
    const { rt, cfg, st } = ctx;
    if (REFLEX_SETTLED.has(st.phase) || st.phase === STATE.EAT) return false;
    const foodR = rt.player.food();
    if (!foodR.ok || foodR.value > cfg.safety.lowFoodLevel) return false;
    // Only interrupt if we can actually do something about it — food in the bag.
    const invR = rt.inv.open();
    if (!invR.ok || findFoodSlot(invR.value, cfg.safety.foodItems) === null) return false;

    ctx.interrupt(STATE.EAT, `eat_food_${foodR.value}`);
    return true;
  },

  handlers: {
    // EAT — take paced bites until fed, then resume the suspended phase.
    EAT(ctx: Ctx): void {
      const { rt, cfg, st } = ctx;
      const mem = ctx.slice(EAT_SLICE);
      if (st.phaseTicks <= 1) {
        mem.started = st.tickCount;
        mem.lastBite = st.tickCount - cfg.safety.eatBiteTicks; // first bite is due immediately
      }

      const foodR = rt.player.food();
      if (foodR.ok && foodR.value >= cfg.safety.eatTargetFood) {
        // Effect-verified: food actually reached target → emit so telemetry counts a
        // real meal (not just a dispatched bite).
        ctx.log.info(st.tickCount, "ATE", { food: foodR.value });
        ctx.bus.emit("ate", { food: foodR.value, ticks: st.tickCount - mem.started });
        ctx.resume("fed");
        return;
      }
      if (st.tickCount - mem.started > cfg.safety.eatTimeoutTicks) {
        // Not a silent resume: the meal never reached target — surface it as a WARN so a
        // broken eat path (e.g. the finishUsingItem regression) is visible, not invisible.
        ctx.log.warn(st.tickCount, "EAT_TIMEOUT", {
          food: foodR.ok ? foodR.value : -1,
          target: cfg.safety.eatTargetFood,
        });
        ctx.resume("eat_timeout");
        return;
      }
      const invR = rt.inv.open();
      if (!invR.ok) return; // can't read inv this tick — try again next
      const inv = invR.value;
      if (!holdingFood(inv, cfg.safety.foodItems) && !equipFood(inv, cfg.safety.foodItems)) {
        ctx.log.warn(st.tickCount, "EAT_OUT_OF_FOOD", { food: foodR.ok ? foodR.value : -1 });
        ctx.resume("out_of_food");
        return;
      }
      // Take a bite, then wait cfg.safety.eatBiteTicks before the next so the food update settles
      // and a single tick can't drain the whole stack.
      if (st.tickCount - mem.lastBite >= cfg.safety.eatBiteTicks) {
        // reliability-ok: best-effort bite — a failed eat just retries next bite window.
        void rt.interact.eat();
        mem.lastBite = st.tickCount;
        ctx.log.trc(st.tickCount, "EAT_BITE", { food: foodR.ok ? foodR.value : -1 });
      }
    },
  },
};
