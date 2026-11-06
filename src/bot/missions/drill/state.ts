import type { Vec3 } from "@/core/runtime/types";
// drill/state — the drill mission's blackboard slices, split out so BOTH descend.ts (the shaft
// digger) and excavate.ts (the volume strip-miner) can read/write them without a circular import
// (descend imports excavate's startExcavation; excavate needs the shaft run-state to resume the
// descent between bands). A leaf module: it imports only kernel/domain primitives, nothing from the
// drill capabilities.
import type { VeinBBox } from "@/shared/domain/resource-target";
import { defineSlice } from "@/shared/kernel/slice";
import { type BreakRun, freshBreakRun } from "@/shared/nav/break-cell";

/** Set by the drill mission's init: true → no cached vein to drill to (run prospect first). The
 *  descend guard turns this into a graceful PAUSE (not a hard ERROR) + a DRILL_NEEDS_PROSPECT alert,
 *  so a dead/empty prospector pauses the loop instead of erroring it — and a `resume` after the host
 *  refreshes the vein cache (ext `prospect`) re-targets. `ore` is remembered so that re-pick filters
 *  by the same ore group. */
export const DRILL_SLICE = defineSlice<{
  noTarget: boolean;
  vein: Vec3 | null;
  ore: string | undefined;
  // The selected vein's horizontal footprint — handed to EXCAVATE to bound the volume it
  // strip-mines. Undefined on old caches (→ excavate falls back to a box around the vein x/z).
  bbox: VeinBBox | undefined;
  // How many ore bands this mission has fully excavated ("dig every vein on the way down"). Drives
  // two things: after a band is stripped the drill keeps DESCENDing to the next one
  // (cfg.drill.multiBand), and the depth floor ends the run gracefully (PAUSED) once ≥1 band is mined
  // instead of the no-vein ERROR. Reset to 0 by the mission init.
  bandsMined: number;
  // Session skip-set of vein columns (`"x,z"`) the drill couldn't PATH to this run (parked across a
  // ravine/gap on the approach — see cfg.drill.approachBlockedTicks). selectDrillVein excludes these so a
  // scattered, unreachable vein is a skip-to-next, not a repeated dead approach. In-memory only (NOT a
  // persisted hazard like a drowned column — an unreachable vein may be reachable next run/approach);
  // reset per mission by the init. "Reach scattered veins or skip them without falling into ERROR".
  skip: string[];
}>("drill", () => ({
  noTarget: false,
  vein: null,
  ore: undefined,
  bbox: undefined,
  bandsMined: 0,
  skip: [],
}));

/** Canonical vein-column key for the drill skip-set ("x,z", floored). */
export function veinKey(x: number, z: number): string {
  return `${Math.floor(x)},${Math.floor(z)}`;
}

export interface DrillRun extends BreakRun {
  // Centring is per-shaft-LAYER: reset when we drop to a new feet.y, so each layer gets a fresh
  // budget to nudge block-centred before digging (a centred bot digs a clean 1-wide column).
  centerTicks: number;
  lastFeetY: number;
  // (The DESCEND stall watchdogs — feet.y frozen, approach-not-converging, airborne-hang — are no
  // longer bespoke tick counters here; they are the DESCEND ProgressPolicies, whose
  // signatures read feet.y / the horizontal approach / onGround directly. The kernel owns the timing.)
  // False until the first support is broken. While false the SURFACE layer anchors its centring to
  // the prospected marker COLUMN (not wherever GOTO's ~2.5-block arrival left us) so the shaft starts
  // ON the vein, not 1–2 blocks off it (→ miss the vein / open a void). Once the shaft is cut, the
  // bot drops straight down the marker column, so deeper layers anchor to the current block (which
  // IS the marker column) — and re-descents after a MINE leg dig where the bot stands, not back at
  // the marker. Reset per mission by the drill init AND per band by excavate (re-anchor to the
  // marker column before the next descent leg).
  shaftStarted: boolean;
  // feet.y where this shaft STARTED digging (the arrival surface). The prospector gives the vein's
  // X/Z but not its Y, so the drill would otherwise engage ore exposed at the surface (eroded/ore-rich
  // terrain) one block down and never reach the BURIED band. reachVeinOrFloor ignores exposed ore until
  // the shaft is cfg.drill.surfaceSkip blocks below this. NaN until the first grounded descend tick.
  // NOT reset between bands: once recorded it stays, so multi-band descent never re-applies the skip.
  surfaceY: number;
  // Flooded-column HAZARD counter (drowning fix, the "not fully submerged, but in a flow" case):
  // consecutive DESCEND ticks the bot is in water contact (feet cell or the cell below is water). A
  // marker column in a flooded cavern surface makes the bot bob at the water line (swim-out
  // surfaces it → DESCEND retries) so the descend-approach ProgressPolicy never converges; this
  // fires independently. Reset the moment the bot is out of water (a short waded puddle doesn't
  // accumulate); once > cfg.drill.waterContactTicks the column is recorded drowned (persistent) +
  // skipped — same treatment as the full-submersion drown trap. Deliberately NOT folded into the
  // universal progress contract: it detects a persistent HAZARD (water present), which fires even
  // while the bot bobs/moves — not a "no forward progress" signal.
  waterContactTicks: number;
}
export const DRILL_RUN = defineSlice<DrillRun>("drillRun", () => ({
  ...freshBreakRun(),
  centerTicks: 0,
  lastFeetY: Number.NaN,
  shaftStarted: false,
  surfaceY: Number.NaN,
  waterContactTicks: 0,
}));

/** Reset the per-shaft run state at the start of a drill mission (slices persist across missions in
 *  the blackboard, so `shaftStarted` from a prior drill would wrongly skip the marker-anchor). */
export function resetDrillRun(run: DrillRun): void {
  run.centerTicks = 0;
  run.lastFeetY = Number.NaN;
  run.shaftStarted = false;
  run.surfaceY = Number.NaN;
  run.waterContactTicks = 0;
}
