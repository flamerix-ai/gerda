// inventory — keeps the bag lean while mining and decides when a dump trip is
// warranted. Runs as a throttled guard during SCAN/MINE:
//   1. shed junk (cobble/dirt/…) in the field every check, so the bot mines longer
//      between trips and only real product accumulates;
//   2. if, after shedding, the bag is still ≥ cfg.inventory.fullPct full, queue a dump
//      and divert to HOME — the home/return + storage handlers do the round trip.
// Reads main+hotbar slots via the Container facade; classification is pure
// (domain/inventory). Does NOT fire while already homing/dumping/looting.
import { DUMP_SLICE } from "@/bot/missions/mine/dump-mem";
import { STATE } from "@/bot/profile/states";
import type { Container } from "@/core/runtime/Runtime";
import { classify, fullness, readEntries } from "@/shared/domain/inventory";
import type { Capability, Ctx } from "@/shared/kernel/capability";

function storageSlots(c: Container): number[] {
  // No-region call returns the player's own storage (main + hotbar) in both the
  // real impl and the mock.
  return c.slots();
}

export const inventory: Capability = {
  name: "inventory",

  guard(ctx: Ctx): boolean {
    const { rt, cfg, st } = ctx;
    if (st.phase !== STATE.SCAN && st.phase !== STATE.MINE) return false;
    if (st.tickCount % cfg.inventory.checkIntervalTicks !== 0) return false;

    const invR = rt.inv.open();
    if (!invR.ok) return false;
    const inv = invR.value;

    const slots = storageSlots(inv);
    const entries = readEntries(inv, slots);
    const { junkSlots } = classify(entries, cfg);

    // 1. Shed junk in the field (highest slot first so indices stay valid even if
    // the impl compacts).
    for (const slot of junkSlots.sort((a, b) => b - a)) inv.dropSlot(slot);

    // 2. Re-measure occupancy after shedding; the dropped junk no longer counts.
    const remaining = entries.length - junkSlots.length;
    const ratio = fullness(remaining, slots.length);
    if (ratio < cfg.inventory.fullPct) return false;

    const dump = ctx.slice(DUMP_SLICE);
    dump.pending = true;
    dump.reason = `inventory_full_${Math.round(ratio * 100)}pct`;
    rt.keys.releaseAll();
    rt.nav.stop();
    ctx.log.info(st.tickCount, "INVENTORY_FULL", { ratio, kept: remaining });
    ctx.transition(STATE.HOME, dump.reason);
    return true;
  },
};
