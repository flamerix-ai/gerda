// Canonical block-position geometry. The pure, dependency-light SSOT every layer leans on —
// imports only `runtime/types`, so domain/nav/reflexes/missions can all depend on it without a
// cycle. NEVER hand-roll `x,y,z` keys, block-cell floors, block centres, or 3-D distance
// elsewhere — go through these (one-home SSOT; the forks drifted, e.g. a MINE cellCenter copy that
// silently omitted the lookAt).
import type { Vec3 } from "@/core/runtime/types";

const POS_DELIM = ",";

export function encodePos(x: number, y: number, z: number): string {
  return `${x}${POS_DELIM}${y}${POS_DELIM}${z}`;
}

export function decodePos(key: string): Vec3 {
  const [xs, ys, zs, ...rest] = key.split(POS_DELIM);
  if (xs === undefined || ys === undefined || zs === undefined || rest.length > 0) {
    throw new TypeError(`decodePos: malformed key '${key}'`);
  }
  return {
    x: Number.parseInt(xs, 10),
    y: Number.parseInt(ys, 10),
    z: Number.parseInt(zs, 10),
  };
}

/** Euclidean 3-D distance. */
export function dist(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Squared 3-D distance — for compare-only hot paths (no `Math.sqrt`); `dist2(a,b) <= r*r`. */
export function dist2(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/** The integer block cell a floating-point position sits in (feet cell). */
export function floorVec(p: Vec3): Vec3 {
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

/** The centre point of a block cell — the aim/goal point for that block (`b + 0.5` on each axis). */
export function cellCenter(b: Vec3): Vec3 {
  return { x: b.x + 0.5, y: b.y + 0.5, z: b.z + 0.5 };
}

/** True when two positions denote the same integer block cell (exact component equality). */
export const sameCell = (a: Vec3, b: Vec3): boolean => a.x === b.x && a.y === b.y && a.z === b.z;

/** Strip the `namespace:` prefix from a registry id (`minecraft:iron_ore` → `iron_ore`); id-as-is
 *  when unprefixed. Does NOT lower-case — registry ids are already lower-case. */
export function idPath(id: string): string {
  return id.includes(":") ? (id.split(":")[1] ?? id) : id;
}
