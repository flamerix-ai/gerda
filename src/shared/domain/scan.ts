import type { Vec3 } from "@/core/runtime/types";
// Pure scan primitives — spiral/vein offset generators and exposure test, ported
// 1:1 from harness/scan/{generator,exposure}.js. No jsMacros: exposure takes
// a blockId getter so it's fully unit-testable.
import type { Config } from "@/shared/config/schema";

export interface Offset {
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
}

/** Outward square spiral on the XZ plane, layered by |dy| (0, +1,-1, +2,-2, …). */
export function makeSpiralOffsets(radiusH: number, radiusY: number): Offset[] {
  const result: Offset[] = [];
  const layer = (dy: number) => {
    for (let r = 0; r <= radiusH; r++) {
      for (let x = -r; x <= r; x++) result.push({ dx: x, dy, dz: -r });
      for (let z = -r + 1; z <= r; z++) result.push({ dx: r, dy, dz: z });
      for (let x = r - 1; x >= -r; x--) result.push({ dx: x, dy, dz: r });
      for (let z = r - 1; z >= -r + 1; z--) result.push({ dx: -r, dy, dz: z });
    }
  };
  layer(0);
  for (let dy = 1; dy <= radiusY; dy++) {
    layer(dy);
    layer(-dy);
  }
  return result;
}

/** Dense cube around a vein hint. */
export function makeVeinOffsets(radius: number): Offset[] {
  const result: Offset[] = [];
  for (let x = -radius; x <= radius; x++) {
    for (let y = -radius; y <= radius; y++) {
      for (let z = -radius; z <= radius; z++) {
        result.push({ dx: x, dy: y, dz: z });
      }
    }
  }
  return result;
}

// 6 cardinal + 12 edge-diagonal (major diagonal skipped — negligible benefit).
const EXPOSURE_DIRS: readonly Offset[] = [
  { dx: 1, dy: 0, dz: 0 },
  { dx: -1, dy: 0, dz: 0 },
  { dx: 0, dy: 1, dz: 0 },
  { dx: 0, dy: -1, dz: 0 },
  { dx: 0, dy: 0, dz: 1 },
  { dx: 0, dy: 0, dz: -1 },
  { dx: 1, dy: 1, dz: 0 },
  { dx: 1, dy: -1, dz: 0 },
  { dx: -1, dy: 1, dz: 0 },
  { dx: -1, dy: -1, dz: 0 },
  { dx: 1, dy: 0, dz: 1 },
  { dx: 1, dy: 0, dz: -1 },
  { dx: -1, dy: 0, dz: 1 },
  { dx: -1, dy: 0, dz: -1 },
  { dx: 0, dy: 1, dz: 1 },
  { dx: 0, dy: 1, dz: -1 },
  { dx: 0, dy: -1, dz: 1 },
  { dx: 0, dy: -1, dz: -1 },
];

const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);

/** A block is mineable-worth-it if at least one neighbour is air/cave space. */
export function isExposed(
  blockId: (x: number, y: number, z: number) => string,
  x: number,
  y: number,
  z: number,
): boolean {
  for (const d of EXPOSURE_DIRS) {
    if (AIR.has(blockId(x + d.dx, y + d.dy, z + d.dz))) return true;
  }
  return false;
}

export function isOre(id: string, cfg: Pick<Config, "ore">): boolean {
  if (cfg.ore.ids.has(id)) return true;
  return cfg.ore.allowAll && id.includes("_ore");
}

/** Nearest EXPOSED target block in a dense cube around `center` (the walls a shaft/corridor just
 *  opened). `isTarget` classifies ore vs wood etc; `minY` (optional) restricts to at-or-above the
 *  working level (a horizon-first scan). Returns the cell (+id) or null. Pure — used by the drill's
 *  DESCEND (per-step exposure check) and EXCAVATE (corridor-wall ore). */
export function exposedTargetNear(
  read: (x: number, y: number, z: number) => string,
  isTarget: (id: string) => boolean,
  center: Vec3,
  radius: number,
  minY?: number,
): (Vec3 & { id: string }) | null {
  let best: (Vec3 & { id: string }) | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const o of makeVeinOffsets(radius)) {
    const x = center.x + o.dx;
    const y = center.y + o.dy;
    const z = center.z + o.dz;
    if (minY !== undefined && y < minY) continue;
    const id = read(x, y, z);
    if (!isTarget(id)) continue;
    if (!isExposed(read, x, y, z)) continue;
    const d = Math.abs(o.dx) + Math.abs(o.dy) + Math.abs(o.dz);
    if (d < bestD) {
      bestD = d;
      best = { x, y, z, id };
    }
  }
  return best;
}
