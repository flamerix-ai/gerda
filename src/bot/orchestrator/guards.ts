import type { StepGuardSpec } from "@/bot/orchestrator/plan";
import type { Container } from "@/core/runtime/Runtime";
// Reusable step-guard factories — pure predicates over inventory / held tool, read
// through the Container facade. Used in plan steps to gate transitions (e.g. only
// craft a chest if there are ≥8 planks). A failing guard blocks the chain.
import { fullness } from "@/shared/domain/inventory";
import type { Ctx } from "@/shared/kernel/capability";

function withInv<T>(ctx: Ctx, fn: (inv: Container) => T, fallback: T): T {
  const r = ctx.rt.inv.open();
  return r.ok ? fn(r.value) : fallback;
}

/** Require at least `n` of item `id` in the carry inventory. The acquisition layer
 *  drives a gather/craft step with `repeatWhile: not hasItems(id,n)` so it stops once
 *  the count is reached (e.g. mine until 12 iron, craft until 1 drawer). */
export function hasItems(id: string, n: number): StepGuardSpec {
  return {
    name: `hasItems(${id},${n})`,
    check(ctx) {
      const have = withInv(
        ctx,
        (inv) => {
          let total = 0;
          for (const index of inv.slots()) {
            const s = inv.slot(index);
            if (s && s.id === id) total += s.count;
          }
          return total;
        },
        0,
      );
      return have >= n ? { ok: true } : { ok: false, reason: `have ${have}/${n} ${id}` };
    },
  };
}

/** Require the bag to be below `maxPct` full (so a gathering step won't immediately
 *  overflow). */
export function inventoryHasRoom(maxPct: number): StepGuardSpec {
  return {
    name: `inventoryHasRoom(${maxPct})`,
    check(ctx) {
      const ratio = withInv(
        ctx,
        (inv) => {
          const slots = inv.slots();
          let occupied = 0;
          for (const slot of slots) if (inv.slot(slot)) occupied++;
          return fullness(occupied, slots.length);
        },
        1,
      );
      return ratio < maxPct
        ? { ok: true }
        : { ok: false, reason: `bag ${Math.round(ratio * 100)}% full` };
    },
  };
}
