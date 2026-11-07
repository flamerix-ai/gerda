// ore-groups — map a requested ore intent (e.g. "gold", "iron") to a block-id predicate, so the
// drill mines ONLY the vein it was sent for instead of every ore it grazes. GTCEu veins scatter
// several materials under one intent (galena = silver+lead; the iron intent covers magnetite /
// hematite / goethite / limonite …), and those block ids do NOT all contain the intent word — so a
// bare substring match is wrong for them. We keep a small alias table for the non-obvious groups and
// fall back to a normalized substring match for the rest (gold/copper/tin/… where the id contains
// the intent). Pure + data-only → unit-tested.

/** Ore intent → the material stems whose *_ore block ids belong to that vein group. Only the groups
 *  whose members are NOT already a substring of the intent need listing; e.g. "gold" needs no entry
 *  because gold_ore/raw_gold/deepslate_gold_ore all contain "gold". Mirrors the prospector's
 *  PROSPECT_ORE_GROUPS intent → material grouping (ext.js). */
import { idPath } from "@/core/prim/pos";

const ORE_GROUP_ALIASES: Readonly<Record<string, readonly string[]>> = {
  iron: [
    "magnetite",
    "hematite",
    "goethite",
    "limonite",
    "pyrite",
    "banded_iron",
    "yellow_limonite",
    "brown_limonite",
  ],
  copper: [
    "copper",
    "chalcopyrite",
    "malachite",
    "tetrahedrite",
    "chalcocite",
    "bornite",
    "azurite",
  ],
  silver: ["silver", "galena", "argentite"],
  lead: ["lead", "galena"],
  nickel: ["nickel", "garnierite", "pentlandite", "cobaltite"],
  tin: ["tin", "cassiterite"],
  zinc: ["zinc", "sphalerite"],
  redstone: ["redstone", "cinnabar"],
};

/** Strip namespace + the ore-block decorations so we compare bare material stems:
 *  `gtceu:deepslate_gold_ore` → `gold`, `minecraft:raw_iron` → `iron`. */
function oreStem(id: string): string {
  let s = idPath(id);
  s = s
    .replace(/^deepslate_/, "")
    .replace(/^nether_/, "")
    .replace(/^raw_/, "");
  s = s.replace(/_ore$/, "").replace(/_block$/, "");
  return s;
}

/**
 * Does block `id` belong to the requested ore `group`? `group` is the intent word ("gold", "iron").
 * Alias-listed groups match by their member stems; everything else falls back to a substring of the
 * normalized stem (so "gold" matches gold_ore/raw_gold/deepslate_gold_ore). Case-insensitive.
 */
export function oreMatchesGroup(id: string, group: string): boolean {
  const g = group.trim().toLowerCase();
  if (!g) return true; // no group requested → don't constrain
  const stem = oreStem(id.toLowerCase());
  // The intent word itself always matches (vanilla iron_ore / gold_ore, the GTCEu gold_ore) — the
  // alias table EXTENDS this with the member minerals whose id doesn't contain the intent (magnetite
  // for iron, galena for silver/lead), it does not replace it.
  if (stem.includes(g)) return true;
  const aliases = ORE_GROUP_ALIASES[g];
  return aliases ? aliases.some((a) => stem.includes(a)) : false;
}
