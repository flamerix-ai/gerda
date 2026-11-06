import type { Vec3 } from "@/core/runtime/types";
// visibleAimPoint — the stump-aim fix: the break raycast must target an EXPOSED face that
// points at the eye, never tunnel through an occluding neighbor toward the cell centre
// (live: a half-buried stump aimed through its dirt side → the bot dug the dirt).
import { visibleAimPoint } from "@/shared/nav/break-cell";
import { describe, expect, it } from "vitest";

/** World stub: `air` lists the ONLY air cells; everything else is solid. */
function airSet(cells: Vec3[]): (p: Vec3) => boolean | null {
  const keys = new Set(cells.map((c) => `${c.x},${c.y},${c.z}`));
  return (p) => keys.has(`${p.x},${p.y},${p.z}`);
}

describe("visibleAimPoint", () => {
  const stump: Vec3 = { x: 10, y: 64, z: 10 };

  it("half-buried stump: aims at the exposed TOP face, not through the dirt side", () => {
    // Only the top is free; the bot stands beside at eye level looking slightly down.
    const isAir = airSet([{ x: 10, y: 65, z: 10 }]);
    const eye = { x: 8.5, y: 65.62, z: 10.5 }; // 2 west, eyes above the stump top
    const p = visibleAimPoint(isAir, stump, eye);
    expect(p).toEqual({ x: 10.5, y: 64.95, z: 10.5 }); // top face point, inside the face plane
  });

  it("prefers the free side face TOWARD the eye over an exposed far side", () => {
    // West face (toward the eye) and east face (away) both free; top buried.
    const isAir = airSet([
      { x: 9, y: 64, z: 10 },
      { x: 11, y: 64, z: 10 },
    ]);
    const eye = { x: 8.5, y: 64.62, z: 10.5 };
    const p = visibleAimPoint(isAir, stump, eye);
    expect(p.x).toBeCloseTo(10.05); // west face point (10.5 − 0.45)
    expect(p.y).toBeCloseTo(64.5);
  });

  it("falls back to the cell centre when fully buried (vein-interior behavior unchanged)", () => {
    const isAir = airSet([]);
    const eye = { x: 8.5, y: 65.62, z: 10.5 };
    expect(visibleAimPoint(isAir, stump, eye)).toEqual({ x: 10.5, y: 64.5, z: 10.5 });
  });

  it("treats an UNKNOWN neighbor as occluded (senses null-convention), not as a free face", () => {
    const isAir = (_p: Vec3): boolean | null => null;
    const eye = { x: 8.5, y: 65.62, z: 10.5 };
    expect(visibleAimPoint(isAir, stump, eye)).toEqual({ x: 10.5, y: 64.5, z: 10.5 });
  });

  it("ignores an exposed face the eye cannot see the outside of (grazing/behind)", () => {
    // Only the BOTTOM face is air (an overhang) while the eye is far above — dot < 0.
    const isAir = airSet([{ x: 10, y: 63, z: 10 }]);
    const eye = { x: 8.5, y: 66.62, z: 10.5 };
    expect(visibleAimPoint(isAir, stump, eye)).toEqual({ x: 10.5, y: 64.5, z: 10.5 });
  });
});
