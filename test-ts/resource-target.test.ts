import type { Vec3 } from "@/core/runtime/types";
import { type VeinMarker, nearestVein } from "@/shared/domain/resource-target";
import { describe, expect, it } from "vitest";

const at = (x: number, z: number): Vec3 => ({ x, y: 64, z });

describe("nearestVein", () => {
  it("returns null when there are no markers", () => {
    expect(nearestVein([], at(0, 0))).toBeNull();
  });

  it("picks the horizontally-closest marker (Y ignored)", () => {
    const markers: VeinMarker[] = [
      { kind: "iron", x: 20, z: 0 },
      { kind: "iron", x: 5, z: 0 },
      { kind: "iron", x: 100, z: 100 },
    ];
    const v = nearestVein(markers, at(0, 0));
    expect(v).not.toBeNull();
    expect(v?.x).toBe(5);
    expect(v?.dist).toBeCloseTo(5);
  });

  it("distance is horizontal — a marker's y never changes the pick", () => {
    const markers: VeinMarker[] = [
      { kind: "iron", x: 3, z: 4, y: -50 }, // hypot(3,4)=5
      { kind: "iron", x: 6, z: 0, y: 200 }, // dist 6
    ];
    const v = nearestVein(markers, at(0, 0));
    expect(v?.x).toBe(3);
    expect(v?.z).toBe(4);
    expect(v?.dist).toBeCloseTo(5);
  });

  it("kind filter only considers veins of that ore group", () => {
    const markers: VeinMarker[] = [
      { kind: "iron", x: 1, z: 0 }, // closest overall…
      { kind: "gold", x: 9, z: 0 }, // …but the only gold
    ];
    const v = nearestVein(markers, at(0, 0), "gold");
    expect(v?.kind).toBe("gold");
    expect(v?.x).toBe(9);
  });

  it("kind filter returns null when no vein of that group exists", () => {
    const markers: VeinMarker[] = [{ kind: "iron", x: 1, z: 0 }];
    expect(nearestVein(markers, at(0, 0), "diamond")).toBeNull();
  });

  it("with no kind filter, mixed groups all compete", () => {
    const markers: VeinMarker[] = [
      { kind: "iron", x: 8, z: 0 },
      { kind: "gold", x: 2, z: 0 },
    ];
    expect(nearestVein(markers, at(0, 0))?.kind).toBe("gold");
  });
});
