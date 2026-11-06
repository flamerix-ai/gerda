import type { Vec3 } from "@/core/runtime/types";
// Offline terrain harness for navigation property tests (not a test file — no `.test.ts`).
// Generates synthetic worlds as BlockReaders so the PURE navigator core (planner, movement
// types, senses) can be exercised on thousands of random shapes offline — the "test the whole
// nav system offline" investment. A heightfield is the realistic surface-traversal model: one
// solid column per (x,z) up to a surface height, open air above, the bot stands on the surface.
import type { BlockReader } from "@/shared/domain/senses";

export interface Heightfield {
  /** Surface height (top solid y) at grid cell [ix][iz]; x = X0+ix, z = Z0+iz. */
  readonly heights: readonly (readonly number[])[];
  readonly X0: number;
  readonly Z0: number;
  readonly W: number;
  readonly D: number;
}

/** A BlockReader over a heightfield: stone at/below the surface, air above, UNKNOWN (null) off
 *  the grid — exactly how a freshly-sensed strip reads (conservative refuse outside what we know). */
export function heightfieldReader(hf: Heightfield): BlockReader {
  return (x, y, z) => {
    const ix = x - hf.X0;
    const iz = z - hf.Z0;
    if (ix < 0 || ix >= hf.W || iz < 0 || iz >= hf.D) return null;
    const col = hf.heights[ix];
    if (!col) return null;
    const h = col[iz];
    if (h === undefined) return null;
    return y <= h ? "minecraft:stone" : "minecraft:air";
  };
}

/** The feet cell standing on the surface at grid cell (ix,iz). */
export function standCell(hf: Heightfield, ix: number, iz: number): Vec3 {
  const col = hf.heights[ix];
  const h = col?.[iz] ?? 0;
  return { x: hf.X0 + ix, y: h + 1, z: hf.Z0 + iz };
}

/** Build a heightfield from a SEPARABLE profile h(ix,iz) = base + hx[ix] + hz[iz], where hx/hz are
 *  cumulative bounded-step 1-D walks. Each CARDINAL neighbour then differs by exactly one profile's
 *  step, so bounding the steps bounds every cardinal delta — the key to a provably walk-connected
 *  field. `stepLo/stepHi` set the per-step range (e.g. [-3,+1] = gentle/connected; wider = cliffs). */
export function separableField(
  X0: number,
  Z0: number,
  base: number,
  xSteps: readonly number[], // length W-1
  zSteps: readonly number[], // length D-1
  band = 12,
): Heightfield {
  const cum = (steps: readonly number[]): number[] => {
    const out = [0];
    let v = 0;
    for (const s of steps) {
      v = Math.max(-band, Math.min(band, v + s)); // clamp REDUCES a step's magnitude → bound preserved
      out.push(v);
    }
    return out;
  };
  const hx = cum(xSteps);
  const hz = cum(zSteps);
  const W = hx.length;
  const D = hz.length;
  const heights: number[][] = [];
  for (let ix = 0; ix < W; ix++) {
    const row: number[] = [];
    for (let iz = 0; iz < D; iz++) row.push(base + (hx[ix] ?? 0) + (hz[iz] ?? 0));
    heights.push(row);
  }
  return { heights, X0, Z0, W, D };
}
