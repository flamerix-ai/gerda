import { readSnapshot } from "@/core/runtime/snapshot";
import type { Vec3 } from "@/core/runtime/types";
import { describe, expect, it } from "vitest";

interface Rec extends Vec3 {
  id: string;
}

const self: Vec3 = { x: 0, y: 64, z: 0 };

describe("readSnapshot", () => {
  it("returns [] for an absent/blank/non-string, non-array source", () => {
    expect(readSnapshot<Rec>(undefined, self, 10)).toEqual([]);
    expect(readSnapshot<Rec>("", self, 10)).toEqual([]);
    expect(readSnapshot<Rec>(null, self, 10)).toEqual([]);
    expect(readSnapshot<Rec>(42, self, 10)).toEqual([]);
  });

  it("parses a JSON-string source and filters by distance (inclusive of maxDist)", () => {
    const raw = JSON.stringify([
      { x: 3, y: 64, z: 0, id: "near" }, // d=3
      { x: 5, y: 64, z: 0, id: "edge" }, // d=5 (== maxDist, kept)
      { x: 20, y: 64, z: 0, id: "far" }, // d=20 (dropped)
    ]);
    const out = readSnapshot<Rec>(raw, self, 5);
    expect(out.map((r) => r.id)).toEqual(["near", "edge"]);
  });

  it("accepts an already-parsed array source (the mock path)", () => {
    const arr: Rec[] = [
      { x: 1, y: 64, z: 0, id: "a" },
      { x: 100, y: 64, z: 0, id: "b" },
    ];
    expect(readSnapshot<Rec>(arr, self, 5).map((r) => r.id)).toEqual(["a"]);
  });

  it("identity (no map) preserves the record reference and input order", () => {
    const arr: Rec[] = [
      { x: 4, y: 64, z: 0, id: "second" },
      { x: 1, y: 64, z: 0, id: "first" },
    ];
    const out = readSnapshot<Rec>(arr, self, 10);
    expect(out.map((r) => r.id)).toEqual(["second", "first"]); // unsorted
    expect(out[0]).toBe(arr[0]); // same ref
  });

  it("maps + attaches the computed distance and sorts nearest-first", () => {
    const arr: Rec[] = [
      { x: 4, y: 64, z: 0, id: "b" }, // d=4
      { x: 1, y: 64, z: 0, id: "a" }, // d=1
      { x: 9, y: 64, z: 0, id: "c" }, // d=9 (dropped at maxDist=5)
    ];
    const out = readSnapshot<Rec, Rec & { distance: number }>(arr, self, 5, {
      map: (r, distance) => ({ ...r, distance }),
      sort: true,
    });
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
    expect(out[0]?.distance).toBeCloseTo(1);
    expect(out[1]?.distance).toBeCloseTo(4);
  });
});
