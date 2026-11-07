// Pick a mining strategy from the held tool. GTCEu tools mine differently:
// a hammer face-breaks a 3×3 wall (SIDE), a drill bores a 1×1 tunnel deeper
// (CENTER, depth 2), an ordinary pickaxe does a single top-break. Pure: the
// capability passes the held item id; this returns geometry the solver consumes.
import { must } from "@/core/prim/invariant";
import type { MiningStrategy } from "@/core/runtime/types";

type ToolKind = "hammer" | "drill" | "pickaxe" | "axe" | "shovel" | "none";

export function toolKind(id: string | null): ToolKind {
  if (!id) return "none";
  const s = id.toLowerCase();
  if (s.includes("hammer")) return "hammer";
  if (s.includes("drill")) return "drill";
  // pickaxe must be checked before "axe" (it contains the substring "axe").
  if (s.includes("pickaxe") || s.includes("_pick")) return "pickaxe";
  if (s.includes("axe")) return "axe";
  if (s.includes("shovel") || s.includes("spade")) return "shovel";
  return "none";
}

/** The tool CLASS a block wants broken with — sand/dirt take a shovel, wood an axe, stone/ore a
 *  pickaxe ("the right tool for the job"). Pure block-id heuristics: the vanilla + GTCEu ids
 *  we actually meet, not an exhaustive registry. "none" = hand-speed / any tool (plants, leaves,
 *  unknown ids) — the caller keeps whatever is held. */
export type ToolClass = "pickaxe" | "axe" | "shovel" | "none";

// Order-sensitive: the shovel names must be matched as WHOLE names (sand ≠ sandstone — sandstone
// is pickaxe), so shovel uses an exact set + one suffix; axe/pickaxe are suffix/substring families.
const SHOVEL_BLOCKS = new Set([
  "sand",
  "red_sand",
  "gravel",
  "clay",
  "dirt",
  "coarse_dirt",
  "rooted_dirt",
  "dirt_path",
  "farmland",
  "grass_block",
  "podzol",
  "mycelium",
  "mud",
  "packed_mud",
  "muddy_mangrove_roots",
  "snow",
  "snow_block",
  "powder_snow",
  "soul_sand",
  "soul_soil",
]);
const AXE_SUFFIX = /(_log|_wood|_planks|_hyphae)$/;
const AXE_EXACT = new Set(["bamboo_block", "stripped_bamboo_block", "crimson_stem", "warped_stem"]);
const PICKAXE_HINT =
  /(_ore$|stone|deepslate|granite|diorite|andesite|tuff|basalt|blackstone|netherrack|obsidian|terracotta|concrete$|brick|magma_block|ancient_debris|amethyst|calcite|dripstone|purpur|quartz|^raw_.*_block$)/;

export function toolClassForBlock(blockId: string | null): ToolClass {
  if (!blockId) return "none";
  const name = blockId.substring(blockId.indexOf(":") + 1).toLowerCase();
  if (SHOVEL_BLOCKS.has(name) || name.endsWith("concrete_powder")) return "shovel";
  if (AXE_SUFFIX.test(name) || AXE_EXACT.has(name)) return "axe";
  if (PICKAXE_HINT.test(name)) return "pickaxe";
  return "none";
}

/** Does a held tool KIND satisfy a required CLASS? The pickaxe class is a family: a GTCEu drill
 *  or mining hammer breaks everything a pickaxe does. */
export function kindSatisfiesClass(kind: ToolKind, cls: ToolClass): boolean {
  if (cls === "none") return true;
  if (cls === "pickaxe") return kind === "pickaxe" || kind === "drill" || kind === "hammer";
  return kind === cls;
}

/** Vanilla-ladder harvest rank of a TOOL id by its material substring (wood 0 → netherite 4);
 *  GTCEu material names are mapped onto the same ladder. Unknown material → assume capable (3):
 *  a modded tool we can't classify must not spam false warnings. */
export function toolTierRank(id: string): number {
  const s = id.toLowerCase();
  if (s.includes("netherite") || s.includes("neutronium")) return 4;
  if (s.includes("diamond") || s.includes("steel") || s.includes("tungsten")) return 3;
  if (s.includes("iron") || s.includes("bronze")) return 2;
  if (s.includes("stone") || s.includes("golden") || s.includes("copper") || s.includes("flint"))
    return 1;
  if (s.includes("wooden") || s.includes("wood")) return 0;
  return 3;
}

/** Minimum pickaxe rank an ore GROUP needs to drop, resolved against `table` — always the caller's
 *  `cfg.ore.minPickRank` (the live pack truth DERIVED from the game's needs_*_tool block tags by
 *  scripts/dev/extract_ores_live.py → config/ores_live.json `group_ranks`, merged over the pack
 *  profile's static fallback ladder in src/bot/profile/pack.ts). `table` is REQUIRED: the fallback
 *  ladder names GTCEu groups (silver/lead/galena/nickel/platinum/uranium), so it is PACK data and
 *  cannot live in this pack-agnostic domain module. "Not every ore breaks with any pickaxe." */
export function oreMinPickRank(
  oreGroup: string | null | undefined,
  table: Readonly<Record<string, number>>,
): number {
  if (!oreGroup) return 1;
  // Suffix-walk mirrors the generator: it prunes "deepslate_gold" when plain "gold"
  // answers the same rank, so "deepslate_gold" must resolve via its suffix chain here.
  let g = oreGroup.toLowerCase();
  while (g.length > 0) {
    const r = table[g];
    if (r !== undefined) return r;
    const cut = g.indexOf("_");
    if (cut < 0) break;
    g = g.slice(cut + 1);
  }
  return 1;
}

const HAMMER: MiningStrategy = {
  breakStrategy: "MANUAL_AOE",
  aoeRadius: 1, // 3×3 face
  aoeDepth: 0,
  standDistance: 2,
  breakTargetFace: "SIDE",
  targetPicker: "layerFirst",
  layerStride: 3,
  layerVerticalSpan: 1,
};

const DRILL: MiningStrategy = {
  breakStrategy: "MANUAL_AOE",
  aoeRadius: 0,
  aoeDepth: 2, // bore forward
  standDistance: 2,
  breakTargetFace: "CENTER",
  targetPicker: "nearest",
};

const PICKAXE: MiningStrategy = {
  breakStrategy: "MANUAL_AOE",
  aoeRadius: 0,
  aoeDepth: 0,
  standDistance: 2,
  breakTargetFace: "TOP",
  targetPicker: "nearest",
};

// An axe fells a tree by standing beside a log and breaking it (single-block, SIDE).
const AXE: MiningStrategy = {
  breakStrategy: "MANUAL_AOE",
  aoeRadius: 0,
  aoeDepth: 0,
  standDistance: 2,
  breakTargetFace: "SIDE",
  targetPicker: "nearest",
};

export function strategyForTool(id: string | null): MiningStrategy {
  switch (toolKind(id)) {
    case "hammer":
      return HAMMER;
    case "drill":
      return DRILL;
    case "axe":
      return AXE;
    default:
      return PICKAXE;
  }
}

export interface InvTool {
  readonly slot: number;
  readonly id: string;
  readonly durabilityPct: number;
}

// Pick a backup tool to hot-swap to when the held one is about to break. Considers
// only mining tools above the durability floor, never the slot we're holding;
// prefers the same kind as the worn tool, then the freshest. Returns the inventory
// slot to equip, or null when nothing is worth swapping (→ caller goes HOME).
export function findBackupTool(
  tools: readonly InvTool[],
  currentKind: ToolKind,
  currentSlot: number,
  minDurabilityPct: number,
): number | null {
  const candidates = tools.filter(
    (t) =>
      t.slot !== currentSlot && t.durabilityPct > minDurabilityPct && toolKind(t.id) !== "none",
  );
  if (candidates.length === 0) return null;
  const sameKind = candidates.filter((t) => toolKind(t.id) === currentKind);
  const pool = sameKind.length > 0 ? sameKind : candidates;
  pool.sort((a, b) => b.durabilityPct - a.durabilityPct);
  return must(pool[0], "findBackupTool: non-empty pool has no head").slot;
}
