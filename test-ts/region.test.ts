import type { FleetAssignment } from "@/core/runtime/types";
import { inAssignment } from "@/shared/domain/region";
import { describe, expect, it } from "vitest";

// Pure fleet-assignment geometry (fleet hub assignment): inAssignment(x,z,a) gates which ore the mine
// scan may target. allowed=null means whole world; forbidden carves out peer claims.
describe("inAssignment", () => {
  const box = { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };

  it("allows everything when allowed is null and there are no forbidden regions", () => {
    const a: FleetAssignment = { allowed: null, forbidden: [] };
    expect(inAssignment(0, 0, a)).toBe(true);
    expect(inAssignment(-999, 999, a)).toBe(true);
  });

  it("restricts to the allowed box (inclusive bounds)", () => {
    const a: FleetAssignment = { allowed: box, forbidden: [] };
    expect(inAssignment(5, 5, a)).toBe(true);
    expect(inAssignment(0, 0, a)).toBe(true); // min corner inclusive
    expect(inAssignment(10, 10, a)).toBe(true); // max corner inclusive
    expect(inAssignment(11, 5, a)).toBe(false); // past maxX
    expect(inAssignment(5, -1, a)).toBe(false); // below minZ
  });

  it("excludes forbidden regions even inside the allowed box", () => {
    const a: FleetAssignment = {
      allowed: box,
      forbidden: [{ minX: 4, maxX: 6, minZ: 4, maxZ: 6 }],
    };
    expect(inAssignment(2, 2, a)).toBe(true); // allowed, outside the claim
    expect(inAssignment(5, 5, a)).toBe(false); // inside a peer's claim
  });

  it("forbidden alone (allowed=null) carves a hole out of the whole world", () => {
    const a: FleetAssignment = {
      allowed: null,
      forbidden: [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10 }],
    };
    expect(inAssignment(-5, -5, a)).toBe(true);
    expect(inAssignment(5, 5, a)).toBe(false);
  });
});
