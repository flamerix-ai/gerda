// storage — the DUMP phase. At the home base the player is expected to be standing
// in front of an open chest/barrel (a sethome spot with a container screen up). If
// a container screen is open we shift-click every ore + junk stack into it; if none
// opens within a grace window we fall back to dropping junk on the floor (never the
// ore) so the trip still frees space. Either way we clear the queued dump and head
// back via RETURN.
import { DUMP_SLICE } from "@/bot/missions/mine/dump-mem";
import { STATE } from "@/bot/profile/states";
import { classify, hasContainerOpen, readEntries } from "@/shared/domain/inventory";
import type { Capability, Ctx } from "@/shared/kernel/capability";

function finishDump(ctx: Ctx, note: string, extra: Record<string, unknown>): void {
  const dump = ctx.slice(DUMP_SLICE);
  dump.pending = false;
  dump.reason = "";
  ctx.log.info(ctx.st.tickCount, "DUMP_DONE", { note, ...extra });
  ctx.transition(STATE.RETURN, note);
}

export const storage: Capability = {
  name: "storage",

  handlers: {
    DUMP(ctx: Ctx): void {
      const { rt, st } = ctx;
      const invR = rt.inv.open();
      if (!invR.ok) {
        if (st.phaseTicks > ctx.cfg.inventory.dumpChestGraceTicks)
          finishDump(ctx, "dump: no inventory", {});
        return;
      }
      const inv = invR.value;

      const entries = readEntries(inv);
      const { oreSlots, junkSlots } = classify(entries, ctx.cfg);

      if (hasContainerOpen(inv.regions())) {
        // Deposit ore first, then junk; highest index first so a compacting impl
        // doesn't invalidate the lower indices mid-loop.
        const toDeposit = [...oreSlots, ...junkSlots].sort((a, b) => b - a);
        for (const slot of toDeposit) inv.quick(slot);
        // Verify-convention: re-read and confirm the ore actually left the bag. A silent
        // quick() failure (container full / locked) would otherwise log "deposited" while
        // the ore is still onboard — next trip we'd dump again forever. WARN if any ore
        // remains so a full chest is visible, not invisible. See docs/EXTENDING.md.
        const oreLeft = classify(readEntries(inv), ctx.cfg).oreSlots.length;
        if (oreLeft > 0) {
          ctx.log.warn(st.tickCount, "DEPOSIT_INCOMPLETE", {
            oreLeft,
            of: oreSlots.length,
            hint: "container full or deposit blocked",
          });
        }
        finishDump(ctx, "deposited to container", {
          ore: oreSlots.length,
          junk: junkSlots.length,
          oreLeft,
        });
        return;
      }

      // No container screen — give it a moment (player/Baritone may still be
      // opening it), then fall back to shedding junk only.
      if (st.phaseTicks <= ctx.cfg.inventory.dumpChestGraceTicks) return;
      for (const slot of junkSlots.sort((a, b) => b - a)) inv.dropSlot(slot);
      finishDump(ctx, "no container, dropped junk", { junk: junkSlots.length });
    },
  },
};
