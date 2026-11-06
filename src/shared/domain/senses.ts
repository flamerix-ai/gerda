import { idPath } from "@/core/prim/pos";
import type { Vec3 } from "@/core/runtime/types";
// Senses — pure spatial primitives the future navigator and the hazard/air
// reflexes read. Everything here is a function over a BlockReader (voxel id lookups) with
// NO runtime dependency, so it is unit-testable on synthetic grids. The cached world-view
// that feeds a real BlockReader from rt.world.blockId is a later, kernel-side step; these
// stay pure. Block semantics come from block-traits + movement-physics.
import {
  CLIMBABLE_IDS,
  UNMINEABLE_IDS,
  classifyBlock,
  isWater,
} from "@/shared/domain/block-traits";

/** Block id at integer voxel coords, or `null` when UNKNOWN (unloaded chunk / not cached).
 *  null is never "air": senses treat it conservatively (no walking onto / through unknown). */
export type BlockReader = (x: number, y: number, z: number) => string | null;

/**
 * Is a KNOWN block assumed to fully fill its voxel (a solid cube)? From an id alone we only
 * know block-traits' special cases; an ordinary id (stone/dirt/ore) is assumed a full cube —
 * the common case — so this is heuristic. "Plan on cache, act on truth": the
 * executor re-checks live before stepping. Pure; expects a real id, not null.
 */
export function isFullSolid(id: string): boolean {
  const c = classifyBlock(id);
  if (!c.known) return true; // ordinary block → assume a solid cube
  if (c.passable) return false; // air, openable doors, decorations
  // Known special cases: standable surfaces (slab/stairs/glass/chest/soul_sand) occupy the
  // cell; pure impeders (cobweb/vine) and hazards (lava/fire) do not fill it solidly.
  return c.standable;
}

/** A standing body does NOT fit / pass through this cell unless it's air or a walk-through
 *  block. Unknown (null) → treated as occupied (don't assume clearance). */
export function passableCell(reader: BlockReader, pos: Vec3): boolean {
  const id = reader(pos.x, pos.y, pos.z);
  if (id === null) return false;
  const c = classifyBlock(id);
  return c.known ? c.passable : false; // ordinary known-solid id → not clear
}

/** Can a player stand ON TOP of the block at `pos` (a solid surface or a standable special)?
 *  Unknown support → false (never plan a step onto an unverified block). */
export function standableSurface(reader: BlockReader, pos: Vec3): boolean {
  const id = reader(pos.x, pos.y, pos.z);
  if (id === null) return false;
  return classifyBlock(id).standable || isFullSolid(id);
}

/** Can a 2-block-tall player occupy `feet` — feet + head clear and a standable block below.
 *  (Hazard of the floor/cell is a separate check, see {@link hazardAt}.) */
export function walkableAt(reader: BlockReader, feet: Vec3): boolean {
  return (
    passableCell(reader, feet) &&
    passableCell(reader, { x: feet.x, y: feet.y + 1, z: feet.z }) &&
    standableSurface(reader, { x: feet.x, y: feet.y - 1, z: feet.z })
  );
}

/** Is the cell at `pos` a CLIMBABLE block (ladder / vine / scaffolding) — one a body can ride
 *  up or down without a floor? The ladder movement moves read this instead of standable/passable
 *  (a ladder is both standable-on-top and non-passable, but climbing is the relevant trait).
 *  Unknown (null) → false: never plan to climb an unverified cell. */
export function climbableAt(reader: BlockReader, pos: Vec3): boolean {
  const id = reader(pos.x, pos.y, pos.z);
  if (id === null) return false;
  return CLIMBABLE_IDS.has(idPath(id));
}

/** Can the navigator MINE this cell to make a path (DIG_TO as a movement)? True for a solid
 *  block that occupies the cell and is breakable: NOT air/walk-through (nothing to break — let
 *  traverse own it), NOT a hazard (never tunnel into lava/fire), NOT unmineable (bedrock/barrier/
 *  liquids). Unknown (null) → false: never plan to mine an unverified cell. The executor still
 *  re-checks live before swinging ("plan on cache, act on truth"). */
export function breakableSolid(reader: BlockReader, pos: Vec3): boolean {
  const id = reader(pos.x, pos.y, pos.z);
  if (id === null) return false;
  const c = classifyBlock(id);
  if (c.known && c.passable) return false; // air / flower / open door — nothing to break
  if (c.hazard) return false; // lava/fire/magma — never mine into
  if (UNMINEABLE_IDS.has(idPath(id))) return false; // bedrock/barrier/liquid
  return true;
}

/** Is the cell at `pos` a KNOWN hazard to enter (lava/fire/cactus/cobweb/magma…)?
 *  Unknown (null) → false; the caller decides how to treat unknown separately. */
export function hazardAt(reader: BlockReader, pos: Vec3): boolean {
  const id = reader(pos.x, pos.y, pos.z);
  if (id === null) return false;
  return classifyBlock(id).hazard;
}

/** Would a 2-tall body standing at `feet` be SUBMERGED — both the feet cell AND the head cell are
 *  water → head underwater = a DROWN trap. Wading through 1-deep water (feet water, head air) is
 *  fine and stays allowed; this flags only over-the-head water. Water is NOT a `classifyBlock`
 *  hazard (it's harmless to touch), so the navigator's hazard veto reads THIS separately to refuse
 *  walking/falling into a drowning pool (the flooded-ravine trap that killed the bot). Unknown
 *  (null) cells are NOT water → not submerging (the void/unknown vetoes own that case). */
export function submergesAt(reader: BlockReader, feet: Vec3): boolean {
  const f = reader(feet.x, feet.y, feet.z);
  if (f === null || !isWater(f)) return false;
  const h = reader(feet.x, feet.y + 1, feet.z);
  return h !== null && isWater(h);
}

/** Ground found below `feet`: the surface block's `y` and the `drop` in blocks the player
 *  would fall to land on it (0 = already on it). `drop` feeds fallDamageHealthPoints. */
export interface Ground {
  readonly y: number;
  readonly drop: number;
}

/** Scan straight down from just below `feet` up to `maxDrop` blocks for the first standable
 *  surface. null = void / nothing standable within range (the navigator must refuse it). */
export function groundUnder(reader: BlockReader, feet: Vec3, maxDrop: number): Ground | null {
  for (let dy = 1; dy <= maxDrop; dy++) {
    const y = feet.y - dy;
    if (standableSurface(reader, { x: feet.x, y, z: feet.z })) {
      return { y, drop: dy - 1 };
    }
  }
  return null;
}

/** A voxel a ray entered. `dist` is along-ray distance (blocks) to the voxel's near edge. */
export interface RayHit {
  readonly pos: Vec3;
  readonly id: string;
  readonly dist: number;
}

/**
 * Voxel ray-march (Amanatides–Woo) from `origin` along `dir` (need not be normalized) up to
 * `maxDist` blocks. Returns the first voxel whose id satisfies `blocks` (default: a solid
 * cube), or null if none. UNKNOWN voxels (reader→null) do NOT block by default — the ray
 * passes through them; pass a custom `blocks` to change that. Pure.
 */
export function raycast(
  reader: BlockReader,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  blocks: (id: string) => boolean = isFullSolid,
): RayHit | null {
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (len === 0) return null;
  const dx = dir.x / len;
  const dy = dir.y / len;
  const dz = dir.z / len;

  let vx = Math.floor(origin.x);
  let vy = Math.floor(origin.y);
  let vz = Math.floor(origin.z);

  const stepX = dx >= 0 ? 1 : -1;
  const stepY = dy >= 0 ? 1 : -1;
  const stepZ = dz >= 0 ? 1 : -1;

  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Number.POSITIVE_INFINITY;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Number.POSITIVE_INFINITY;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Number.POSITIVE_INFINITY;

  // along-ray distance to the first voxel boundary on each axis
  let tMaxX =
    dx !== 0 ? (dx > 0 ? vx + 1 - origin.x : origin.x - vx) * tDeltaX : Number.POSITIVE_INFINITY;
  let tMaxY =
    dy !== 0 ? (dy > 0 ? vy + 1 - origin.y : origin.y - vy) * tDeltaY : Number.POSITIVE_INFINITY;
  let tMaxZ =
    dz !== 0 ? (dz > 0 ? vz + 1 - origin.z : origin.z - vz) * tDeltaZ : Number.POSITIVE_INFINITY;

  let t = 0;
  while (t <= maxDist) {
    const id = reader(vx, vy, vz);
    if (id !== null && blocks(id)) return { pos: { x: vx, y: vy, z: vz }, id, dist: t };
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      vx += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
    } else if (tMaxY <= tMaxZ) {
      vy += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
    } else {
      vz += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
    }
  }
  return null;
}
