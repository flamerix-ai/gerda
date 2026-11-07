// dig-nav planner — the pure geometry of "mine your way to a stand cell" (3D vein-chase).
import { type DigStep, planDigStep } from "@/shared/domain/dig-nav";
import { describe, expect, it } from "vitest";

const at = (x: number, y: number, z: number) => ({ x, y, z });
const has = (
  cells: readonly { x: number; y: number; z: number }[],
  x: number,
  y: number,
  z: number,
) => cells.some((c) => c.x === x && c.y === y && c.z === z);

describe("planDigStep", () => {
  it("arrived when feet == target", () => {
    expect(planDigStep(at(3, 64, 3), at(3, 64, 3))).toBe("arrived");
  });

  it("steps along the dominant horizontal axis (X over Z on a tie/bigger dx)", () => {
    const p = planDigStep(at(0, 64, 0), at(4, 64, 1)) as DigStep;
    expect(p.next).toEqual(at(1, 64, 0)); // dx=4 dominates dz=1 → step +X, same Y
    expect(p.ascend).toBe(false);
    // clear the cell + its head so greedy can walk in
    expect(has(p.clear, 1, 64, 0)).toBe(true);
    expect(has(p.clear, 1, 65, 0)).toBe(true);
  });

  it("steps along Z when dz dominates", () => {
    const p = planDigStep(at(0, 64, 0), at(1, 64, 5)) as DigStep;
    expect(p.next).toEqual(at(0, 64, 1));
  });

  it("ascends a staircase: +1 Y with a horizontal, clears headroom but NOT the tread", () => {
    const p = planDigStep(at(0, 64, 0), at(3, 67, 0)) as DigStep;
    expect(p.next).toEqual(at(1, 65, 0)); // up-and-over one step
    expect(p.ascend).toBe(true);
    expect(has(p.clear, 1, 65, 0)).toBe(true); // the new feet cell
    expect(has(p.clear, 1, 66, 0)).toBe(true); // its head
    expect(has(p.clear, 0, 66, 0)).toBe(true); // headroom above the current stand (to rise)
    expect(has(p.clear, 1, 64, 0)).toBe(false); // the tread stays solid (greedy lands on it)
  });

  it("descends with a horizontal step", () => {
    const p = planDigStep(at(0, 64, 0), at(3, 61, 0)) as DigStep;
    expect(p.next).toEqual(at(1, 63, 0));
    expect(p.ascend).toBe(false);
  });

  it("straight down: break the floor and drop", () => {
    const p = planDigStep(at(2, 64, 2), at(2, 60, 2)) as DigStep;
    expect(p.next).toEqual(at(2, 63, 2));
    expect(p.clear).toEqual([at(2, 63, 2)]);
  });

  it("straight up is unreachable by digging → needPillar", () => {
    expect(planDigStep(at(2, 64, 2), at(2, 68, 2))).toBe("needPillar");
  });
});
