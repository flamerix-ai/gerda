import { WALK_ONE_BLOCK_TICKS } from "@/core/prim/movement-physics";
// Goal abstraction — the key property is GoalXZ ignoring Y in BOTH the
// heuristic and the arrival test, which is what fixes the walk-to-vein altitude-chase wander.
import { GoalBlock, GoalNear, GoalXZ, octileXZ } from "@/shared/domain/goal";
import { describe, expect, it } from "vitest";

describe("octileXZ", () => {
  // The previous straight/diagonal form, kept here as the reference the current body must match.
  const reference = (dx: number, dz: number): number => {
    const x = Math.abs(dx);
    const z = Math.abs(dz);
    const straight = x < z ? z - x : x - z;
    const diagonal = x < z ? x : z;
    return (diagonal * Math.SQRT2 + straight) * WALK_ONE_BLOCK_TICKS;
  };
  const pairs: [number, number][] = [
    [0, 0],
    [0, 5],
    [3, 7],
    [7, 3],
    [5, 5],
    [-4, 9],
    [12, -1],
    [-6, -6],
    [2.5, 0.75],
  ];
  it.each(pairs)("returns the same number as the straight/diagonal form at (%s, %s)", (dx, dz) => {
    expect(octileXZ(dx, dz)).toBe(reference(dx, dz));
  });
  it("independent oracle: (3, 7) is 4 straight + 3 diagonal blocks", () => {
    // Exact: 7 − 3 and 3·√2 are the same IEEE operations the body performs, in any order.
    expect(octileXZ(3, 7)).toBe((4 + 3 * Math.SQRT2) * WALK_ONE_BLOCK_TICKS);
  });
  it("independent oracle: (-7, 3) — the x-dominant, negative-dx octant — is 4 straight + 3 diagonal", () => {
    expect(octileXZ(-7, 3)).toBe((4 + 3 * Math.SQRT2) * WALK_ONE_BLOCK_TICKS);
  });
  it("neg-control: a Manhattan reference differs off the axes", () => {
    expect(octileXZ(3, 7)).not.toBe((3 + 7) * WALK_ONE_BLOCK_TICKS);
  });
});

describe("GoalXZ", () => {
  it("ignores Y entirely — heuristic identical at any height", () => {
    const g = new GoalXZ(10, 0);
    const low = g.heuristic({ x: 0, y: 5, z: 0 });
    const high = g.heuristic({ x: 0, y: 200, z: 0 });
    expect(high).toBe(low); // a goal Y 195 blocks away changes nothing
  });

  it("arrives on the column regardless of Y (the descend then owns digging down)", () => {
    const g = new GoalXZ(10, 4);
    expect(g.isInGoal({ x: 10, y: 64, z: 4 })).toBe(true);
    expect(g.isInGoal({ x: 10, y: 11, z: 4 })).toBe(true); // 53 blocks below — still "in goal"
    expect(g.isInGoal({ x: 11, y: 64, z: 4 })).toBe(false); // wrong column
  });

  it("uses octile distance — a straight run costs walk-per-block", () => {
    const g = new GoalXZ(5, 0);
    expect(g.heuristic({ x: 0, y: 0, z: 0 })).toBeCloseTo(5 * WALK_ONE_BLOCK_TICKS, 6);
  });

  it("octile: a pure diagonal is √2 per block, cheaper than manhattan", () => {
    const g = new GoalXZ(5, 5);
    expect(g.heuristic({ x: 0, y: 0, z: 0 })).toBeCloseTo(5 * Math.SQRT2 * WALK_ONE_BLOCK_TICKS, 6);
  });
});

describe("GoalBlock", () => {
  it("includes Y — a vertical gap raises the heuristic and blocks arrival", () => {
    const g = new GoalBlock({ x: 0, y: 70, z: 0 });
    expect(g.heuristic({ x: 0, y: 64, z: 0 })).toBeCloseTo(6 * WALK_ONE_BLOCK_TICKS, 6);
    expect(g.isInGoal({ x: 0, y: 64, z: 0 })).toBe(false);
    expect(g.isInGoal({ x: 0, y: 70, z: 0 })).toBe(true);
  });
});

describe("GoalNear", () => {
  it("arrives within the radius (3D)", () => {
    const g = new GoalNear({ x: 0, y: 64, z: 0 }, 2.5);
    expect(g.isInGoal({ x: 2, y: 64, z: 0 })).toBe(true); // dist 2 ≤ 2.5
    expect(g.isInGoal({ x: 2, y: 64, z: 2 })).toBe(false); // dist ~2.83 > 2.5
  });
});
