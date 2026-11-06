import type { Vec3 } from "@/core/runtime/types";
// excavate planner — pure geometry of strip-mining a vein volume.
import { type ExcavateBounds, planExcavation } from "@/shared/domain/excavate";
import { describe, expect, it } from "vitest";

const base: ExcavateBounds = {
  center: { x: 10, y: 60, z: 20 },
  bbox: [8, 18, 12, 22], // 5×5 footprint columns
  maxRadius: 8,
  bandHeight: 4,
  rowSpacing: 2,
  levelSpacing: 2,
  maxCells: 10_000,
};

const key = (c: Vec3) => `${c.x}|${c.y}|${c.z}`;

describe("planExcavation", () => {
  it("covers the whole clamped footprint × Y-band (every corridor column present)", () => {
    const plan = planExcavation(base);
    expect(plan.truncated).toBe(false);
    expect(plan.box).toEqual({ minX: 8, maxX: 12, minZ: 18, maxZ: 22 });
    // Levels: y = 60,58,56 (anchor 60 down to 56 = 60−bandHeight, step 2).
    const ys = [...new Set(plan.cells.map((c) => c.y))].sort((a, b) => b - a);
    expect(ys).toEqual([60, 58, 56]);
    // Corridor rows at z = 18,20,22 (spacing 2, far edge 22 included).
    const zs = [...new Set(plan.cells.map((c) => c.z))].sort((a, b) => a - b);
    expect(zs).toEqual([18, 20, 22]);
    // Every X in the footprint is dug on each corridor row.
    const xs = [...new Set(plan.cells.map((c) => c.x))].sort((a, b) => a - b);
    expect(xs).toEqual([8, 9, 10, 11, 12]);
  });

  it("is deterministic", () => {
    expect(planExcavation(base).cells).toEqual(planExcavation(base).cells);
  });

  it("emits no duplicate cells", () => {
    const plan = planExcavation(base);
    expect(new Set(plan.cells.map(key)).size).toBe(plan.cells.length);
  });

  it("serpentines — consecutive cells stay adjacent (short connectors, no big jumps)", () => {
    const plan = planExcavation(base);
    for (let i = 1; i < plan.cells.length; i++) {
      const a = plan.cells[i - 1] as Vec3;
      const b = plan.cells[i] as Vec3;
      const step = Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);
      expect(step).toBeLessThanOrEqual(base.rowSpacing + base.levelSpacing);
    }
  });

  it("clamps a huge bbox to maxRadius", () => {
    const plan = planExcavation({ ...base, bbox: [-500, -500, 500, 500], maxRadius: 3 });
    expect(plan.box).toEqual({ minX: 7, maxX: 13, minZ: 17, maxZ: 23 });
  });

  it("falls back to a maxRadius box when bbox is absent", () => {
    const plan = planExcavation({ ...base, bbox: undefined, maxRadius: 2 });
    expect(plan.box).toEqual({ minX: 8, maxX: 12, minZ: 18, maxZ: 22 });
  });

  it("truncates at maxCells and flags it", () => {
    const plan = planExcavation({ ...base, maxCells: 7 });
    expect(plan.truncated).toBe(true);
    expect(plan.cells.length).toBe(7);
  });

  it("always covers at least the anchor column for a degenerate bbox", () => {
    const plan = planExcavation({
      ...base,
      bbox: [100, 100, 101, 101], // disjoint from the maxRadius box around center
      maxRadius: 1,
    });
    // Intersection is empty → falls back to the anchor column only.
    expect(plan.box).toEqual({ minX: 10, maxX: 10, minZ: 20, maxZ: 20 });
    expect(plan.cells.some((c) => c.x === 10 && c.z === 20)).toBe(true);
  });
});
