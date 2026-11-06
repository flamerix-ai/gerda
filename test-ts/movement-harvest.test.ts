import {
  FALL_DISTANCE_CAP_BLOCKS,
  GRAVITY,
  JUMP_ONE_BLOCK_TICKS,
  SPRINT_MULTIPLIER,
  TERMINAL_FALL_SPEED,
  VERTICAL_DRAG,
  WALK_ONE_BLOCK_TICKS,
  canSurviveFall,
  fallDamageHealthPoints,
  fallTicks,
  fallVelocity,
} from "@/core/prim/movement-physics";
// Locks the movement constants/formulas to the vanilla rules they are derived from, so they
// can't silently drift. Pure data — no runtime.
import { classifyBlock } from "@/shared/domain/block-traits";
import { describe, expect, it } from "vitest";

/** Reference: a fall from rest simulated tick by tick with the vanilla LivingEntity.travel rule —
 *  move by the current vertical speed, then `vy ← (vy − g) · d`. Returns the ticks to cover
 *  `distance` (last tick fractional) and the per-tick moves. Deliberately the plain recurrence,
 *  not the closed form the module uses. */
function vanillaFall(distance: number, g: number, d: number): { ticks: number; moves: number[] } {
  let vy = 0;
  let remaining = distance;
  const moves: number[] = [];
  for (let t = 0; t < 10_000; t++) {
    const step = -vy;
    moves.push(step);
    if (remaining <= step) return { ticks: t + remaining / step, moves };
    remaining -= step;
    vy = (vy - g) * d;
  }
  throw new Error("reference fall did not converge");
}

// Short hops to a full world-height drop (-64..320), fractional and whole.
const DISTANCES = [0.25, 1, 1.25, 2, 3, 3.5, 10, 23, 50, 150, 384];

/** Does the module agree with the vanilla recurrence run with gravity `g` and drag `d`? */
function agreesWithVanilla(g: number, d: number): boolean {
  return DISTANCES.every((dist) => {
    const ref = vanillaFall(dist, g, d);
    const movesMatch = ref.moves.every((m, t) => Math.abs(fallVelocity(t) - m) < 1e-9);
    return movesMatch && Math.abs(fallTicks(dist) - ref.ticks) < 1e-9;
  });
}

describe("movement-physics constants (vanilla player speeds)", () => {
  it("walk-one-block ≈ 4.633 ticks (20 / 4.317)", () => {
    expect(WALK_ONE_BLOCK_TICKS).toBeCloseTo(4.633, 3);
  });
  it("sprint multiplier ≈ 0.769", () => {
    expect(SPRINT_MULTIPLIER).toBeCloseTo(0.769, 3);
  });
});

describe("fall physics = the vanilla LivingEntity.travel recurrence", () => {
  it("terminal speed is the recurrence's fixed point g·d/(1−d)", () => {
    expect(TERMINAL_FALL_SPEED).toBeCloseTo((GRAVITY * VERTICAL_DRAG) / (1 - VERTICAL_DRAG), 12);
  });
  it("fallVelocity and fallTicks match a tick-by-tick vanilla simulation", () => {
    expect(agreesWithVanilla(0.08, 0.98)).toBe(true);
  });
  it("neg-control: a reference with the wrong drag or gravity disagrees", () => {
    expect(agreesWithVanilla(0.08, 0.99)).toBe(false);
    expect(agreesWithVanilla(0.09, 0.98)).toBe(false);
  });
  it("tick 0 moves nothing, tick 1 moves g·d", () => {
    expect(fallVelocity(0)).toBeCloseTo(0, 12);
    expect(fallVelocity(1)).toBeCloseTo(0.08 * 0.98, 12);
  });
  it("pins the costs the planner reads (numbers unchanged by the re-derivation)", () => {
    expect(fallTicks(0)).toBe(0);
    expect(fallTicks(1)).toBeCloseTo(5.61472409063782, 12);
    expect(fallTicks(10)).toBeCloseTo(17.292185961139936, 12);
    expect(fallTicks(384)).toBeCloseTo(145.30394935870862, 12);
    expect(JUMP_ONE_BLOCK_TICKS).toBeCloseTo(3.1633972480987405, 12);
  });
  it("a non-finite distance or one above the cap is a contract violation, not a hang", () => {
    expect(FALL_DISTANCE_CAP_BLOCKS).toBe(4096);
    expect(() => fallTicks(Number.NaN)).toThrow(/non-finite/);
    expect(() => fallTicks(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => fallTicks(FALL_DISTANCE_CAP_BLOCKS + 1)).toThrow(/above 4096/);
    expect(() => fallTicks(1e12)).toThrow(/above 4096/);
  });
  it("known-good: the cap itself is still answered", () => {
    expect(Number.isFinite(fallTicks(FALL_DISTANCE_CAP_BLOCKS))).toBe(true);
  });
});

describe("fallDamageHealthPoints (vanilla safe-fall 3)", () => {
  it("a 3-block drop is harmless, 4 costs 1, 23 nearly kills", () => {
    expect(fallDamageHealthPoints(3, false)).toBe(0);
    expect(fallDamageHealthPoints(4, false)).toBe(1);
    expect(fallDamageHealthPoints(23, false)).toBe(20);
  });
  it("water below cancels fall damage", () => {
    expect(fallDamageHealthPoints(50, true)).toBe(0);
  });
});

describe("canSurviveFall (unified fall-safety SSOT: safeFall ∨ waterBelow ∨ clutch)", () => {
  it("unaided: survives within tolerance, not beyond (default maxFallDamage 0 ⇒ ≤3 blocks)", () => {
    expect(canSurviveFall(3, { maxFallDamage: 0 })).toBe(true); // 0 damage
    expect(canSurviveFall(4, { maxFallDamage: 0 })).toBe(false); // 1 damage > 0
    expect(canSurviveFall(6, { maxFallDamage: 3 })).toBe(true); // 3 damage ≤ 3
  });
  it("water below negates any fall", () => {
    expect(canSurviveFall(50, { maxFallDamage: 0, waterBelow: true })).toBe(true);
  });
  it("clutch (bucket carried) negates any finite fall — the geofence can't veto what the clutch saves", () => {
    expect(canSurviveFall(50, { maxFallDamage: 0, clutch: true })).toBe(true);
    expect(canSurviveFall(100, { maxFallDamage: 0, clutch: true })).toBe(true);
  });
  it("without the clutch capability, a fatal drop is refused (default geofence stays conservative)", () => {
    expect(canSurviveFall(50, { maxFallDamage: 0, clutch: false })).toBe(false);
  });
});

describe("classifyBlock (MovementHelper special cases)", () => {
  it("flags hazards", () => {
    expect(classifyBlock("minecraft:lava").hazard).toBe(true);
    const web = classifyBlock("minecraft:cobweb");
    expect(web.hazard).toBe(true);
    expect(web.impedes).toBe(true);
  });
  it("soul sand is standable but impedes", () => {
    const ss = classifyBlock("minecraft:soul_sand");
    expect(ss.standable).toBe(true);
    expect(ss.impedes).toBe(true);
  });
  it("classifies non-cube standable families", () => {
    expect(classifyBlock("minecraft:oak_stairs").standable).toBe(true);
    const slab = classifyBlock("minecraft:stone_slab");
    expect(slab.standable).toBe(true);
    expect(slab.impedes).toBe(true);
  });
  it("air is passable and known; ordinary blocks are unknown (runtime-resolved)", () => {
    expect(classifyBlock("minecraft:air")).toMatchObject({ passable: true, known: true });
    expect(classifyBlock("minecraft:stone").known).toBe(false);
    expect(classifyBlock("modded:weird_ore").known).toBe(false);
  });
  it("doors: openable passable, iron door impassable", () => {
    expect(classifyBlock("minecraft:oak_door").passable).toBe(true);
    expect(classifyBlock("minecraft:iron_door").impedes).toBe(true);
  });
});
