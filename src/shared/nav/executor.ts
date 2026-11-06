import { offsetToFace } from "@/core/prim/face";
import { canSurviveFall } from "@/core/prim/movement-physics";
import { floorVec, sameCell } from "@/core/prim/pos";
import type { Runtime } from "@/core/runtime/Runtime";
import type { Vec3 } from "@/core/runtime/types";
// Greedy executor — the own key-driven local navigator, the ONLY field-movement
// driver now that Baritone is removed. Per tick: plan a path over the
// world-view cache (plan-on-cache), take the first step, VETO it against the LIVE world
// (act-on-truth), then steer (setRotation) + walk (key.forward, + key.jump to step up).
//
// Live-proven flat/climb/descend/exact/route-around. A "blocked_*" result never pushes on — the
// navigation capability logs it loudly and fails fast (ERROR) or escalates (RECOVER → teleport).
//
// Depends only on (Runtime, Config), NOT the kernel Ctx: the executor touches the facade
// (keys/rotation/world reads) but owns no phase logic, so the navigation capability handles
// transitions/divert. That keeps it unit-testable on the mock runtime, and the hard logic
// (pathfinding, hazard classification, fall damage) stays in the tested pure domain layer.
import type { Config } from "@/shared/config/schema";
import { engageable } from "@/shared/domain/dstar";
import { type Goal, GoalBlock, GoalNear, GoalXZ } from "@/shared/domain/goal";
import { type MoveKind, columnKey, neighbors } from "@/shared/domain/movement-types";
import {
  type CostContext,
  DEFAULT_COST,
  DEFAULT_PLANNER_OPTS,
  type PlannerOpts,
  planPath,
  smoothPath,
} from "@/shared/domain/planner";
import {
  type BlockReader,
  breakableSolid,
  climbableAt,
  groundUnder,
  hazardAt,
  passableCell,
  standableSurface,
  submergesAt,
  walkableAt,
} from "@/shared/domain/senses";
import { type BreakRun, freshBreakRun, stepBreak } from "@/shared/nav/break-cell";
import {
  type GreedyStep,
  applySprint,
  greedyRelease,
  liveReader,
  mustOnGround,
  mustSetYaw,
  reassertKeys,
  releaseForBlockingWork,
  resetSprintFlag,
} from "@/shared/nav/core";
import { descentUnrecoverable, updateDescentRim } from "@/shared/nav/descent";
import { ladderStep } from "@/shared/nav/ladder";
import {
  endParkourIfActive,
  initParkourRun,
  parkourActive,
  parkourGaveUpLatched,
  parkourStep,
  resetParkour,
} from "@/shared/nav/parkour";
import { endPillarIfActive, pillarState, pillarStep, resetPillar } from "@/shared/nav/pillar";
import { type PlaceLogger, type PlaceRun, freshPlaceRun, stepPlace } from "@/shared/nav/place-cell";
import {
  beginGreedyCall,
  blk,
  commitNext,
  dstarNext,
  invalidateRoute,
  navCachingReader,
  resetRoutes,
  routeNext,
  step,
} from "@/shared/nav/route";
import { hasFillerInBag, hasWaterBucketInBag, peerAvoidColumns } from "@/shared/nav/supply";

/** Clear the greedy planner's world-view cache (dimension change / fresh nav). */
export function resetGreedyNav(): void {
  resetRoutes(); // world-view cache + cached A*/D* routes + commit hysteresis + diag counters
  resetPillar();
  navBreak = freshBreakRun();
  navPlace = freshPlaceRun();
  resetParkour(); // run machine + give-up latch (per-drive) + the debug trace reads clean
  stairSprint = { active: false, sx: 0, sz: 0 }; // drop the sticky stair-sprint latch
  resetSprintFlag(); // drop the sprint edge-trigger cache (a fresh leg starts un-sprinted)
}

// Sticky ascending-stair sprint latch (cfg.nav.sprintStairs). A staircase is a
// chain of JUMPS; a stateless "sprint this +1 step" rule drops sprint every step because the per-tick
// runway re-check flickers mid-arc as `feet.y` crosses block levels (measured in-game). So we LATCH:
// arm on a grounded ascending step whose ascent continues, hold sprint through the airborne arc, and
// release on the final step / flat landing. `sx,sz` pin the climb heading so a mid-arc re-aim can't
// re-key it sideways. Reset per drive by resetGreedyNav().
let stairSprint: { active: boolean; sx: number; sz: number } = { active: false, sx: 0, sz: 0 };

// — Mine-drive ——————————————————————————————————————————————————————————————————————————
// When the planner picks a mineTraverse/mineAscend move (gated on cfg.nav.mine), the next cell — or
// its head, or the jump headroom over the take-off — is SOLID in the plan: the executor must
// break-then-step, so the navigator owns DIG_TO instead of a dedicated phase. We reuse the shared
// AIM→BREAK routine (break-cell stepBreak) rather than re-rolling a breaker. `navBreak` is a module
// singleton like pillarRun; stepBreak re-keys it per target so switching cells restarts cleanly.
let navBreak: BreakRun = freshBreakRun();

/** The cells that must be CLEAR (air/passable) for a 2-tall player to enter `next` from `feet`: the
 *  destination feet + head, plus — for a step UP — the jump headroom over the take-off column. A
 *  mine-move plans these solid; a normal walk/step has them already passable. */
function stepClearCells(feet: Vec3, next: Vec3): Vec3[] {
  const cells: Vec3[] = [next, { x: next.x, y: next.y + 1, z: next.z }];
  if (next.y > feet.y) cells.push({ x: feet.x, y: feet.y + 2, z: feet.z });
  return cells;
}

/** Break-then-step for a planned mine-move. Returns a GreedyStep when it OWNS the tick (breaking a
 *  blocker, or refusing an unbreakable one), or `null` when the step's occupancy cells are all clear
 *  in the LIVE world — the caller then falls through to the normal walk/jump driver. Gated by the
 *  caller on cfg.nav.mine. Stands still while breaking (the breaker drives rotation, not movement). */
function driveMineStep(rt: Runtime, cfg: Config, feet: Vec3, next: Vec3): GreedyStep | null {
  const live = liveReader(rt);
  // A climbable cell (ladder/vine) entered horizontally is NOT a mine target — the body clings to it
  // (ladderEnter), so skip it here and let the walk driver mount it. Without this, the ladder cell
  // reads non-passable + breakable and we'd wrongly tear the ladder down instead of climbing it.
  const blocked = stepClearCells(feet, next).filter(
    (c) => !passableCell(live, c) && !climbableAt(live, c),
  );
  const cell = blocked[0];
  if (!cell) return null; // nothing solid in the way → a normal walk/step owns it
  if (hazardAt(live, cell)) return null; // a hazard isn't a mine target → let the hazard veto classify it
  greedyRelease(rt); // hold position; never walk into an unbroken block
  if (!breakableSolid(live, cell)) return blk("mine.unbreakable", "blocked_no_path"); // unbreakable appeared where we planned to mine
  return stepBreak(rt, cfg, rt.tick(), navBreak, cell, "TOP") === "timeout"
    ? "blocked_no_path"
    : "moving";
}

/** Mine-then-drop for a planned mineDown (descend straight down through rock). The vertical
 *  counterpart to pillarStep: break the floor cell `next` (= feet−1, same X/Z), then gravity drops the
 *  bot into the cleared cell next tick. Returns a GreedyStep when it OWNS the tick (breaking the floor,
 *  or refusing an unbreakable/hazard one), or `null` when the floor is ALREADY open in the LIVE world
 *  (let gravity carry the drop). Gated by the caller on cfg.nav.mine. The break routine aims straight
 *  down (lookAt) and confirms; stands still while breaking. */
function driveMineDownStep(rt: Runtime, cfg: Config, next: Vec3): GreedyStep | null {
  const live = liveReader(rt);
  if (passableCell(live, next)) return null; // floor already gone → gravity owns the drop
  if (hazardAt(live, next)) return blk("minedown.hazard", "blocked_hazard"); // never mine into lava below
  greedyRelease(rt); // hold position; the breaker drives the downward aim, not movement
  if (!breakableSolid(live, next)) return blk("minedown.unbreakable", "blocked_no_path"); // bedrock/liquid where we planned to dig
  return stepBreak(rt, cfg, rt.tick(), navBreak, next, "TOP") === "timeout"
    ? "blocked_no_path"
    : "moving";
}

// — Bridge-drive ————————————————————————————————————————————————————————————————————————————
// The place-side analogue of the mine-drive: when the planner picks a bridgePlace (gated on
// cfg.nav.bridge), the next cell is open but its FLOOR is a gap — the executor must lay filler under
// it before stepping in, else the step-hazard veto would (correctly, for a non-bridger) read the void
// and refuse. We reuse the shared place routine (place-cell stepPlace) rather than re-rolling it.
// `navPlace` is a module singleton like navBreak; stepPlace re-keys it per target. The filler stays
// equipped between cells; the held tool is restored (savedSlot, like the pillar) when bridging ends.
let navPlace: PlaceRun = freshPlaceRun();

/** Restore the mining tool after a bridge run and reset the place machine. Called when the executor
 *  takes a non-bridge action so the bot doesn't keep holding filler. No-op if no bridge is in flight. */
function endBridgeIfActive(rt: Runtime): void {
  if (navPlace.savedSlot < 0) return;
  const invR = rt.inv.open();
  if (invR.ok) invR.value.selectHotbar(navPlace.savedSlot);
  navPlace = freshPlaceRun();
}

/** Place-then-step for a planned bridgePlace. Returns a GreedyStep when it OWNS the tick (laying the
 *  floor, or refusing with no filler / no support), or `null` when the next cell's floor is already
 *  present in the LIVE world — the caller falls through to the walk driver. The support is the block
 *  under the CURRENT feet (real on the first bridge, the just-placed floor on a chained one — the bot
 *  always stands on something, matching the optimistic planner). Gated by the caller on cfg.nav.bridge. */
export function driveBridgeStep(
  rt: Runtime,
  cfg: Config,
  feet: Vec3,
  next: Vec3,
  log?: PlaceLogger,
): GreedyStep | null {
  if (next.y !== feet.y) return null; // bridges keep the level (a +1/-1 step isn't a bridge)
  if (climbableAt(liveReader(rt), next)) return null; // a ladderEnter, not a bridge — let the walk driver mount it
  // Only a CARDINAL 1-cell step is a bridgePlace (the move is cardinal-only; see movement-types).
  // A parkour landing (≥2 cells away) or a diagonal isn't — it must fall through to the walk/jump
  // driver, else we'd try to lay filler at the far parkour cell against a non-adjacent face.
  if (Math.abs(next.x - feet.x) + Math.abs(next.z - feet.z) !== 1) return null;
  const live = liveReader(rt);
  const floor = { x: next.x, y: next.y - 1, z: next.z };
  if (standableSurface(live, floor)) return null; // floor present → a normal walk owns it
  const support = { x: feet.x, y: feet.y - 1, z: feet.z };
  if (!standableSurface(live, support)) {
    // The reader sees no standable block under our feet, yet the planner's bridgePlace presumes we're
    // standing on the bridge head. Neither real case is a true "can't bridge", so we never hard-block:
    //  • AIRBORNE: `feet` is a TRANSIENT floating cell sampled mid-fall (a sprint-descent is airborne
    //    for many consecutive ticks), so its floor reads as void — the airborne-replan race, here in the
    //    bridge path instead of the !next path. HOLD the committed heading and RIDE THE FALL OUT; we
    //    replan from a real cell once we land. (This was the deterministic surface-descent block: at 20Hz
    //    production GOTO a sprinted drop reliably samples a floating cell mid-fall and false-blocked here,
    //    while slow single-stepping "arrived" only because it LANDS between samples.)
    //  • ON THE GROUND: the bot is perched on a block the (snow-blind / cache-stale) reader can't classify
    //    as a surface — a deep snow layer the planner walks "through" while physics rests us ON it. There
    //    is no gap to span; fall through to the walk driver, which steps us forward off the perch under
    //    the live hazard veto onto a cell the reader CAN see one tick later.
    if (!mustOnGround(rt)) return "moving"; // airborne → hold the heading, ride the fall to a real cell
    return null; // grounded perch → defer to the walk driver (no spurious bridge)
  }
  const face = offsetToFace(floor.x - support.x, floor.y - support.y, floor.z - support.z);
  if (!face) return blk("bridge.noface", "blocked_no_path");
  greedyRelease(rt); // hold position while the place lands (forward/sprint off → no slide into the gap)
  const outcome = stepPlace(rt, cfg, rt.tick(), navPlace, floor, support, face, log);
  return outcome === "no_filler" || outcome === "timeout" ? "blocked_no_path" : "moving";
}

/** Is stepping onto `cell` unsafe RIGHT NOW (live read)? A confirmed hazard at the cell or the
 *  block under it, a VOID (no standable surface within the safe drop), or a drop whose fall damage
 *  exceeds tolerance. The void case is the act-on-truth net for a parkour/step the (cached) plan
 *  aimed at a cell whose floor has since gone — without it a planned landing over a now-open pit
 *  slips through (groundUnder→null skipped the fall-damage check) and the bot jumps into the void. */
function stepIsHazardous(rt: Runtime, cfg: Config, cell: Vec3): boolean {
  const read = liveReader(rt);
  if (hazardAt(read, cell)) return true;
  if (hazardAt(read, { x: cell.x, y: cell.y - 1, z: cell.z })) return true;
  // Drown veto: stepping into head-deep water is a DROWN trap (water isn't a classifyBlock hazard,
  // so this is a separate check). Refuse both the step cell itself and the landing below it — the
  // flooded-ravine column that drowned the bot (walked off a rim into deep water). Wading through
  // 1-deep water (head clear) is not submerging, so it stays allowed.
  if (submergesAt(read, cell)) return true;
  const ground = groundUnder(read, cell, cfg.nav.maxDrop + 1);
  if (!ground) return true; // no safe landing in range → a void; never step/jump in
  // Fall-damage veto — clutch-aware so it can NEVER veto a fall the water-clutch would save (the
  // whole point of canSurviveFall). Gated on the SAME bucket check the planner uses to offer a
  // waterDrop dive, so the executor's act-on-truth net stays in lockstep with the planned route:
  // no bucket → vetoes a fatal drop as before; bucket carried + dives enabled → trusts the clutch.
  const clutch = cfg.nav.waterDrop && hasWaterBucketInBag(rt, cfg);
  if (!canSurviveFall(ground.drop, { maxFallDamage: cfg.nav.maxFallDamage, clutch })) return true;
  if (submergesAt(read, { x: cell.x, y: ground.y + 1, z: cell.z })) return true; // lands under deep water → drown
  return false;
}

/** Per-call navigation intent. The arrival SEMANTICS is a Goal TYPE now (column vs radius), not a
 *  pile of booleans threaded through the executor — see domain/goal.ts. */
export interface GreedyOpts {
  /** GoalNear radius — how close (continuous) counts as arrived. Default cfg.nav.gotoArrivalDist. */
  arrivalRadius?: number;
  /** True → a GoalXZ column approach: Y is ignored in BOTH the heuristic and arrival, so the
   *  planner never chases the column's unknown Y uphill (the walk-to-vein wander). The caller that
   *  owns Y (e.g. DESCEND) takes over once the column is reached. */
  column?: boolean;
  /** True → a GoalBlock EXACT-cell approach (arrive when feet are IN the target cell, `target` floored).
   *  Use this to walk INTO a specific cell (EXCAVATE/DIG_TO corridor steps) instead of a GoalNear
   *  radius: a sub-block radius (e.g. cfg.drill.centerTol 0.2) around a cell CENTER can never be satisfied by
   *  the planner — planPath tests INTEGER cells and the closest cell coord is ~0.87 from its own centre —
   *  so a GoalNear corridor step to a *different* cell always blocks (blocked_no_path). GoalBlock floors,
   *  so cell membership matches. Ignores arrivalRadius. */
  block?: boolean;
  /** Approach the closest reachable cell when the exact goal is unreachable (vs blocking) — for a
   *  column approach this is what lets greedy walk up to a vein whose surface it can't yet path to. */
  bestEffort?: boolean;
  /** Domain edge-cost overlay (default = raw movement cost). */
  cost?: CostContext;
  /** Optional journal sink so the in-engine bridge (driveBridgeStep → stepPlace) emits PLACE_CELL —
   *  the Ctx-free executor logs nothing by default; a mission phase passes ctx.log to make the silent
   *  filler-placement observable (restores the event the deleted dedicated BRIDGE phase used to emit). */
  log?: PlaceLogger;
}

/** Project a horizon sub-goal `horizonBlocks` along the straight line from `feet` toward `target`,
 *  CARRYING the leg's elevation intent. A surface leg gets a GoalNear whose interpolated Y sits on the
 *  feet→target line, so the planner's octile+LEVEL heuristic penalises drifting off that line in Y —
 *  the bot contours toward an elevated/level goal instead of treating a descent as free progress. A
 *  plain Y-blind GoalXZ caused the live valley-dive: a 56-block roughly-level leg over a snowy peak
 *  routed 43 blocks DOWN into a valley because dropping cost the XZ sub-goal nothing. Column/drill legs
 *  keep GoalXZ (the drill owns Y after reaching the column). bestEffort is set by the caller, so a
 *  mis-guessed interpolated Y only steers the search — it never blocks the leg. Pure → unit-tested. */
export function horizonSubGoal(
  feet: Vec3,
  target: Vec3,
  horizonBlocks: number,
  column: boolean,
  radius: number,
): Goal {
  const dXZ = Math.hypot(target.x - (feet.x + 0.5), target.z - (feet.z + 0.5)) || 1;
  const t = horizonBlocks / dXZ; // < 1 here (caller only projects when target is beyond the horizon)
  const hx = Math.round(feet.x + (target.x - (feet.x + 0.5)) * t);
  const hz = Math.round(feet.z + (target.z - (feet.z + 0.5)) * t);
  if (column) return new GoalXZ(hx, hz);
  const hy = Math.round(feet.y + (target.y - feet.y) * t);
  return new GoalNear({ x: hx, y: hy, z: hz }, radius);
}

/** The movement keys a replan released (filled by astarSeams' replan, read by AIRBORNE-HOLD). */
interface HeldKeys {
  keys: readonly string[];
}

/** The A* route seams for one greedyStep call: the full replan and the cheap edge check. `held`
 *  receives the movement keys the replan released. */
function astarSeams(
  rt: Runtime,
  cfg: Config,
  feet: Vec3,
  planGoal: Goal,
  planOpts: PlannerOpts,
  cost: CostContext | undefined,
  held: HeldKeys,
): Parameters<typeof routeNext>[5] {
  return {
    replan: () => {
      // A full A* blocks this worker tick; a key still held from the last drive keeps walking the
      // body the whole time with no veto running (RCA I-4). Release first; the drive after the plan
      // re-asserts what the fresh route wants.
      held.keys = releaseForBlockingWork(rt);
      const reader = navCachingReader(rt, cfg);
      // planGoal = the horizon sub-goal when far, else the real goal (exact arrival within the horizon)
      const r = planPath(reader, feet, planGoal, planOpts, cost);
      // String-pull the route straight on flat runs (sprint holds through detours). Same reader →
      // the LOS smoothing sees the same cells the search did; the executor's live veto still guards.
      if (!r || !cfg.nav.smoothPath) return r;
      const sm = smoothPath(reader, r.path, r.kinds);
      return { ...r, path: sm.path, kinds: sm.kinds };
    },
    edgeValid: (from, to) =>
      neighbors(navCachingReader(rt, cfg), from, planOpts).some((m) => sameCell(m.to, to)),
  };
}

/** An internal executor outcome: a terminal GreedyStep, OR `PLAN_STALE` — a driver's LIVE
 *  precondition contradicted the planner's chosen policy (a ladder appeared/vanished under the bot, a
 *  parkour take-off was refused). PLAN_STALE never escapes greedyStep: it invalidates the cached route
 *  and forces an immediate replan from live truth (the ONLY escape from a policy is a typed replan — no
 *  silent driver substitution), resolving to a real GreedyStep this same tick. */
const PLAN_STALE = "plan_stale" as const;
type StepOutcome = GreedyStep | typeof PLAN_STALE;

/**
 * Drive ONE tick of greedy navigation toward `target` (a stand position / column). Returns:
 *   "arrived"         — the Goal's arrival test is met (keys released);
 *   "blocked_no_path" — the planner found no route to the goal in the cache (keys released);
 *   "blocked_hazard"  — a route exists but the next step failed the live hazard veto (keys
 *                       released); the caller logs loud + fails fast / escalates;
 *   "moving"          — steering + walking this tick.
 *
 * The move DISPATCH is policy-driven: the planner's `MoveKind` for the committed cell selects
 * the driver (a `switch`, not a geometry re-derivation). A driver whose live precondition contradicts its
 * policy returns PLAN_STALE, which invalidates the route and replans HERE (bounded to one retry via
 * `retried`) — the old inline geometry-sniff + parkour self-re-entry are gone.
 */
export function greedyStep(
  rt: Runtime,
  cfg: Config,
  target: Vec3,
  opts: GreedyOpts = {},
  retried = false,
): GreedyStep {
  beginGreedyCall(rt.tick());
  // The arrival semantics IS the goal type: a column (Y-free, walk-to-X/Z) or a radius around the
  // point ("good enough to act", default cfg.nav.gotoArrivalDist). The planner + arrival both read it.
  const goal: Goal = opts.column
    ? new GoalXZ(Math.floor(target.x), Math.floor(target.z))
    : opts.block
      ? new GoalBlock(floorVec(target))
      : new GoalNear(target, opts.arrivalRadius ?? cfg.nav.gotoArrivalDist);

  const posR = rt.player.pos();
  if (!posR.ok) return "moving"; // can't sense this tick — hold position, don't thrash keys
  const pos = posR.value;
  const feet = floorVec(pos);

  // An in-flight pillar ascent OWNS the tick until it finishes — it is multi-tick, and the generic
  // planner would misread the mid-jump apex (floor(y) transiently reads +1) as "arrived a block
  // early" or fall into a no-step micro-walk that resets the climb. So while climbing the same
  // column we keep driving pillarStep, and only declare "arrived" once GROUNDED in the goal (never
  // mid-jump — the caller, e.g. MINE, must not act airborne). If the goal is no longer straight
  // overhead (target moved / we rose past it), end the ascent and fall through to normal planning.
  const pillar = pillarState();
  if (pillar.active) {
    const grounded = mustOnGround(rt);
    if (grounded && goal.isInGoal(pos)) {
      endPillarIfActive(rt);
      greedyRelease(rt);
      return "arrived";
    }
    const sameColumn = pillar.colX === feet.x && pillar.colZ === feet.z;
    if (sameColumn && (!grounded || target.y > feet.y)) {
      const up = { x: pillar.colX, y: feet.y + 1, z: pillar.colZ };
      return step("pillar", feet, up, pillarStep(rt, cfg, up));
    }
    endPillarIfActive(rt); // ascent no longer applies — restore the tool, plan normally
  }

  // An in-flight parkour run-up OWNS the tick (like the pillar): backing up to make runway moves the
  // bot AWAY from the takeoff, so re-planning would lose the parkour (it stops being path[1]). We keep
  // driving parkourStep until it launches + lands, declaring "arrived" only once GROUNDED in the goal.
  if (parkourActive()) {
    if (mustOnGround(rt) && goal.isInGoal(pos)) {
      endParkourIfActive(rt);
      return "arrived";
    }
    return parkourStep(rt, cfg);
  }

  if (goal.isInGoal(pos)) {
    endBridgeIfActive(rt); // arrived (possibly off a final bridge cell) → hand the tool back
    greedyRelease(rt);
    return "arrived";
  }

  // pillarUp + bridgePlace both spend filler, so both are gated on a live bag check (the pure planner
  // can't read inventory; act-on-truth re-checks at place time). One read serves both; each is also
  // gated on its cfg flag. Reading the inventory is cheap and the drill already does it per tick.
  const carriesFiller = hasFillerInBag(rt, cfg);
  const canPillar = cfg.nav.pillar && carriesFiller;
  const canBridge = cfg.nav.bridge && carriesFiller;
  const goalKey = `${Math.floor(target.x)},${Math.floor(target.y)},${Math.floor(target.z)},${opts.column ? 1 : 0}`;
  updateDescentRim(goalKey, feet.y); // raise the leg's rim before the descent veto reads it

  // HORIZON-BOUNDED first plan: when the goal is far, aim the SEARCH at a sub-goal projected
  // `cfg.nav.horizonBlocks` along the straight line toward it, so the first (cold-cache) plan reads only the
  // local horizon instead of the whole distance (the multi-second worker freeze). The bot still heads at
  // the real goal — the sub-goal sits on the line — and each extend-replan re-projects further along, so
  // a far goal is reached in segments. Within the horizon the search aims at the real goal directly (exact
  // arrival preserved). The route cache's `complete` flag is computed against the REAL goal (passed to
  // routeNext), so a sub-goal segment reads as incomplete and extends before it runs dry.
  const goalDistXZ = Math.hypot(target.x - (feet.x + 0.5), target.z - (feet.z + 0.5));
  const horizon = cfg.nav.horizonBlocks > 0 && goalDistXZ > cfg.nav.horizonBlocks;
  let planGoal: Goal = goal;
  if (horizon) {
    planGoal = horizonSubGoal(
      feet,
      target,
      cfg.nav.horizonBlocks,
      opts.column ?? false,
      opts.arrivalRadius ?? cfg.nav.gotoArrivalDist,
    );
  }
  // Peer-as-obstacle: block the columns nearby peers occupy this tick. The explicit GOAL column is
  // always exempt — the follow mission's whole job is walking TO a peer, and a caller-chosen goal
  // outranks clearance (arrival radius stops us before contact anyway).
  const avoid = peerAvoidColumns(rt, cfg);
  if (avoid) {
    const tgtCol = floorVec(target);
    avoid.delete(columnKey(tgtCol.x, tgtCol.z));
  }
  const planOpts = {
    ...DEFAULT_PLANNER_OPTS,
    ...(avoid ? { avoid } : {}), // exactOptionalPropertyTypes: omit, never `avoid: undefined`
    maxDrop: cfg.nav.maxDrop,
    maxFallDamage: cfg.nav.maxFallDamage,
    // Parkour is disabled for the rest of this leg once a run-up arrived at a takeoff too slow for a
    // dist-4 sprint-jump (parkourGaveUp): replanning would just re-offer the same parkour and the
    // executor would abort again — an oscillation. Disabling it lets the planner bridge the gap instead.
    parkour: cfg.nav.parkour && !parkourGaveUpLatched(),
    maxParkour: cfg.nav.parkourMaxGap + 1,
    parkourPenalty: cfg.nav.parkourPenaltyTicks,
    canPillar,
    pillarPenalty: cfg.nav.pillarPenaltyTicks,
    mine: cfg.nav.mine,
    breakCost: cfg.nav.breakCostTicks,
    bridge: canBridge,
    bridgePenalty: cfg.nav.bridgePenaltyTicks,
    bridgeMaxRun: cfg.nav.bridgeMaxRun,
    // Proactive water-clutch dive: only plan one when a bucket is actually carried (the emergency
    // reflex catches the fall — no executor branch needed; the planned `next` is the safe landing).
    waterDrop: cfg.nav.waterDrop && hasWaterBucketInBag(rt, cfg),
    waterDropMaxDrop: cfg.nav.waterDropMaxDrop,
    waterDropPenalty: cfg.nav.waterDropPenaltyTicks,
    // Ladder moves cost nothing and apply only where a climbable already exists — no bag check, so
    // they ride along with whatever else is enabled (lets the bot reach an upper floor via a ladder
    // instead of pillaring). The executor's ladderStep drives the climb.
    ladder: cfg.nav.ladder,
    // Amortized reversal cost: charge each block of drop a fraction of its own climb-back so A* prefers a
    // flat/around/bridge route over an unnecessary descent (the soft side of the descent guard).
    descentPenalty: cfg.nav.descentPenaltyTicks,
    // A horizon sub-goal is a "get closer" plan whose projected column may float (no exact landing), so
    // it always runs best-effort; only the final in-horizon segment honours the leg's real arrival mode.
    bestEffort: horizon ? true : (opts.bestEffort ?? false),
  };
  // ROUTE: serve the next step. Two engines behind the SAME next-cell contract:
  //  - D* Lite (cfg.nav.dStar, point goal, bounded move set): one goal-rooted tree REPAIRED per tick —
  //    plans the whole traverse ahead (no horizon), cheap incremental updates. The thesis: "incremental
  //    is the right algorithm for a self-modifying world." Filler/mine moves keep A* (unbounded preds).
  //  - A* + route cache (default): full A* only when the cached route invalidates or runs low; the
  //    `replan`/`edgeValid` thunks fire the expensive search ONLY when needed (no per-tick A* storm).
  const useDStar = cfg.nav.dStar && !opts.column && engageable(planOpts);
  // The movement keys the last drive held, released for the duration of a replan (astarSeams); only
  // the AIRBORNE-HOLD branch puts them back, every other path re-drives or releases on its own.
  const heldBeforePlan: HeldKeys = { keys: [] };
  const planned = useDStar
    ? dstarNext(rt, cfg, feet, floorVec(target), goalKey, planOpts, opts.cost ?? DEFAULT_COST)
    : routeNext(
        rt,
        cfg,
        feet,
        goal,
        goalKey,
        astarSeams(rt, cfg, feet, planGoal, planOpts, opts.cost, heldBeforePlan),
      );
  // The cache-served first step is run through commit-to-choice: a standing commitment overrides an
  // equal-cost flip (anti-oscillation), and carries the bot off a ledge when `planned` is undefined.
  const next = commitNext(rt, cfg, feet, goal, goalKey, planned, rt.tick());
  if (!next) {
    // AIRBORNE-HOLD: if we're mid-fall / mid-jump-arc, `feet` is a TRANSIENT floating
    // floorVec cell with no standable floor under it, so routeNext.replan() from it intermittently
    // finds no route — and we'd emit a SPURIOUS blocked_no_path. This was the per-tick surface-descent
    // block: a sprinted descent is airborne for many consecutive ticks, so at 20 Hz (production GOTO)
    // it reliably samples a "bad" floating cell and blocks, while slow single-stepping "arrives" only
    // because it LANDS between samples. So while not grounded, HOLD the committed heading — the keys
    // driveWalkStep asserted when we stepped off the ledge stay held (jsMacros re-asserts them), and
    // the drop was hazard-vetoed at step-off — and re-plan next tick once we've settled on a real cell.
    // Pillar/parkour arcs own the tick ABOVE this, so here airborne ⇒ a plain fall/step we ride out.
    if (!mustOnGround(rt)) {
      reassertKeys(rt, heldBeforePlan.keys); // a replan this tick released them; the hold keeps the heading
      return "moving";
    }

    endPillarIfActive(rt); // not climbing this tick — hand the tool back if an ascent was in flight
    endBridgeIfActive(rt); // not bridging either — restore the tool if a bridge run was in flight
    // No planned step beyond the current cell. The planner stops the route at the first CELL whose
    // integer corner satisfies the goal, but arrival (line above) tests the RAW player position — and
    // for a radius goal part of that final cell can lie OUTSIDE the radius (corner at √2·cell further).
    // Entering the final cell from the far side therefore lands here: route consumed, pos not yet in
    // radius. The doorstep test must mirror the planner's own stop test — feet cell in-goal — and
    // micro-walk the remaining sub-cell distance instead of "blocking" on the doorstep. (For GoalBlock
    // this degenerates to the exact-cell check; a column goal can't reach here: feet in column ⇒ arrived.)
    const inGoalCell = !opts.column && goal.isInGoal(feet);
    if (!inGoalCell) {
      greedyRelease(rt);
      return blk("nonext.notingoal", "blocked_no_path");
    }
    // setYaw (not setRotation): leave the pitch alone so the camera doesn't snap to level between
    // a downward break aim and a centring nudge (the DESCEND 0↔90 jerk). A failed turn ends the
    // drive before forward is pressed (mustSetYaw).
    mustSetYaw(rt, Math.atan2(pos.x - target.x, target.z - pos.z) * (180 / Math.PI));
    rt.keys.set("key.forward", true);
    rt.keys.set("key.jump", false);
    rt.keys.set("key.sprint", false); // never sprint the final settle — keep the stop short
    return "moving";
  }
  // POLICY DISPATCH: the planner already classified this move; drive that policy directly
  // instead of re-deriving it from `feet → next` geometry. A driver whose live precondition contradicts
  // its policy returns PLAN_STALE → invalidate the route + replan from live truth THIS tick (bounded to
  // one retry). No geometry sniffing, no silent driver swap, no self-re-entry.
  const live = liveReader(rt); // one act-on-truth reader for the dispatch preconditions
  const outcome = dispatchStep(rt, cfg, feet, next.cell, next.kind, pos, target, opts, live);
  if (outcome !== PLAN_STALE) return outcome;
  invalidateRoute(); // the cached policy diverged from the live world → drop it and replan fresh
  if (retried) return blk("planstale.persist", "blocked_no_path"); // still stale after a replan → fail loud
  return greedyStep(rt, cfg, target, opts, true);
}

/**
 * Dispatch the committed step by its planner POLICY `kind`. Each case validates its LIVE
 * precondition and either drives its sub-machine, cleanly ADVANCEs (a mine/bridge whose obstruction is
 * already gone → the underlying walk/gravity), or returns PLAN_STALE (the live world contradicts the
 * policy → the caller replans). Behaviour-identical to the old geometry if-ladder on the happy path
 * (plan == live); divergences that the old code handled by a SILENT live-override now route through the
 * typed replan. The end-pillar / end-bridge tool restores match the old fall-through order exactly.
 */
function dispatchStep(
  rt: Runtime,
  cfg: Config,
  feet: Vec3,
  nextCell: Vec3,
  kind: MoveKind,
  pos: Vec3,
  target: Vec3,
  opts: GreedyOpts,
  live: BlockReader,
): StepOutcome {
  // — Vertical UP: a pillarUp (place filler up a sheer wall) or a ladder climb/top-out. The planner
  // emits pillarUp only where NO climbable exists and ladderUp only where one DOES; if the live world
  // now contradicts that (a ladder appeared under a planned pillar, or vanished under a planned ladder),
  // it is a PLAN_STALE — the fresh plan re-decides authoritatively, not a silent driver swap.
  if (kind === "pillarUp") {
    if (cfg.nav.ladder && (climbableAt(live, nextCell) || climbableAt(live, feet)))
      return PLAN_STALE;
    return step("pillar", feet, nextCell, pillarStep(rt, cfg, nextCell));
  }
  if (kind === "ladderUp") {
    endPillarIfActive(rt); // a ladder needs no filler — hand the mining tool back
    if (!(climbableAt(live, nextCell) || climbableAt(live, feet))) return PLAN_STALE;
    return step("ladder", feet, nextCell, ladderStep(rt, feet, nextCell));
  }
  endPillarIfActive(rt); // any non-pillar/non-ladderUp policy ends an in-flight ascent (tool restore)

  // A ladderDown descends an existing ladder — a column-aligned vertical the walk/mine drivers can't
  // own. It is EXEMPT from the descent veto below (reversible by climbing); handled before it.
  if (kind === "ladderDown") {
    if (!climbableAt(live, nextCell)) return PLAN_STALE; // the ladder vanished → replan
    return step("ladder", feet, nextCell, ladderStep(rt, feet, nextCell));
  }

  // DESCENT RECOVERABILITY VETO (viability kernel / RCSPP) — a hard SAFETY gate, not a geometry
  // re-derivation. A descending step that would sink the bot deeper below the leg's rim than it can
  // recover (free allowance + carried filler) is REFUSED before the mine/bridge/walk drives commit it,
  // so a surface leg can't dive into a ravine it can't climb out of. Kept as a loud blocked_no_path (NOT
  // a PLAN_STALE): the pure planner has no rim model, so a replan would re-offer the same drop → wedge;
  // the refusal propagates to the navigation capability, which skips the stop gracefully.
  if (descentUnrecoverable(rt, cfg, feet, nextCell, Math.floor(target.y))) {
    greedyRelease(rt);
    return blk("descent.unrecoverable", "blocked_no_path");
  }

  // A mineDown bores straight down through rock (the break-then-drop machine). A climbable appearing
  // below is a PLAN_STALE (don't tear out a ladder we should descend); a floor already cleared this tick
  // is an ADVANCE (gravity carries the drop — the explicit within-tick completion).
  if (kind === "mineDown") {
    if (cfg.nav.ladder && climbableAt(live, nextCell)) return PLAN_STALE;
    const dug = driveMineDownStep(rt, cfg, nextCell);
    if (dug === null) return advance(rt, cfg, feet, nextCell, pos, target);
    return step("mineDown", feet, nextCell, dug);
  }

  // A mine-move (mineTraverse / mineAscend / mineDescend): the next cell / head / jump headroom are
  // SOLID in the plan, so break them before stepping in (DIG_TO folded into the engine). An already-open
  // path is an ADVANCE (walk the now-clear step) — the explicit within-tick completion.
  if (kind === "mineTraverse" || kind === "mineAscend" || kind === "mineDescend") {
    const mined = driveMineStep(rt, cfg, feet, nextCell);
    if (mined === null) return advance(rt, cfg, feet, nextCell, pos, target);
    return step("mine", feet, nextCell, mined);
  }

  // A bridgePlace crosses a floor gap by laying filler under the next cell. A floor already present is an
  // ADVANCE (walk it) — the explicit within-tick completion.
  if (kind === "bridgePlace") {
    const bridged = driveBridgeStep(rt, cfg, feet, nextCell, opts.log);
    if (bridged === null) return advance(rt, cfg, feet, nextCell, pos, target);
    return step("bridge", feet, nextCell, bridged);
  }
  endBridgeIfActive(rt); // a non-bridge policy — restore the held tool if a bridge run just finished

  // A parkour hands to the run-up sub-machine (retreat → charge → launch); it OWNS the tick until it
  // lands. A refused take-off (dist-4 with no full run-up) latches parkourGaveUp and returns PLAN_STALE:
  // the recovery is a typed replan (parkour off → bridge), NOT an inline geometry swap / self-re-entry.
  if (kind === "parkour") {
    if (initParkourRun(rt, cfg, feet, nextCell))
      return step("parkour", feet, nextCell, parkourStep(rt, cfg));
    return PLAN_STALE;
  }

  // traverse / stepUp / dropDownSafe / diagonal(Ascend|Descend) / waterDrop / ladderEnter → the plain
  // walk/step driver (its live step-hazard veto runs inside).
  return step("walk", feet, nextCell, driveWalkStep(rt, cfg, feet, nextCell, pos, target));
}

/** A mine/bridge policy whose obstruction is ALREADY cleared in the live world (the driver reported
 *  "satisfied") — an EXPLICIT within-tick completion, not an implicit fall-through cascade.
 *  Restore the held tool if a bridge just finished, then drive the underlying walk/step: a straight-down
 *  mineDown degenerates to gravity (driveWalkStep holds forward with no horizontal motion), a cleared
 *  mine/bridge cell is walked into. Mirrors the old null-fall-through tail exactly (endBridge → walk). */
function advance(
  rt: Runtime,
  cfg: Config,
  feet: Vec3,
  nextCell: Vec3,
  pos: Vec3,
  target: Vec3,
): GreedyStep {
  endBridgeIfActive(rt);
  return step("walk", feet, nextCell, driveWalkStep(rt, cfg, feet, nextCell, pos, target));
}

/** The sticky ascending-stair sprint state machine (cfg.nav.sprintStairs) — see the `stairSprint`
 *  latch. Returns whether to HOLD sprint THIS tick. On the ground it (re)arms the latch only while the
 *  staircase keeps rising (`stepUp` + the next two stair stands clear) and we're clear of the target,
 *  so the final step (runway no longer clear) and the flat landing (`!stepUp`) both fall back to a
 *  walk — no sprint-jump overshoot off the top. Airborne, it holds the latched sprint through the arc
 *  as long as the heading still matches (a mid-jump re-aim that flips direction drops it, so we never
 *  carry sprint sideways off the narrow flight). This LATCH is the fix the stateless rule couldn't be:
 *  the per-tick geometry flickers mid-arc as `feet.y` crosses block levels and dropped sprint every
 *  step (62→62 in-game); holding across the airborne phase is what sustains the climb. */
function stickyStairSprint(
  rt: Runtime,
  cfg: Config,
  next: Vec3,
  sx: number,
  sz: number,
  stepUp: boolean,
  horizDist: number,
  clearAt: (c: Vec3) => boolean,
): boolean {
  if (!cfg.nav.sprintStairs) {
    stairSprint.active = false;
    return false;
  }
  if (mustOnGround(rt)) {
    const ascendingRunway =
      (sx !== 0 || sz !== 0) &&
      clearAt({ x: next.x + sx, y: next.y + 1, z: next.z + sz }) &&
      clearAt({ x: next.x + sx * 2, y: next.y + 2, z: next.z + sz * 2 });
    stairSprint = {
      active: stepUp && ascendingRunway && horizDist > cfg.nav.sprintMinDist,
      sx,
      sz,
    };
    return stairSprint.active;
  }
  return (
    stairSprint.active && (sx === 0 || sx === stairSprint.sx) && (sz === 0 || sz === stairSprint.sz)
  );
}

/** The plain walk/step driver: face `next`, hold forward, jump for a +1 step, and SPRINT on a clear
 *  same-level runway (≥2 cells) OR, sticky through a climb, up a consistent ascending staircase
 *  (`stickyStairSprint`). Reached once the pillar/mine/bridge/parkour sub-machines have all declined
 *  the tick — so `next` is at most one cell away (a traverse / diagonal / step / drop). A live
 *  step-hazard veto runs first (act-on-truth) → "blocked_hazard". */
function driveWalkStep(
  rt: Runtime,
  cfg: Config,
  feet: Vec3,
  next: Vec3,
  pos: Vec3,
  target: Vec3,
): GreedyStep {
  if (stepIsHazardous(rt, cfg, next)) {
    greedyRelease(rt);
    return blk("walk.hazard", "blocked_hazard");
  }

  // Face the next cell's centre. MC yaw: 0=+Z(south), 90=-X(west), so yaw = atan2(-dx, dz).
  const dx = next.x + 0.5 - pos.x;
  const dz = next.z + 0.5 - pos.z;
  const yaw = Math.atan2(-dx, dz) * (180 / Math.PI);

  const stepUp = next.y > feet.y;
  // Guarded sprint: sprint adds ~½–1 block of momentum-slide past a key-release. We
  // extrapolate the step direction GEOMETRICALLY (not plan.path[2]): the planned route may TURN away
  // from a drop that momentum would carry us straight into (the dead-end-at-a-cliff slide-off). On the
  // FLAT we never sprint into a step-up or the final approach; sprint momentum slides ~1–1.5 blocks, so
  // a sprint stop needs TWO cells of clear same-level runway ahead, not one — the one-cell check let
  // the bot sprint onto a freshly laid but still SHORT bridge (x=1,x=2 placed, x=3 a void) and slide
  // off the tip before the next floor cell could be placed (the bridge fall-in). The ONE place we DO
  // sprint a step-up is a confirmed ascending staircase, held sticky across the airborne arc
  // (stickyStairSprint) — going up there's no front edge to slide off, and it releases on the last
  // step. jsMacros' sneak keybind does NOT engage vanilla edge-clamp (verified isSneaking stays
  // false), so speed control prevents it.
  const horizDist = Math.hypot(target.x - pos.x, target.z - pos.z);
  const sx = Math.sign(next.x - feet.x);
  const sz = Math.sign(next.z - feet.z);
  const runwayCell = (n: number): Vec3 => ({ x: next.x + sx * n, y: next.y, z: next.z + sz * n });
  const live = liveReader(rt);
  const clearAt = (c: Vec3): boolean => walkableAt(live, c) && !stepIsHazardous(rt, cfg, c);
  // The 2-cell runway must be flat-walkable to sprint. NOTE: tried relaxing this to keep
  // sprint when the runway is a solid WALL (you stop against it, no slide-off) vs only a VOID — to
  // close the navbench detour −13 %. It DID shave ~4 % (115→108 t) but DETERMINISTICALLY broke the
  // detour's arrival: keeping sprint through the diagonal corner-REJOIN carries the box wide, the
  // committed `next` degenerates to the current cell, and the leg ends ~2.8 from goal →
  // blocked_no_path (4/5 reps, was 3/3 arrived). Reliability > 4 % speed → reverted. The
  // runway gate is precision-load-bearing on turns, not just the bridge-fall-in case. Left as-is.
  const runwayClear = clearAt(runwayCell(1)) && clearAt(runwayCell(2));
  const sprintFlat = !stepUp && runwayClear;
  const sprintStair = stickyStairSprint(rt, cfg, next, sx, sz, stepUp, horizDist, clearAt);
  const sprint = cfg.nav.sprint && horizDist > cfg.nav.sprintMinDist && (sprintFlat || sprintStair);

  // setYaw leaves pitch as-is → no camera snap-to-level while walking (the DESCEND jerk fix).
  // Turn FIRST, and only then press forward: a failed turn ends the drive with every key released
  // (mustSetYaw) — on Fabric the old best-effort `void setYaw` walked straight along yaw 0 into a drop.
  mustSetYaw(rt, yaw);
  rt.keys.set("key.forward", true);
  rt.keys.set("key.jump", stepUp); // jump to step up onto a +1 cell (parkour is the run-up machine)
  applySprint(rt, cfg, sprint); // edge-triggered + gated on cfg.nav.sprint — never the per-tick attribute churn
  return "moving";
}
