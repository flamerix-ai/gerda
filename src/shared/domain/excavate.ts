import type { Vec3 } from "@/core/runtime/types";
// excavate — pure planner for strip-mining a vein VOLUME. The prospector gives a vein's
// horizontal footprint (bbox) + type; the shaft that reaches it anchors the ore Y-band. This turns
// that volume into a deterministic serpentine of 1-wide corridor stand-cells: the bot digs each
// corridor (removing overburden), and the corridor walls expose the scattered ore for the MINE
// vein-follow to sweep. Corridors are spaced so vein-follow reach bridges the gaps between them, so
// we expose the whole vein without full-clearing it.
//
// Geometry only (no block reads / no jsMacros) → unit-tested. The EXCAVATE capability walks the
// returned cells with the shared dig-to hands (planDigStep + break-cell + greedyStep).
import type { VeinBBox } from "@/shared/domain/resource-target";

export interface ExcavateBounds {
  /** Anchor: the vein's x/z, and y = the depth the shaft first hit ore (DRILL_VEIN_REACHED). */
  readonly center: Vec3;
  /** Horizontal footprint from the prospector; absent → a box of `maxRadius` around center. */
  readonly bbox?: VeinBBox | undefined;
  /** Clamp the footprint half-extent (columns) so we never strip-mine a huge region. */
  readonly maxRadius: number;
  /** Excavate levels from the anchor down to anchor − bandHeight (the vein's vertical extent). */
  readonly bandHeight: number;
  /** Z-spacing between corridors (gap = spacing−1 columns, exposed from the side by neighbours). */
  readonly rowSpacing: number;
  /** Y-spacing between excavation levels (gap covered by vein-follow's vertical reach). */
  readonly levelSpacing: number;
  /** Hard cap on planned cells — a runaway backstop; truncation is flagged + logged. */
  readonly maxCells: number;
}

export interface ExcavatePlan {
  /** Ordered corridor stand-cells (feet positions) the bot digs to, in serpentine order. */
  readonly cells: readonly Vec3[];
  /** True if the plan hit `maxCells` and was cut short (coverage incomplete — logged, not silent). */
  readonly truncated: boolean;
  /** The clamped footprint actually planned (for logging/telemetry). */
  readonly box: {
    readonly minX: number;
    readonly maxX: number;
    readonly minZ: number;
    readonly maxZ: number;
  };
}

function clampBox(
  center: Vec3,
  bbox: VeinBBox | undefined,
  maxRadius: number,
): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const cx = Math.floor(center.x);
  const cz = Math.floor(center.z);
  let minX = cx - maxRadius;
  let maxX = cx + maxRadius;
  let minZ = cz - maxRadius;
  let maxZ = cz + maxRadius;
  if (bbox) {
    minX = Math.max(minX, Math.min(bbox[0], bbox[2]));
    maxX = Math.min(maxX, Math.max(bbox[0], bbox[2]));
    minZ = Math.max(minZ, Math.min(bbox[1], bbox[3]));
    maxZ = Math.min(maxZ, Math.max(bbox[1], bbox[3]));
  }
  // Degenerate/empty intersection → at least the anchor column so the drill still works its vein.
  if (minX > maxX) {
    minX = cx;
    maxX = cx;
  }
  if (minZ > maxZ) {
    minZ = cz;
    maxZ = cz;
  }
  return { minX, maxX, minZ, maxZ };
}

/** Corridor rows (Z lines) covering [minZ,maxZ] at `spacing`, always including the far edge so the
 *  last strip of vein isn't left unexposed. */
function rowsFor(minZ: number, maxZ: number, spacing: number): number[] {
  const rows: number[] = [];
  for (let z = minZ; z <= maxZ; z += spacing) rows.push(z);
  const last = rows[rows.length - 1];
  if (last === undefined || last !== maxZ) rows.push(maxZ);
  return rows;
}

/** Build the serpentine corridor plan over the clamped footprint × Y-band. Levels run from the
 *  anchor DOWNWARD only (going down is a free break-the-floor step; the shaft already passed the
 *  rock above, and ore a block or two above the anchor is caught by the top corridor's ceiling via
 *  vein-follow reach). Rows serpentine within a level and their scan direction flips per level, so
 *  consecutive waypoints — within a row, between rows, and between levels — stay adjacent (short
 *  connector tunnels, no footprint-diagonal jumps). */
export function planExcavation(b: ExcavateBounds): ExcavatePlan {
  const rowSpacing = Math.max(1, Math.floor(b.rowSpacing));
  const levelSpacing = Math.max(1, Math.floor(b.levelSpacing));
  const box = clampBox(b.center, b.bbox, Math.max(0, Math.floor(b.maxRadius)));
  const anchorY = Math.floor(b.center.y);
  const bottomY = anchorY - Math.max(0, Math.floor(b.bandHeight));

  const cells: Vec3[] = [];
  let truncated = false;
  let xFlip = false; // X-direction within a corridor row (carries across rows/levels → serpentine)
  let levelIdx = 0;

  for (let y = anchorY; y >= bottomY; y -= levelSpacing, levelIdx++) {
    const rows = rowsFor(box.minZ, box.maxZ, rowSpacing);
    const rowOrder = levelIdx % 2 === 0 ? rows : rows.slice().reverse();
    for (const z of rowOrder) {
      const xs: number[] = [];
      if (xFlip) for (let x = box.maxX; x >= box.minX; x--) xs.push(x);
      else for (let x = box.minX; x <= box.maxX; x++) xs.push(x);
      for (const x of xs) {
        if (cells.length >= b.maxCells) {
          truncated = true;
          return { cells, truncated, box };
        }
        cells.push({ x, y, z });
      }
      xFlip = !xFlip;
    }
  }
  return { cells, truncated, box };
}
