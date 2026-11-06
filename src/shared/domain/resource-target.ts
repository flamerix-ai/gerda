import type { Vec3 } from "@/core/runtime/types";
// Pure picker over the prospector's cached vein markers (mc_world.json `resources[]`, written by
// ext.js prospect). The drill mission reads these to choose where to dig — the markers are
// surface-projected X/Z only (Y is unknown until the shaft exposes the ore), so distance is
// horizontal. jsMacros-free → unit-tested on plain data.
import { minBy } from "@/shared/domain/select";

/** A vein's horizontal footprint (surface-projected), as recorded by the prospector grid:
 *  `[minX, minZ, maxX, maxZ]` inclusive block coords. The volume the EXCAVATE strategy
 *  strip-mines; absent on old caches (→ excavate falls back to a box around x/z). */
export type VeinBBox = readonly [number, number, number, number];

/** A cached vein marker (structural subset of world-model's ResourceMarker). */
export interface VeinMarker {
  readonly kind: string; // ore group, e.g. "iron" / "gold"
  readonly x: number;
  readonly z: number;
  readonly y?: number;
  readonly bbox?: VeinBBox;
}

export interface VeinTarget {
  readonly kind: string;
  readonly x: number;
  readonly z: number;
  readonly dist: number; // horizontal distance from the query position
  readonly bbox?: VeinBBox | undefined;
}

/** The nearest cached vein to `pos` by horizontal distance. If `kind` is given, only veins of
 *  that ore group are considered; otherwise any. Returns null when nothing matches. */
export function nearestVein(
  markers: readonly VeinMarker[],
  pos: Vec3,
  kind?: string,
): VeinTarget | null {
  const pool = kind ? markers.filter((m) => m.kind === kind) : markers;
  // Horizontal argmin (squared has the same winner as hypot); dist recomputed for the result.
  const m = minBy(pool, (v) => (v.x - pos.x) ** 2 + (v.z - pos.z) ** 2);
  if (!m) return null;
  return { kind: m.kind, x: m.x, z: m.z, dist: Math.hypot(m.x - pos.x, m.z - pos.z), bbox: m.bbox };
}

/** First acceptable DIG COLUMN for a vein: the marker centroid, else alternate columns spread
 *  over the vein's bbox. The prospector centroid is a surface projection — in watery seeds it
 *  routinely lands in a lake/river, and one flooded column must not write off a 400-cell vein
 *  (live: silver+coal vein centres drowned in THREE rtp areas running). Candidates
 *  are the centroid, then the bbox quarter-grid (9 points), nearest-to-centroid first, so the
 *  shaft stays deep inside the ore footprint. `ok(x,z)` is the caller's veto (hazard proximity);
 *  null = every candidate vetoed (the vein really is unminable — skip it). Old caches without a
 *  bbox get only the centroid, i.e. exactly the previous behaviour. */
export function veinDigColumn(
  m: VeinMarker,
  ok: (x: number, z: number) => boolean,
): { x: number; z: number } | null {
  if (ok(m.x, m.z)) return { x: m.x, z: m.z };
  if (!m.bbox) return null;
  const [minX, minZ, maxX, maxZ] = m.bbox;
  const cands: { x: number; z: number; d: number }[] = [];
  for (const fx of [0.25, 0.5, 0.75]) {
    for (const fz of [0.25, 0.5, 0.75]) {
      const x = Math.floor(minX + (maxX - minX) * fx);
      const z = Math.floor(minZ + (maxZ - minZ) * fz);
      if (x === m.x && z === m.z) continue;
      cands.push({ x, z, d: Math.hypot(x - m.x, z - m.z) });
    }
  }
  cands.sort((a, b) => a.d - b.d);
  for (const c of cands) {
    if (ok(c.x, c.z)) return { x: c.x, z: c.z };
  }
  return null;
}
