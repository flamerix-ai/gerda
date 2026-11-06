import { MINING_SLICE } from "@/bot/missions/mine/mining-mem";
import type { StepGuardSpec } from "@/bot/orchestrator/plan";
import type { Container } from "@/core/runtime/Runtime";
// Sustain-loop sensors — the higher-level "world & economy" predicates that feed the plan
// orchestrator's autonomous mine → base → restock → repeat cycle. Distinct from the generic
// inventory guards (orchestrator/guards.ts): these read the harvest blackboard (vein
// exhaustion) and stock levels across the bag + an open storage container.
//
// Each sensor is a PURE read over Ctx — no side effects, no transition. The raw readings are
// exported for live introspection (the `sensors` bridge command) and for future isDone wiring;
// the StepGuardSpec wrappers plug them straight into plan steps (the sustain-loop, Stage 3).
import { containerRegions } from "@/shared/domain/inventory";
import type { Ctx } from "@/shared/kernel/capability";

function withInv<T>(ctx: Ctx, fn: (inv: Container) => T, fallback: T): T {
  const r = ctx.rt.inv.open();
  return r.ok ? fn(r.value) : fallback;
}

export interface VeinReading {
  readonly exhausted: boolean;
  readonly scanCycle: number;
  readonly maxCycles: number;
  readonly mode: "SPIRAL" | "VEIN";
  readonly veinQueue: number; // cells still queued in the current local cluster
}

/** Read the harvest blackboard's exhaustion state. The vein is "exhausted" once SCAN has
 *  wrapped the spiral `cfg.scan.maxCycles` times with no finds AND no local cluster is left to
 *  mine — exactly the point scan.ts's `onSpiralExhausted` pauses the mission. Only meaningful
 *  while a mine/drill mission is active (idle → fresh slice → scanCycle 0 → not exhausted). */
export function veinReading(ctx: Ctx): VeinReading {
  const mem = ctx.slice(MINING_SLICE);
  const maxCycles = ctx.cfg.scan.maxCycles;
  const exhausted =
    mem.scanCycle >= maxCycles && mem.veinQueue.length === 0 && mem.mode === "SPIRAL";
  return {
    exhausted,
    scanCycle: mem.scanCycle,
    maxCycles,
    mode: mem.mode,
    veinQueue: mem.veinQueue.length,
  };
}

/** True once the active vein/shaft is worked out (see {@link veinReading}). */
export function veinExhausted(ctx: Ctx): boolean {
  return veinReading(ctx).exhausted;
}

export interface StockOpts {
  /** Also count the open container's non-player slots (a chest/storage bank at base), not just
   *  the carry inventory. Default false (carry only). Requires a container screen open. */
  readonly includeStorage?: boolean;
}

/** Total count of item `id` across the carry inventory (+ the open container's storage regions
 *  when `includeStorage`). Two independent passes — carry via no-arg `slots()`, storage via the
 *  non-player regions — so it needs no hardcoded carry-region list. 0 if no inventory readable. */
export function stockOf(ctx: Ctx, id: string, opts: StockOpts = {}): number {
  return withInv(
    ctx,
    (inv) => {
      const count = (slots: readonly number[]): number => {
        let t = 0;
        for (const idx of slots) {
          const s = inv.slot(idx);
          if (s && s.id === id) t += s.count;
        }
        return t;
      };
      let total = count(inv.slots()); // carry: main + hotbar
      if (opts.includeStorage) {
        const storage = containerRegions(inv.regions());
        if (storage.length > 0) total += count(inv.slots(...storage));
      }
      return total;
    },
    0,
  );
}

/** True when stock of `id` is strictly below `threshold` (carry, or +storage). */
export function isLowStock(ctx: Ctx, id: string, threshold: number, opts?: StockOpts): boolean {
  return stockOf(ctx, id, opts) < threshold;
}

// ── Plan-step guard wrappers (Stage 3 wiring) ──────────────────────────────────────────────

/** Plan guard: passes once the active vein is worked out (SCAN wrapped `cfg.scan.maxCycles` dry).
 *  The sustain loop uses it to end the mine step and move on to prospect a new shaft. */
export function veinExhaustedGuard(): StepGuardSpec {
  return {
    name: "veinExhausted",
    check(ctx) {
      const r = veinReading(ctx);
      return r.exhausted
        ? { ok: true }
        : {
            ok: false,
            reason: `vein live (cycle ${r.scanCycle}/${r.maxCycles}, queue ${r.veinQueue})`,
          };
    },
  };
}

/** Plan guard: passes when stock of `id` is BELOW `threshold` (carry, or +storage). Gates a
 *  restock-craft step — "craft more torches only when low". */
export function lowStockGuard(id: string, threshold: number, opts?: StockOpts): StepGuardSpec {
  return {
    name: `lowStock(${id},<${threshold})`,
    check(ctx) {
      const have = stockOf(ctx, id, opts);
      return have < threshold
        ? { ok: true }
        : { ok: false, reason: `have ${have} ≥ ${threshold} ${id}` };
    },
  };
}
