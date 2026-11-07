// Pure vein helpers used by MINE to keep mining a discovered cluster locally
// instead of bouncing back to SCAN after every single block. `collectVeinCube`
// gathers exposed ore in a small cube around a just-cleared block; `orderHorizonFirst`
// sorts those so we finish the current Y-layer (then levels ABOVE) before ever stepping
// DOWN — the bot holds its horizon instead of chasing a deeper ore off its level.
import { encodePos } from "@/core/prim/pos";
import type { Vec3 } from "@/core/runtime/types";
import { type Offset, makeVeinOffsets } from "@/shared/domain/scan";

export interface VeinCell extends Vec3 {
  readonly id: string;
}

export function collectVeinCube(
  blockId: (x: number, y: number, z: number) => string,
  isOreFn: (id: string) => boolean,
  isExposedFn: (x: number, y: number, z: number) => boolean,
  center: Vec3,
  radius: number,
  max: number,
  excludeKey: (key: string) => boolean,
): VeinCell[] {
  const offsets: Offset[] = makeVeinOffsets(radius);
  const out: VeinCell[] = [];
  for (const o of offsets) {
    if (out.length >= max) break;
    const x = center.x + o.dx;
    const y = center.y + o.dy;
    const z = center.z + o.dz;
    if (o.dx === 0 && o.dy === 0 && o.dz === 0) continue; // the cleared block itself
    if (excludeKey(encodePos(x, y, z))) continue;
    const id = blockId(x, y, z);
    if (isOreFn(id) && isExposedFn(x, y, z)) out.push({ x, y, z, id });
  }
  return out;
}

/** Horizon priority for a delta-y: the SAME level first (0), then each level ABOVE in order, then
 *  ALL levels BELOW last. So the vein-follow exhausts the current working level (and what it can
 *  reach upward) before ever stepping DOWN — "preserve depth order": a single deeper ore never
 *  pulls the bot off its horizon while at-or-above ore remains. */
function horizonRank(dy: number): number {
  if (dy === 0) return 0;
  if (dy > 0) return dy; // above: 1, 2, 3, …
  return 1000 - dy; // below: 1001, 1002, … (always after every above level)
}

export function orderHorizonFirst<T extends Vec3>(cells: readonly T[], ref: Vec3): T[] {
  return [...cells].sort((a, b) => {
    const ra = horizonRank(a.y - ref.y);
    const rb = horizonRank(b.y - ref.y);
    if (ra !== rb) return ra - rb;
    const da = (a.x - ref.x) ** 2 + (a.z - ref.z) ** 2;
    const db = (b.x - ref.x) ** 2 + (b.z - ref.z) ** 2;
    return da - db;
  });
}
