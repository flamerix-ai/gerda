// Mining speed — how many ticks to break a block with a given tool: the vanilla break-time
// formula (Player.getDestroySpeed + BlockState.getDestroyProgress).
// Pure, jsMacros-free, unit-tested. Three future consumers (not wired here): the planner cost
// function (cost of mining-through vs around), the mine capability (predicted break timeout
// instead of a blind poll), and tooling.ts (tool selection).
//
// IMPORTANT — numbers vs model. The MODEL (multipliers 30/100, efficiency eff²+1, haste/
// fatigue, ×5 water/air, tier speeds) is vanilla-correct and GregTech-independent. The NUMBERS
// that vary per pack — block HARDNESS, tool tier speed/harvest-level for GT tools — are inputs:
// pass real GTCEu hardness in (sourced via `just extract-ores` / read-only reflect later). The
// KNOWN_HARDNESS seed below is only the common vanilla blocks for a baseline + tests.

/** Vanilla tool tier base destroy speed (net.minecraft.world.item.Tiers). Gold is fast but
 *  low harvest-level; this is the `item.getDestroySpeed` value when the tool TYPE matches the
 *  block (else the speed is 1). GregTech materials have their own values — pass them in. */
export const TIER_SPEED: Readonly<Record<string, number>> = {
  wood: 2,
  gold: 12,
  stone: 4,
  iron: 6,
  diamond: 8,
  netherite: 9,
};

/** Vanilla tier harvest level (Tiers.getLevel): used to decide canHarvest for blocks that
 *  require a correct tool. wood/gold=0, stone=1, iron=2, diamond=3, netherite=4. */
export const TIER_LEVEL: Readonly<Record<string, number>> = {
  wood: 0,
  gold: 0,
  stone: 1,
  iron: 2,
  diamond: 3,
  netherite: 4,
};

/** Common vanilla block hardness (destroy speed) for a baseline + tests. NOT exhaustive and
 *  NOT GTCEu-accurate — the model takes hardness as input; this is a convenience fallback. */
export const KNOWN_HARDNESS: Readonly<Record<string, number>> = {
  "minecraft:dirt": 0.5,
  "minecraft:sand": 0.5,
  "minecraft:gravel": 0.6,
  "minecraft:stone": 1.5,
  "minecraft:cobblestone": 2,
  "minecraft:deepslate": 3,
  "minecraft:oak_log": 2,
  "minecraft:iron_ore": 3,
  "minecraft:deepslate_iron_ore": 4.5,
  "minecraft:obsidian": 50,
  "minecraft:bedrock": -1, // unbreakable
};

/** Unbreakable (hardness < 0, e.g. bedrock) → infinite break time. */
export const UNBREAKABLE = Number.POSITIVE_INFINITY;

export interface BreakParams {
  /** Block destroy speed (hardness). < 0 → unbreakable. */
  readonly hardness: number;
  /** Tool's base destroy speed vs this block — a TIER_SPEED value when the tool type matches,
   *  else 1 (bare hand / wrong tool). */
  readonly toolSpeed: number;
  /** Whether the held tool can actually harvest the block (drops): true unless the block
   *  requires a correct tool the player lacks. Gates the 30 vs 100 divisor. */
  readonly canHarvest: boolean;
  /** Efficiency enchant level (0 = none). Only applies when toolSpeed > 1 (a real tool). */
  readonly efficiency?: number;
  /** Haste (DIG_SPEED) effect level, 1 = Haste I (0 = none). */
  readonly hasteLevel?: number;
  /** Mining Fatigue (DIG_SLOWDOWN) effect level, 1 = level I (0 = none). */
  readonly miningFatigueLevel?: number;
  /** False while airborne — vanilla mines 5× slower off the ground. */
  readonly onGround?: boolean;
  /** Submerged without Aqua Affinity — vanilla mines 5× slower underwater. */
  readonly inWaterNoAqua?: boolean;
}

/** Mining Fatigue speed multiplier by level (ToolSet.potionAmplifier: 0.3 / 0.09 / 0.0027 /
 *  0.00081 — yes, 0.0027 not 0.027). */
function fatigueMultiplier(level: number): number {
  switch (level) {
    case 0:
      return 1;
    case 1:
      return 0.3;
    case 2:
      return 0.09;
    case 3:
      return 0.0027;
    default:
      return 0.00081;
  }
}

/**
 * Ticks to break a block (rounded up; 20 ticks = 1s). Direct translation of vanilla
 * Player.getDestroySpeed + ToolSet.calculateSpeedVsBlock: efficiency (eff²+1), haste/fatigue,
 * the ×5 water/air penalties, then `speed / hardness / (canHarvest ? 30 : 100)` = progress per
 * tick → ceil(1/progress). Returns UNBREAKABLE for hardness < 0 or zero progress.
 */
export function breakTicks(p: BreakParams): number {
  if (p.hardness < 0) return UNBREAKABLE;

  let speed = p.toolSpeed;
  const eff = p.efficiency ?? 0;
  if (speed > 1 && eff > 0) speed += eff * eff + 1;

  const haste = p.hasteLevel ?? 0;
  if (haste > 0) speed *= 1 + haste * 0.2;
  speed *= fatigueMultiplier(p.miningFatigueLevel ?? 0);

  if (p.inWaterNoAqua) speed /= 5;
  if (p.onGround === false) speed /= 5;

  if (speed <= 0 || p.hardness === 0) {
    // hardness 0 = instant (e.g. a torch); zero/negative speed = never.
    return p.hardness === 0 ? 1 : UNBREAKABLE;
  }

  const progressPerTick = speed / p.hardness / (p.canHarvest ? 30 : 100);
  if (progressPerTick <= 0) return UNBREAKABLE;
  return Math.ceil(1 / progressPerTick);
}

/** Convenience: break ticks for a block id using the KNOWN_HARDNESS seed (vanilla baseline).
 *  Returns UNBREAKABLE for an unknown id — the caller should supply real hardness via
 *  {@link breakTicks} rather than trust a guess for blocks not in the seed. */
export function breakTicksForKnown(id: string, tool: Omit<BreakParams, "hardness">): number {
  const hardness = KNOWN_HARDNESS[id];
  if (hardness === undefined) return UNBREAKABLE;
  return breakTicks({ ...tool, hardness });
}
