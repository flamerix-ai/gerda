import type { Vec3 } from "@/core/runtime/types";
import { minBy, nearestBy } from "@/shared/domain/select";
import { describe, expect, it } from "vitest";

describe("minBy", () => {
  it("returns null for an empty input", () => {
    expect(minBy([], (n: number) => n)).toBeNull();
  });

  it("picks the item with the smallest score", () => {
    expect(minBy([5, 2, 8, 3], (n) => n)).toBe(2);
  });

  it("scores via the projection, not the item itself", () => {
    const items = [
      { id: "a", w: 9 },
      { id: "b", w: 1 },
      { id: "c", w: 4 },
    ];
    expect(minBy(items, (i) => i.w)?.id).toBe("b");
  });

  it("keeps the FIRST seen on a tie (strict <)", () => {
    const a = { tag: "first", w: 3 };
    const b = { tag: "second", w: 3 };
    expect(minBy([a, b], (i) => i.w)?.tag).toBe("first");
  });

  it("works over a Set (any iterable)", () => {
    expect(minBy(new Set([4, 1, 7]), (n) => n)).toBe(1);
  });

  it("handles a single element", () => {
    expect(minBy([42], (n) => n)).toBe(42);
  });
});

describe("nearestBy", () => {
  const from: Vec3 = { x: 0, y: 0, z: 0 };

  it("returns null for an empty input", () => {
    expect(nearestBy([], from, (v: Vec3) => v)).toBeNull();
  });

  it("picks the nearest by 3-D distance", () => {
    const pts: Vec3[] = [
      { x: 10, y: 0, z: 0 },
      { x: 2, y: 1, z: 0 },
      { x: 5, y: 5, z: 5 },
    ];
    expect(nearestBy(pts, from, (v) => v)).toEqual({ x: 2, y: 1, z: 0 });
  });

  it("projects the position from a wrapper", () => {
    const items = [
      { name: "far", pos: { x: 20, y: 0, z: 0 } },
      { name: "near", pos: { x: 1, y: 0, z: 1 } },
    ];
    expect(nearestBy(items, from, (i) => i.pos)?.name).toBe("near");
  });

  it("respects y in the distance metric", () => {
    const pts: Vec3[] = [
      { x: 3, y: 0, z: 0 }, // dist 3
      { x: 0, y: 2, z: 0 }, // dist 2
    ];
    expect(nearestBy(pts, from, (v) => v)).toEqual({ x: 0, y: 2, z: 0 });
  });

  it("keeps the first seen on an equal distance", () => {
    const pts: Vec3[] = [
      { x: 3, y: 0, z: 0 },
      { x: 0, y: 0, z: 3 },
    ];
    expect(nearestBy(pts, from, (v) => v)).toEqual({ x: 3, y: 0, z: 0 });
  });
});
