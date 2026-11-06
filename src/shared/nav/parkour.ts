import { floorVec } from "@/core/prim/pos";
import type { Runtime } from "@/core/runtime/Runtime";
import type { Vec3 } from "@/core/runtime/types";
// — Parkour run-up executor ————————————————————————————————————————————————————————————————————
// A sprint-jump only clears a wide gap if launched AT sprint speed. The planner offers a parkour
// from the takeoff cell, but the bot may ARRIVE there at walk speed (it just walk-bridged onto the
// edge, or stepped off a slow approach) — jumping from walk speed undershoots into the void. Real MC
// needs a running start. So, like the pillar, parkour is a multi-tick sub-machine: RETREAT a few
// solid cells back from the takeoff (opposite the gap) to make runway, then CHARGE — sprint toward
// the landing and fire the jump the instant we're back on the takeoff cell at takeoff speed. It owns
// the tick start-to-finish (re-planning mid-retreat would lose the takeoff: backing up makes the
// parkour stop being path[1]).
import type { Config } from "@/shared/config/schema";
import { passableCell, standableSurface } from "@/shared/domain/senses";
import {
  type GreedyStep,
  applySprint,
  greedyRelease,
  liveReader,
  mustOnGround,
  mustSetYaw,
  mustVelocity,
} from "@/shared/nav/core";
import { blk } from "@/shared/nav/route";

interface ParkourRun {
  active: boolean;
  takeoffX: number; // the cell we launch from (feet at the moment the parkour was chosen)
  takeoffZ: number;
  landing: Vec3; // the parkour's landing cell (a real standable surface past the gap)
  phase: "BACKUP" | "CHARGE";
  anchorX: number; // retreat target — furthest solid cell behind the takeoff (≤ cfg.nav.parkourRunupCells)
  anchorZ: number;
  dist: number; // jump distance in cells (2..4); dist 4 needs sprint, dist 2-3 clear at walk speed
  launched: boolean; // jump fired → airborne; end when we next touch ground
  airborne: boolean; // has truly LEFT the ground since launch — only then does touching ground = landed
  startTick: number; // stall guard — abort a run-up that never launches
}
function freshParkourRun(): ParkourRun {
  return {
    active: false,
    takeoffX: 0,
    takeoffZ: 0,
    landing: { x: 0, y: 0, z: 0 },
    phase: "CHARGE",
    anchorX: 0,
    anchorZ: 0,
    dist: 0,
    launched: false,
    airborne: false,
    startTick: 0,
  };
}
let parkourRun: ParkourRun = freshParkourRun();
// Latched once a run-up reached a takeoff too slow for the dist-4 sprint-jump it planned: the planner
// then stops offering parkour for the rest of the leg (so it bridges instead of re-offering the jump
// the executor just refused — which would oscillate). Cleared on a fresh drive (resetGreedyNav).
let parkourGaveUp = false;

/** Is a parkour run-up currently owning the tick? (greedyStep's tick-ownership test.) */
export function parkourActive(): boolean {
  return parkourRun.active;
}

/** Has this leg's parkour been given up (underpowered dist-4 refusal)? The executor passes the
 *  inverse into PlannerOpts.parkour so a replan bridges the gap instead of re-offering the jump. */
export function parkourGaveUpLatched(): boolean {
  return parkourGaveUp;
}

/** Drop the run-up machine, the give-up latch and the per-tick trace — the resetGreedyNav path
 *  (a fresh leg may parkour again — the give-up latch is per-drive; each drive's trace reads clean). */
export function resetParkour(): void {
  parkourRun = freshParkourRun();
  parkourGaveUp = false;
  parkourTraceClear();
}

// — Per-tick parkour trace (debug instrument) ————————————————————————————————————————————————————————
// The NDJSON log ring evicts under load + I'd been sampling it every 4 ticks, which kept HIDING the
// exact launch tick + the speed/across at takeoff. This is a dedicated, UN-sampled, in-memory trace:
// parkourStep records EVERY tick it runs (one row per tick with the full decision state + the action it
// took), retrievable whole via the `nav_trace` bridge command. Capped so a wedged run can't grow it
// unbounded; cleared on a fresh drive so each experiment reads clean.
export interface ParkourTracePoint {
  t: number; // tick
  phase: string; // BACKUP | CHARGE
  action: string; // what parkourStep DID this tick (BACKUP/CHARGE/LAUNCH/AIR/LAND/ABORT_*/STALL)
  x: number;
  y: number;
  z: number;
  speed: number; // horizontal b/tick
  ground: boolean;
  launched: boolean;
  airborne: boolean;
  across: number; // how far across the takeoff cell toward the gap (0=near edge, 1=far edge)
  onTakeoff: boolean; // feet are on the takeoff cell
  takeoffX: number;
  dist: number; // planned jump distance in cells
}
const PARKOUR_TRACE_CAP = 600;
let parkourTrace: ParkourTracePoint[] = [];
function recParkour(p: ParkourTracePoint): void {
  parkourTrace.push(p);
  if (parkourTrace.length > PARKOUR_TRACE_CAP) parkourTrace.shift();
}
/** The full per-tick parkour trace since the last drive (oldest→newest). For the `nav_trace` command. */
export function parkourTraceDump(): ParkourTracePoint[] {
  return parkourTrace;
}
/** Drop the trace (called on a fresh drive so each experiment's trace reads clean). */
export function parkourTraceClear(): void {
  parkourTrace = [];
}
const r2 = (n: number): number => Math.round(n * 100) / 100;
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** End any in-flight parkour run-up and release its keys. No-op if none is active. */
export function endParkourIfActive(rt: Runtime): void {
  if (!parkourRun.active) return;
  greedyRelease(rt);
  parkourRun = freshParkourRun();
}

/** Begin a parkour run-up from `feet` (the takeoff) toward `landing`. Scans up to
 *  cfg.nav.parkourRunupCells of solid same-level ground OPPOSITE the gap for a retreat anchor; if there's
 *  no room to back up, starts directly in CHARGE (best effort from the takeoff).
 *
 *  Returns false (and does NOT activate a run-up) when a dist-4 jump can't get a FULL run-up: the
 *  boost-launch needs the bot moving forward at the takeoff edge, and a short runway never builds the
 *  cfg.nav.parkourTakeoffSpeed commitment floor — so it would charge to the lip, abort underpowered, and the
 *  residual forward momentum would carry it off the edge before a bridge could place (the abort-at-lip →
 *  fall bug). Refusing here keeps the bot stationary on solid ground so the caller can re-plan a bridge.
 *  dist 2-3 always activate: they need no commitment (the boost clears them even from a standstill, and a
 *  miss is catch-floor-survivable), so they never hit the underpowered abort (sprintJump = dist≥4). */
export function initParkourRun(rt: Runtime, cfg: Config, feet: Vec3, landing: Vec3): boolean {
  const dirX = Math.sign(landing.x - feet.x);
  const dirZ = Math.sign(landing.z - feet.z);
  const live = liveReader(rt);
  let ax = feet.x;
  let az = feet.z;
  let runwayCells = 0;
  for (let i = 1; i <= cfg.nav.parkourRunupCells; i++) {
    const cx = feet.x - dirX * i;
    const cz = feet.z - dirZ * i;
    const standable = standableSurface(live, { x: cx, y: feet.y - 1, z: cz });
    const clear =
      passableCell(live, { x: cx, y: feet.y, z: cz }) &&
      passableCell(live, { x: cx, y: feet.y + 1, z: cz });
    if (!standable || !clear) break; // runway ends — back up only as far as solid ground allows
    ax = cx;
    az = cz;
    runwayCells = i;
  }
  const dist = Math.abs(landing.x - feet.x) + Math.abs(landing.z - feet.z);
  if (dist >= 4 && runwayCells < cfg.nav.parkourRunupCells) {
    // No full run-up for a dist-4 commitment → refuse rather than walk the bot off the lip underpowered.
    parkourGaveUp = true; // this leg won't re-offer parkour; the caller re-plans → bridge crosses it.
    return false;
  }
  const hasRunway = runwayCells > 0;
  parkourRun = {
    active: true,
    takeoffX: feet.x,
    takeoffZ: feet.z,
    landing,
    phase: hasRunway ? "BACKUP" : "CHARGE",
    anchorX: ax,
    anchorZ: az,
    dist,
    launched: false,
    airborne: false,
    startTick: rt.tick(),
  };
  return true;
}

/** Read-only snapshot of the parkour run-up state — for the navProbe diagnostic log (NAV_PARKOUR),
 *  so a live run-up's phase/takeoff/launch can be traced without the executor itself logging. */
export function parkourSnapshot(): {
  active: boolean;
  phase: string;
  takeoffX: number;
  anchorX: number;
  launched: boolean;
} {
  return {
    active: parkourRun.active,
    phase: parkourRun.phase,
    takeoffX: parkourRun.takeoffX,
    anchorX: parkourRun.anchorX,
    launched: parkourRun.launched,
  };
}

/** Drive ONE tick of an in-flight parkour run-up. BACKUP walks (no sprint) to the runway anchor;
 *  CHARGE sprints back toward the landing and fires the jump the instant we're on the takeoff cell
 *  at ≥ cfg.nav.parkourTakeoffSpeed — or at the takeoff's far edge regardless (a weak jump beats walking
 *  off). Returns "moving" throughout; "blocked_no_path" if the run-up stalls past the timeout. */
export function parkourStep(rt: Runtime, cfg: Config): GreedyStep {
  const run = parkourRun;
  const posR = rt.player.pos();
  if (!posR.ok) return "moving";
  const pos = posR.value;
  // Ground contact + speed time the launch: an unknown is neither "grounded" nor "standing still" —
  // the must* reads release the keys and end the drive instead (nav/core.ts).
  const isGround = mustOnGround(rt);
  const vel = mustVelocity(rt);
  const speed = Math.hypot(vel.x, vel.z);

  // Geometry shared by every branch (also feeds the per-tick trace): which cell the feet are over,
  // and how far across the take-off cell we are toward the gap (0 = near edge, 1 = far edge / lip).
  const feet = floorVec(pos);
  const onTakeoff = feet.x === run.takeoffX && feet.z === run.takeoffZ;
  const dirX = Math.sign(run.landing.x - run.takeoffX);
  const dirZ = Math.sign(run.landing.z - run.takeoffZ);
  const across = dirX !== 0 ? (pos.x - run.takeoffX) * dirX : (pos.z - run.takeoffZ) * dirZ;
  // Record one trace row per tick (debug instrument). `action` is the decision this tick took.
  const rec = (action: string): void =>
    recParkour({
      t: rt.tick(),
      phase: run.phase,
      action,
      x: r2(pos.x),
      y: r2(pos.y),
      z: r2(pos.z),
      speed: r3(speed),
      ground: isGround,
      launched: run.launched,
      airborne: run.airborne,
      across: r2(across),
      onTakeoff,
      takeoffX: run.takeoffX,
      dist: run.dist,
    });

  // Launched → wait to touch down PAST the take-off, then hand back to normal planning (we've crossed,
  // or fell and the outer re-plan recovers). Never re-jump. We must NOT end while still grounded ON the
  // take-off cell: for a tick or two right after the jump the feet are still over the take-off block, and
  // ending there re-inits a fresh run-up mid-hop (the oscillation that never clears the gap).
  if (run.launched) {
    // The tick right after the jump the bot is still EDGE-supported on the take-off block (ground=true
    // at feet just off the take-off), so we must wait until it has truly LEFT the ground before treating
    // "grounded" as landed — else we end the run mid-launch and re-init a backward BACKUP that kills the
    // forward momentum (the oscillation that collapsed speed to ~0 and dropped the bot straight down).
    if (!isGround) run.airborne = true;
    if (run.airborne && isGround) {
      rec("LAND");
      endParkourIfActive(rt);
      return "moving";
    }
    // Mid-air: keep holding forward + sprint and steering at the landing — a real sprint-jump carries
    // because the player holds W the whole arc (air control adds ~0.02/tick toward the facing). Without
    // it the hop drifts forward on decaying momentum alone and lands a fraction short (verified: it came
    // down at x≈2.7 needing x=3). A failed turn ends the drive (mustSetYaw), never a blind forward.
    mustSetYaw(
      rt,
      Math.atan2(-(run.landing.x + 0.5 - pos.x), run.landing.z + 0.5 - pos.z) * (180 / Math.PI),
    );
    rt.keys.set("key.forward", true);
    applySprint(rt, cfg, true);
    rec("AIR");
    return "moving";
  }
  // Act-on-truth: if the landing's floor vanished while we were setting up (mined away / changed),
  // abort rather than charge into a void — the per-tick veto we'd otherwise lose by owning the tick.
  if (
    !standableSurface(liveReader(rt), { x: run.landing.x, y: run.landing.y - 1, z: run.landing.z })
  ) {
    rec("ABORT_FLOOR_GONE");
    endParkourIfActive(rt);
    return blk("parkour.floorgone", "blocked_hazard");
  }
  // Stall guard: a run-up that never launches (boxed in, can't reach speed) → bail loud FAST, so a
  // wedged parkour (e.g. mis-fired after a fall, walls on every side) can't burn the whole goto budget.
  if (rt.tick() - run.startTick > cfg.nav.parkourStallTicks) {
    rec("STALL");
    endParkourIfActive(rt);
    return blk("parkour.stall", "blocked_no_path");
  }

  if (run.phase === "BACKUP") {
    const dxa = run.anchorX + 0.5 - pos.x;
    const dza = run.anchorZ + 0.5 - pos.z;
    if (Math.hypot(dxa, dza) <= cfg.drill.centerTol) {
      run.phase = "CHARGE";
      rec("BACKUP_DONE");
      return "moving";
    }
    mustSetYaw(rt, Math.atan2(-dxa, dza) * (180 / Math.PI)); // failed turn → drive ends, keys released
    rt.keys.set("key.forward", true);
    applySprint(rt, cfg, false); // a short precise back-up, then turn and charge
    rt.keys.set("key.jump", false);
    rec("BACKUP");
    return "moving";
  }

  // CHARGE: run toward the landing + hold sprint (for the launch boost — the charge itself only reaches
  // walk speed, aiStep clears the sprint mult); fire the jump at the takeoff far edge while sprinting.
  const dxl = run.landing.x + 0.5 - pos.x;
  const dzl = run.landing.z + 0.5 - pos.z;
  mustSetYaw(rt, Math.atan2(-dxl, dzl) * (180 / Math.PI)); // failed turn → drive ends, keys released
  rt.keys.set("key.forward", true);
  // The keybind alone caps at walk speed (verified), so force the vanilla sprint flag — this is what
  // gets the run-up to the ~0.28 b/tick a wide sprint-jump needs. Edge-triggered via applySprint, so
  // it fires once at charge start, not every tick (the per-tick mutation is the FOV-crash trigger).
  // NB: a parkour move therefore needs cfg.nav.sprint ON to reach launch speed.
  applySprint(rt, cfg, true);
  const nearFarEdge = across >= cfg.nav.parkourFarEdge; // at the far lip of the take-off → jump NOW so the arc starts at the
  // block edge and clears the gap (launching early, mid-cell, wastes the arc over the solid take-off)
  const atSprintSpeed = speed >= cfg.nav.parkourTakeoffSpeed;
  const sprintJump = run.dist >= 4; // dist-4 needs real sprint; dist 2-3 clear from walk speed (Baritone)

  // Only LAUNCH at the far edge (Baritone times the jump to the take-off lip too). Until then keep
  // charging — carry the sprint across the take-off cell rather than jumping from its near edge.
  if (isGround && onTakeoff && nearFarEdge) {
    if (!atSprintSpeed && sprintJump) {
      // dist-4 at the edge without sprint speed would undershoot into the void. The "better than
      // Baritone" rule: never commit a jump we can't complete → ABORT and let the planner bridge the
      // gap instead (parkourGaveUp). Baritone jumps here and falls; we refuse.
      parkourGaveUp = true;
      rec("ABORT_UNDERPOWERED");
      endParkourIfActive(rt);
      return "moving"; // next tick replans with parkour off → bridges the gap, no fall
    }
    // Fast enough (any distance) or a dist 2-3 walk-jump → fire the REAL jump. The key.jump keybind
    // doesn't reliably leave the ground (verified: launches stayed grounded), so call jumpFromGround;
    // while sprinting it adds the sprint-jump forward boost. reliability-ok: a failed jump just doesn't
    // leave the ground this tick — the run-up keeps charging and retries next tick.
    rt.keys.set("key.jump", true);
    void rt.player.jump();
    run.launched = true;
    rec("LAUNCH");
    return "moving";
  }
  rt.keys.set("key.jump", false);
  rec("CHARGE");
  return "moving";
}
