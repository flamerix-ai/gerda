import { pickProspectVein } from "@/shared/domain/prospect";
import { makeWaypoint } from "@/shared/domain/waypoints";
import type { ResourceMarker } from "@/shared/domain/world-model";
import { describe, expect, it } from "vitest";

const from = { x: 0, y: 100, z: 0 };

function res(kind: string, x: number, z: number, y?: number): ResourceMarker {
  return y === undefined ? { kind, x, z } : { kind, x, z, y };
}

describe("pickProspectVein", () => {
  it("returns null when nothing of the kind exists", () => {
    expect(pickProspectVein([res("copper", 10, 0)], [], from, "iron", 8)).toBeNull();
    expect(pickProspectVein([], [], from, "iron", 8)).toBeNull();
  });

  it("picks the nearest matching vein and defaults y to the approach height", () => {
    const pick = pickProspectVein(
      [res("iron", 30, 0), res("iron", 10, 0), res("copper", 1, 0)],
      [],
      from,
      "iron",
      8,
    );
    expect(pick).not.toBeNull();
    expect(pick?.x).toBe(10);
    expect(pick?.y).toBe(from.y); // no marker y → walk the column at the approach height
    expect(pick?.kind).toBe("iron");
    expect(Math.round(pick?.dist ?? -1)).toBe(10);
  });

  it("honours an explicit marker y", () => {
    const pick = pickProspectVein([res("iron", 5, 0, 42)], [], from, "iron", 8);
    expect(pick?.y).toBe(42);
  });

  it("skips a vein within depletedRadius of a depleted waypoint, picking the next", () => {
    const resources = [res("iron", 10, 0), res("iron", 40, 0)];
    const depleted = [makeWaypoint("dead", { x: 11, y: 100, z: 1 }, "depleted")]; // ~near (10,0)
    const pick = pickProspectVein(resources, depleted, from, "iron", 8);
    expect(pick?.x).toBe(40); // the near one is greyed out → fall through to the far vein
  });

  it("returns null when every matching vein is depleted", () => {
    const resources = [res("iron", 10, 0)];
    const depleted = [makeWaypoint("dead", { x: 10, y: 100, z: 0 }, "depleted")];
    expect(pickProspectVein(resources, depleted, from, "iron", 8)).toBeNull();
  });

  it("a depleted waypoint of one vein does not grey out a far vein of the same kind", () => {
    const resources = [res("iron", 100, 0)];
    const depleted = [makeWaypoint("dead", { x: 0, y: 100, z: 0 }, "depleted")];
    expect(pickProspectVein(resources, depleted, from, "iron", 8)?.x).toBe(100);
  });
});
