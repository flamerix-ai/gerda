import {
  cellCenter,
  decodePos,
  dist,
  dist2,
  encodePos,
  floorVec,
  idPath,
  sameCell,
} from "@/core/prim/pos";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

const vec = () =>
  fc.record({
    x: fc.integer({ min: -5000, max: 5000 }),
    y: fc.integer({ min: -64, max: 320 }),
    z: fc.integer({ min: -5000, max: 5000 }),
  });

describe("pos — key encoding", () => {
  it("encode/decode round-trips integer positions", () => {
    fc.assert(
      fc.property(vec(), (p) => {
        expect(decodePos(encodePos(p.x, p.y, p.z))).toEqual(p);
      }),
    );
  });

  it("rejects malformed keys (fail-loud, no silent NaN)", () => {
    expect(() => decodePos("1,2")).toThrow();
    expect(() => decodePos("1,2,3,4")).toThrow();
  });
});

describe("pos — geometry", () => {
  it("floorVec lands in the cell and is idempotent on integers", () => {
    expect(floorVec({ x: 3.9, y: -0.1, z: 0.5 })).toEqual({ x: 3, y: -1, z: 0 });
    fc.assert(fc.property(vec(), (p) => sameCell(floorVec(p), p)));
  });

  it("cellCenter is the +0.5 centre; floorVec undoes it", () => {
    fc.assert(
      fc.property(vec(), (p) => {
        const c = cellCenter(p);
        expect(c).toEqual({ x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 });
        expect(floorVec(c)).toEqual(p);
      }),
    );
  });

  it("dist is symmetric, zero on identity, and the sqrt of dist2", () => {
    fc.assert(
      fc.property(vec(), vec(), (a, b) => {
        expect(dist(a, b)).toBeCloseTo(dist(b, a), 9);
        expect(dist(a, a)).toBe(0);
        expect(dist2(a, b)).toBeCloseTo(dist(a, b) ** 2, 6);
      }),
    );
  });

  it("sameCell is exact component equality", () => {
    expect(sameCell({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 })).toBe(true);
    expect(sameCell({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 4 })).toBe(false);
  });
});

describe("pos — idPath", () => {
  it("strips the namespace, passes bare ids through", () => {
    expect(idPath("minecraft:iron_ore")).toBe("iron_ore");
    expect(idPath("gtceu:deepslate_gold_ore")).toBe("deepslate_gold_ore");
    expect(idPath("noNamespace")).toBe("noNamespace");
  });
});
