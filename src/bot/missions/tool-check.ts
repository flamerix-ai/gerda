// Pre-flight tool check ("warn when the job doesn't have the tool it needs") — a mission's init
// declares what tool CLASS its work needs (drill → pickaxe family, chop → axe) and this warns
// LOUDLY into the journal when the bag can't deliver: missing class entirely, or a pickaxe whose
// tier can't harvest the requested ore (not every ore breaks with any pickaxe). Warn-only by
// design: the mission still runs (hand-breaking logs works, just slow; an under-tiered ore surfaces
// as the break-timeout backstop) — the warning is what turns that dead end from a mystery into a
// one-line diagnosis.
import {
  type ToolClass,
  kindSatisfiesClass,
  oreMinPickRank,
  toolKind,
  toolTierRank,
} from "@/shared/domain/tooling";
import type { Ctx } from "@/shared/kernel/capability";

/** Scan the bag for the best tool of `cls`; warn MISSION_TOOL_MISSING when there is none, and —
 *  for the pickaxe class with a requested ore — MISSION_TOOL_TIER when the best pickaxe's harvest
 *  rank is below what that ore needs to drop. Call from a mission's init. */
export function warnIfMissingTool(
  ctx: Ctx,
  cls: Exclude<ToolClass, "none">,
  opts?: { ore?: string | undefined },
): void {
  const invR = ctx.rt.inv.open();
  if (!invR.ok) return; // can't read the bag (boot race) — don't fake a verdict
  const inv = invR.value;
  let found = false;
  let bestRank = -1;
  for (const slot of inv.slots()) {
    const it = inv.slot(slot);
    if (!it) continue;
    if (!kindSatisfiesClass(toolKind(it.id), cls)) continue;
    found = true;
    bestRank = Math.max(bestRank, toolTierRank(it.id));
  }
  if (!found) {
    ctx.log.warn(ctx.st.tickCount, "MISSION_TOOL_MISSING", {
      need: cls,
      hint: `no ${cls}-class tool in the bag — breaking will be slow or impossible`,
    });
    return;
  }
  if (cls === "pickaxe" && opts?.ore) {
    const need = oreMinPickRank(opts.ore, ctx.cfg.ore.minPickRank);
    if (bestRank < need) {
      ctx.log.warn(ctx.st.tickCount, "MISSION_TOOL_TIER", {
        ore: opts.ore,
        haveRank: bestRank,
        needRank: need,
        hint: "best pickaxe tier is below this ore's harvest level — it may not break/drop",
      });
    }
  }
}
