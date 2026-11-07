// Block traits — the walkability SPECIAL CASES as a data table: the navigator's knowledge of
// "which blocks behave oddly". The list of cases is informed by Baritone's MovementHelper (see
// NOTICE); the table itself is our own.
//
// SCOPE — intentionally only the special cases. Whether an ORDINARY block is a solid
// full cube you can stand on (stone, dirt, ore, …) is decided LIVE from the block state
// at runtime (Baritone: isBlockNormalCube / isPathfindable) — it can't be answered from a
// block id alone, so those return `known: false` here and the runtime world-view resolves
// them. What IS captured: hazards to refuse, things that look passable but aren't, things
// that impede movement, and non-full-cube surfaces that are still standable.
import { idPath } from "@/core/prim/pos";

export interface BlockTraits {
  /** Walking INTO / standing IN this hurts or traps — the navigator must refuse the cell.
   *  From MovementHelper.avoidWalkingInto (:384) + the powder-snow / fire special cases. */
  readonly hazard: boolean;
  /** The player can move THROUGH this block's space. air = yes; openable doors/fence gates
   *  count (Baritone right-clicks them). From canWalkThroughBlockState YES (:138). */
  readonly passable: boolean;
  /** Looks small/passable but you CANNOT walk through it, or it slows you. cobweb, slabs,
   *  trapdoors, skulls, soul sand, vines… From canWalkThroughBlockState NO (:143) +
   *  the soul-sand / cobweb cost cases. */
  readonly impedes: boolean;
  /** A surface you can stand on TOP of despite not being a plain full cube (slabs, stairs,
   *  chests, glass, farmland, soul sand, ladder…). From canWalkOnBlockState (:421). */
  readonly standable: boolean;
  /** True only when this id matched a Baritone special case. `false` = an ordinary block
   *  whose solidity/standability must be resolved live from its block state. */
  readonly known: boolean;
}

/** Lethal / trapping to enter — MovementHelper.avoidWalkingInto (:384-394) plus powder snow
 *  and fire (canWalkThroughBlockState NO, :143-151). Water is deliberately NOT here: Baritone
 *  "avoids" it for control but it isn't lethal — that's a separate concern. */
export const HAZARD_IDS: ReadonlySet<string> = new Set([
  "lava",
  "fire",
  "soul_fire",
  "cactus",
  "sweet_berry_bush",
  "magma_block",
  "cobweb",
  "bubble_column",
  "end_portal",
  "powder_snow",
  "wither_rose",
  "pointed_dripstone",
]);

/** Slows or blocks passage despite a small hitbox — cobweb/vine impede, soul sand drags
 *  (ActionCosts.WALK_ONE_OVER_SOUL_SAND_COST). */
export const IMPEDES_IDS: ReadonlySet<string> = new Set(["cobweb", "vine", "soul_sand"]);

/** Solid blocks a miner can NOT (or must not) break through to make a path — unbreakable
 *  (bedrock/barrier) or liquids that would just reflow into the hole. Lava/fire are already in
 *  HAZARD_IDS; water is added here since it isn't a hazard but mining it is pointless. The planner's
 *  {@link breakableSolid} (senses) refuses these so a mine-move never tunnels into them. */
export const UNMINEABLE_IDS: ReadonlySet<string> = new Set([
  "bedrock",
  "barrier",
  "command_block",
  "chain_command_block",
  "repeating_command_block",
  "structure_block",
  "structure_void",
  "jigsaw",
  "end_portal_frame",
  "reinforced_deepslate",
  "water",
  "lava",
  "flowing_water",
  "flowing_lava",
]);

/** Water source / flow — for "did I land safely IN water" checks (fall-survival). Exact ids,
 *  NOT a substring sniff: `id.includes("water")` would also match water_bucket and any modded
 *  *_water item, so a typed set is the fail-loud choice. */
export const WATER_IDS: ReadonlySet<string> = new Set(["water", "flowing_water"]);
export function isWater(id: string): boolean {
  return WATER_IDS.has(idPath(id));
}

/** Non-full-cube surfaces Baritone still stands on — canWalkOnBlockState (:432-443). */
export const STANDABLE_SPECIAL_IDS: ReadonlySet<string> = new Set([
  "farmland",
  "dirt_path",
  "soul_sand",
  "ladder",
  "chest",
  "trapped_chest",
  "ender_chest",
  "glass",
]);

/** Common non-solid decorations a player walks straight through (grass, flowers, torches,
 *  rails, redstone). Baritone resolves these live via isPathfindable; we pre-list the
 *  frequent ones so senses don't mistake a flower for a wall. The long tail stays unknown
 *  (treated conservatively as solid by senses) — safe, just occasionally over-cautious. */
export const PASSABLE_IDS: ReadonlySet<string> = new Set([
  "short_grass",
  "grass",
  "tall_grass",
  "fern",
  "large_fern",
  "dead_bush",
  "seagrass",
  "tall_seagrass",
  "kelp",
  "kelp_plant",
  "sugar_cane",
  "dandelion",
  "poppy",
  "cornflower",
  "torch",
  "wall_torch",
  "soul_torch",
  "soul_wall_torch",
  "redstone_torch",
  "redstone_wire",
  "rail",
  "powered_rail",
  "detector_rail",
  "activator_rail",
  "lever",
  "tripwire",
  "snow", // top snow layer (thin) — Baritone canWalkThroughPosition allows <3 layers
]);

/** Climbable blocks — a body in this cell clings and can travel UP/DOWN it without a floor
 *  (vanilla LivingEntity.onClimbable / `BlockTags.CLIMBABLE`). The navigator's ladder moves
 *  read this directly (not the standable/passable traits): a ladder is also `standable` (you
 *  can stand on its top, STANDABLE_SPECIAL_IDS) but the climb mechanic is the point here.
 *  Vines/scaffolding climb the same way; twisting/weeping vines are the nether's ladders. */
export const CLIMBABLE_IDS: ReadonlySet<string> = new Set([
  "ladder",
  "vine",
  "scaffolding",
  "twisting_vines",
  "twisting_vines_plant",
  "weeping_vines",
  "weeping_vines_plant",
]);

/** Looks passable but is NOT walk-through — canWalkThroughBlockState NO (:143-151). The
 *  family suffixes (slabs, trapdoors, skulls, shulker boxes, amethyst) are handled in
 *  {@link classifyBlock} via suffix match. */
export const IMPASSABLE_SPECIAL_IDS: ReadonlySet<string> = new Set([
  "cocoa",
  "honey_block",
  "end_rod",
  "big_dripleaf",
  "iron_door", // the one door Baritone won't open
]);

/** Block-id suffixes that classify a whole family at once (the `instanceof` checks in
 *  MovementHelper). [suffix, partial traits] — merged over the defaults. */
const FAMILY_SUFFIXES: readonly [string, Partial<BlockTraits>][] = [
  // canWalkOnBlockState: stairs always standable (:441); slabs standable but the *bottom*
  // slab depends on a runtime state value (SlabBlock.TYPE) → standable, impedes walk-through.
  ["_stairs", { standable: true }],
  ["_slab", { standable: true, impedes: true }],
  ["_stained_glass", { standable: true }],
  // canWalkThroughBlockState: openable doors / fence gates are passable (right-clicked);
  // iron_door handled as an explicit impassable id above.
  ["_fence_gate", { passable: true }],
  ["_door", { passable: true }],
  // NO in canWalkThroughBlockState — can't pass through.
  ["_trapdoor", { impedes: true }],
  ["_shulker_box", { impedes: true }],
  ["_skull", { impedes: true }],
  ["_head", { impedes: true }],
  ["_amethyst_cluster", { impedes: true }],
  // carpets: walk-through depends on the block below (canWalkThroughPosition :196) — mark
  // impedes so the navigator resolves the support live rather than trusting a static yes.
  ["_carpet", { impedes: true }],
  // passable decoration families.
  ["_sapling", { passable: true }],
  ["_button", { passable: true }],
  ["_pressure_plate", { passable: true }],
];

const NONE: BlockTraits = {
  hazard: false,
  passable: false,
  impedes: false,
  standable: false,
  known: false,
};

/**
 * Classify a block id into its Baritone-derived special-case traits. Unknown / ordinary
 * blocks return `known: false` (the runtime world-view must resolve full-cube solidity).
 * Pure + id-only; never throws.
 */
export function classifyBlock(id: string): BlockTraits {
  const p = idPath(id);
  if (p === "air" || p === "cave_air" || p === "void_air") {
    return { hazard: false, passable: true, impedes: false, standable: false, known: true };
  }

  let t: BlockTraits | null = null;
  const mark = (patch: Partial<BlockTraits>): void => {
    t = { ...(t ?? NONE), ...patch, known: true };
  };

  if (HAZARD_IDS.has(p)) mark({ hazard: true });
  if (IMPEDES_IDS.has(p)) mark({ impedes: true });
  if (PASSABLE_IDS.has(p)) mark({ passable: true });
  if (STANDABLE_SPECIAL_IDS.has(p)) mark({ standable: true });
  if (IMPASSABLE_SPECIAL_IDS.has(p)) mark({ impedes: true });
  for (const [suffix, patch] of FAMILY_SUFFIXES) {
    if (p.endsWith(suffix)) mark(patch);
  }

  return t ?? NONE;
}
