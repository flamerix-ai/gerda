import type { Vec3 } from "@/core/runtime/types";
// Pure vein selection over the HV prospector's cached markers. The prospector (ext.js
// `prospect`) writes vein markers to mc_world.json's `resources[]` — {kind, x, z, cells, …};
// the worker kernel CONSUMES them to pick the next shaft (it can't drive the main-thread
// prospector GUI itself). This is the data-in/data-out core of the prospect mission, kept pure
// so it's unit-testable on synthetic markers. No jsMacros, no IO.
import { minBy } from "@/shared/domain/select";
import type { Waypoint } from "@/shared/domain/waypoints";
import type { ResourceMarker } from "@/shared/domain/world-model";

export interface ProspectPick {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly kind: string;
  readonly dist: number; // horizontal (xz) distance from `from`
}

/**
 * Pick the nearest prospected vein of `oreKind` the bot hasn't already worked out. A vein is
 * "depleted" once a `depleted` waypoint sits within `depletedRadius` of it — the bot greys a
 * vein out (markDepletedNear) when SCAN walks it dry, so re-prospecting never re-picks a mined
 * shaft. Resources carry only x/z (a vein spans levels); `y` defaults to the approach `from.y`
 * so navigation walks the column. Returns null when nothing of that kind is left.
 */
export function pickProspectVein(
  resources: readonly ResourceMarker[],
  waypoints: readonly Waypoint[],
  from: Vec3,
  oreKind: string,
  depletedRadius: number,
): ProspectPick | null {
  const r2 = depletedRadius ** 2;
  const depleted = waypoints.filter((w) => w.kind === "depleted");
  const live = resources.filter(
    (m) => m.kind === oreKind && !depleted.some((w) => (w.x - m.x) ** 2 + (w.z - m.z) ** 2 <= r2),
  );
  // Horizontal argmin (squared has the same winner as hypot); dist recomputed for the result.
  const m = minBy(live, (v) => (v.x - from.x) ** 2 + (v.z - from.z) ** 2);
  if (!m) return null;
  return {
    x: m.x,
    y: typeof m.y === "number" ? m.y : from.y,
    z: m.z,
    kind: m.kind,
    dist: Math.hypot(m.x - from.x, m.z - from.z),
  };
}
