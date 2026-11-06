// Movement physics — game-INVARIANT constants + pure formulas the navigator plans and the
// executor/fall-safety checks run against. NOT config: these are facts of vanilla MC 1.20.1
// physics, not pack-tunable knobs, so they live here as cited constants rather than in
// src/shared/config/schema.ts. Imported by the planner's move costs, the goal heuristic, the
// eye-height readers and the fall-safety vetoes.
//
// The constants come from the per-tick motion rules of net.minecraft.world.entity.{Entity,
// LivingEntity} and the measured player speeds. Treating costs as "roughly in ticks" follows
// the cost model of Baritone (see NOTICE); the formulas below are derived from the vanilla
// motion rules.

import { ContractError } from "@/core/prim/invariant";

/** Costs are in ticks. 20 ticks = 1 second. */

// — locomotion speeds (blocks/second): vanilla player ground speeds, as measured in game —
/** Walking speed. */
export const WALK_SPEED_BPS = 4.317;
/** Sprinting speed. */
export const SPRINT_SPEED_BPS = 5.612;

// — per-block move costs in ticks —
export const WALK_ONE_BLOCK_TICKS = 20 / WALK_SPEED_BPS; // ≈ 4.633
export const SPRINT_ONE_BLOCK_TICKS = 20 / SPRINT_SPEED_BPS; // ≈ 3.564
/** Sprint/walk cost ratio ≈ 0.769. */
export const SPRINT_MULTIPLIER = SPRINT_ONE_BLOCK_TICKS / WALK_ONE_BLOCK_TICKS;

// — vertical physics (vanilla LivingEntity.travel) —
/** Apex of a flat jump ≈ 1.25 blocks (vanilla jump power 0.42 b/tick under the fall rule
 *  below peaks at ≈ 1.2522); the player auto-steps the last 0.25 onto a +1 block. */
export const JUMP_PEAK_BLOCKS = 1.25;
/** Standing player eye height above the feet (blocks). Vanilla Player.getStandingEyeHeight ≈ 1.62;
 *  the point every raycast/lookAt originates from. A physics invariant, not a tunable — so it lives
 *  here, imported by the break-cell aimer and both Runtime impls' eye() reads. */
export const EYE_HEIGHT = 1.62;
/** Downward gravity (blocks/tick²) that LivingEntity.travel subtracts from the vertical speed
 *  every airborne tick. */
export const GRAVITY = 0.08;
/** Air drag that LivingEntity.travel multiplies the vertical speed by every tick. */
export const VERTICAL_DRAG = 0.98;
/** Terminal fall speed (blocks/tick): the fixed point of the vanilla rule
 *  `vy ← (vy − GRAVITY) · VERTICAL_DRAG`, i.e. GRAVITY·VERTICAL_DRAG / (1 − VERTICAL_DRAG)
 *  = 0.0784 / 0.02 = 3.92. Written as the exact decimal (the quotient in floating point is
 *  3.9199999999999964); a test pins it to the quotient. */
export const TERMINAL_FALL_SPEED = 3.92;

/** Below this fall, no damage. Vanilla safe-fall = 3 blocks (LivingEntity.calculateFallDamage
 *  subtracts 3.0). */
export const SAFE_FALL_BLOCKS = 3;

/**
 * Downward speed (blocks/tick) during tick `t` of a fall from rest. Vanilla LivingEntity.travel
 * moves the entity by its current vertical speed, THEN updates it: `vy ← (vy − g) · d`. From
 * vy₀ = 0 the recurrence has the closed form |vyₜ| = v∞ · (1 − dᵗ), v∞ = TERMINAL_FALL_SPEED —
 * so tick 0 moves 0 blocks and tick 1 moves g·d = 0.0784. Pure; used by {@link fallTicks}.
 */
export function fallVelocity(ticks: number): number {
  return (VERTICAL_DRAG ** ticks - 1) * -TERMINAL_FALL_SPEED;
}

/** Sanity cap on a {@link fallTicks} distance: far above the 1.20 world height (384 blocks);
 *  not a vanilla constant. */
export const FALL_DISTANCE_CAP_BLOCKS = 4096;

/**
 * Ticks to fall `distance` blocks from rest: sum the per-tick moves of {@link fallVelocity}
 * until they cover the distance, the last tick counted fractionally. The loop bound follows from
 * the physics: every move from tick 1 on is ≥ fallVelocity(1) = g·d = 0.0784 blocks, so no finite
 * distance needs more than 1 + ⌈distance / fallVelocity(1)⌉ ticks. A non-finite distance, or one
 * above {@link FALL_DISTANCE_CAP_BLOCKS}, throws.
 */
export function fallTicks(distance: number): number {
  if (!Number.isFinite(distance) || distance > FALL_DISTANCE_CAP_BLOCKS) {
    throw new ContractError(
      `fallTicks: distance ${distance} is non-finite or above ${FALL_DISTANCE_CAP_BLOCKS}`,
    );
  }
  if (distance <= 0) return 0;
  const maxTicks = 1 + Math.ceil(distance / fallVelocity(1));
  let remaining = distance;
  for (let tick = 0; tick <= maxTicks; tick++) {
    const step = fallVelocity(tick);
    if (remaining <= step) return tick + remaining / step;
    remaining -= step;
  }
  throw new ContractError(`fallTicks: ${distance} blocks not covered in ${maxTicks} ticks`);
}

/**
 * Vanilla fall damage in HEALTH POINTS (20 = full bar; 1 point = half a heart) for a drop
 * of `dropBlocks`, the input the future step-hazard veto reads to refuse a lethal step.
 * MC LivingEntity.calculateFallDamage: ceil(fallDistance − 3) at damageMultiplier 1 (armor /
 * feather-falling reduction NOT modelled — this is the conservative pre-mitigation number).
 * Water below cancels fall damage entirely (MC resets fallDistance in liquid).
 */
export function fallDamageHealthPoints(dropBlocks: number, hasWaterBelow: boolean): number {
  if (hasWaterBelow) return 0;
  return Math.max(0, Math.ceil(dropBlocks - SAFE_FALL_BLOCKS));
}

/** Capabilities that make a fall survivable beyond the bare damage tolerance. Callers pass the
 *  ones that actually apply in their context (see {@link canSurviveFall}). */
export interface FallSurvival {
  /** Health points of fall damage tolerated (0 = refuse any damaging drop). */
  readonly maxFallDamage: number;
  /** Landing cell is water — MC resets fallDistance in liquid, so ALL fall damage is negated. */
  readonly waterBelow?: boolean;
  /** An emergency water-clutch is available (clutch enabled AND a water bucket is carried): the
   *  bot can MLG-place water at the bottom and negate ANY finite fall. This is the composition
   *  point the design hinges on — a fall-geofence built on this predicate can NEVER veto a fall
   *  the clutch would save. The PLANNER's cheap drop move deliberately passes this OFF (a clutch
   *  dive is a separate, costed move — waterDrop); the EXECUTOR's safety veto passes it ON, gated
   *  on the same bucket check the planner uses, so planner and executor stay in lockstep. */
  readonly clutch?: boolean;
}

/** SINGLE SOURCE OF TRUTH for "will the bot survive a `drop`-block fall?" — folds the scattered
 *  `fallDamageHealthPoints(...) <= maxFallDamage` checks (planner moves + the executor step veto)
 *  into one named predicate: safeFall ∨ waterBelow ∨ clutch. NOTE: `drop` must be a FINITE fall to
 *  a real floor — a bottomless void is never survivable (water/clutch negate damage, not a missing
 *  floor), so callers must confirm the landing exists (groundUnder ≠ null) BEFORE asking this. */
export function canSurviveFall(dropBlocks: number, cap: FallSurvival): boolean {
  if (cap.clutch) return true; // MLG water negates any finite fall
  return fallDamageHealthPoints(dropBlocks, cap.waterBelow ?? false) <= cap.maxFallDamage;
}

/** Ladder/vine climb speed (blocks/tick). Vanilla LivingEntity.handleRelativeFrictionAndCalculateMovement
 *  clamps vertical climb motion to 0.15 b/tick when on a climbable and pressing into it (the
 *  `climbUp` path); ascending one block therefore takes ~1/0.15 ticks. A descent is the same
 *  magnitude. */
export const LADDER_CLIMB_SPEED_BPT = 0.15;
/** Ticks to climb ONE block of ladder/vine — the cost of a ladderEnter/ladderUp/ladderDown move.
 *  ≈ 6.67 ticks: cheaper than a pillarUp (jump + the 20-tick placement penalty) so a ladder always
 *  wins where one exists, and cheaper than mining a stair up, but dearer than a flat walk so the
 *  planner only climbs when the route genuinely goes up a ladder. */
export const LADDER_ONE_BLOCK_TICKS = 1 / LADDER_CLIMB_SPEED_BPT;

/** Ticks for a flat 1-block jump (the cost of a stepUp move) = fall(1.25) − fall(0.25): the leap
 *  peaks at JUMP_PEAK_BLOCKS, and the rise is modelled as the falling arc run backwards — the
 *  rise 0 → 1.25 as fall(1.25) and its last part 1 → 1.25 as fall(0.25), so the 0 → 1 part is
 *  the difference. An approximation: drag makes the real rise slightly faster. */
export const JUMP_ONE_BLOCK_TICKS = fallTicks(JUMP_PEAK_BLOCKS) - fallTicks(JUMP_PEAK_BLOCKS - 1);
