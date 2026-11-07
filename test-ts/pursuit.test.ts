// pursuit domain — the shared chase primitives hunt + follow both use. These were
// tested per-mission as findByUuid/rangeTo/inReach/chaseCell (hunt) and
// findPeerByUuid/rangeTo/withinGap/followCell (follow); now one home, one test.
import { approachCell, byUuid, withinRange } from "@/shared/domain/pursuit";
import { describe, expect, it } from "vitest";

interface Ent {
  uuid: string;
  x: number;
  y: number;
  z: number;
}
const ent = (uuid: string, x: number, y: number, z: number): Ent => ({ uuid, x, y, z });

describe("pursuit domain", () => {
  it("byUuid re-locates a moving target, null when it leaves the snapshot", () => {
    const list = [ent("a", 5, 64, 0), ent("b", 1, 64, 0)];
    expect(byUuid(list, "b")?.uuid).toBe("b");
    expect(byUuid(list, "gone")).toBeNull();
    expect(byUuid([], "a")).toBeNull();
  });

  it("withinRange gates by 3-D distance (inclusive)", () => {
    const self = { x: 0, y: 64, z: 0 };
    expect(withinRange(self, { x: 2, y: 64, z: 0 }, 3)).toBe(true);
    expect(withinRange(self, { x: 3, y: 64, z: 0 }, 3)).toBe(true); // == range
    expect(withinRange(self, { x: 5, y: 64, z: 0 }, 3)).toBe(false);
  });

  it("approachCell floors the target position to a standable cell", () => {
    expect(approachCell({ x: 5.7, y: 64.2, z: -3.4 })).toEqual({ x: 5, y: 64, z: -4 });
  });
});
