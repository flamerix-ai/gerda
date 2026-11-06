import type { Container, ItemStack } from "@/core/runtime/Runtime";
// tool reflex — durability tiers for the held mining tool (ported verbatim from the
// old safety capability):
//   ≤ hardStop%               → ERROR (refuse to destroy the tool)
//   ≤ swap%, backup in bag    → hot-swap to the fresh backup, keep working
//   ≤ swap%, no backup        → RECOVER (restock) — was HOME
// Skips the dump trip (HOME/DUMP) so a restock-in-progress isn't interrupted.
import { type InvTool, findBackupTool, toolKind } from "@/shared/domain/tooling";
import { equipSlot, heldFrom, heldSlotIndex } from "@/shared/held";
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { LIFECYCLE, REFLEX_SETTLED } from "@/shared/kernel/phase";

function readTools(inv: Container): InvTool[] {
  const out: InvTool[] = [];
  for (const slot of inv.slots()) {
    const s = inv.slot(slot);
    if (s) out.push({ slot, id: s.id, durabilityPct: s.durabilityPct });
  }
  return out;
}

// Try to equip a fresh backup of the worn tool. Returns true if a swap happened.
function tryHotSwap(ctx: Ctx, inv: Container, worn: ItemStack, heldSlot: number): boolean {
  const backup = findBackupTool(
    readTools(inv),
    toolKind(worn.id),
    heldSlot,
    ctx.cfg.safety.toolDurabilitySwap,
  );
  if (backup === null) return false;

  // equipSlot's non-hotbar path swaps into the current held slot (= heldSlot, since the guard
  // proved the held item readable), so this is behaviour-identical to the old inline swap.
  equipSlot(inv, backup);
  ctx.log.info(ctx.st.tickCount, "TOOL_HOTSWAP", {
    from: worn.id,
    fromPct: worn.durabilityPct,
    backupSlot: backup,
  });
  return true;
}

export const tool: Capability = {
  name: "tool",

  guard(ctx: Ctx): boolean {
    const { rt, cfg, st } = ctx;
    if (REFLEX_SETTLED.has(st.phase)) return false;

    const invR = rt.inv.open();
    if (!invR.ok) return false;
    const inv = invR.value;
    const held = heldFrom(inv);
    if (!held) return false;

    const lowTool = held.durabilityPct <= cfg.safety.toolDurabilitySwap;
    // Phases where a hot-swap must not fire — configured, not hardcoded: which phases are
    // "already at the chest" is the BOT's knowledge, and this reflex is shared-tier.
    const canActHere = !cfg.safety.toolSwapBlockedPhases.includes(st.phase);

    // Prefer a fresh backup of the same tool over ERROR/RECOVER.
    if (lowTool && canActHere && tryHotSwap(ctx, inv, held, heldSlotIndex(inv))) {
      return false;
    }
    // divert() #stops Baritone for BOTH bails — the old hard-stop path skipped #stop and
    // left the bot pathing into ERROR.
    if (held.durabilityPct <= cfg.safety.toolDurabilityHardStop) {
      ctx.divert(LIFECYCLE.ERROR, `tool_hard_stop_${held.durabilityPct}pct`);
      return true;
    }
    if (lowTool && canActHere) {
      ctx.divert(LIFECYCLE.RECOVER, `tool_critical_${held.durabilityPct}pct`);
      return true;
    }
    return false;
  },
};
