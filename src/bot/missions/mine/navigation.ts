import type { MiningMem } from "@/bot/missions/mine/mining-mem";
import { MINING_SLICE, clearNavOverride } from "@/bot/missions/mine/mining-mem";
import { STATE } from "@/bot/profile/states";
// navigation — GOTO phase driven entirely by the bot's own greedy executor (own navigator;
// Baritone removed). greedyStep walks/climbs/bridges toward the stand pos via held keys
// and owns arrival; a block resolves per the mission's onBlocked policy (dig / skip / error).
import { encodePos } from "@/core/prim/pos";
import type { Vec3 } from "@/core/runtime/types";
import { writeHazardMarker } from "@/shared/domain/world-model";
import type { Capability, Ctx } from "@/shared/kernel/capability";
import {
  DEFAULT_STALL_POLICY,
  PROGRESS_PAUSE,
  type ProgressPolicy,
} from "@/shared/kernel/progress";
import {
  fillerStatus,
  greedyRelease,
  greedyStep,
  isBlocked,
  navGreedyCalledOn,
  navRouteProgress,
  navRouteSnapshot,
  navStepIsStationaryWork,
} from "@/shared/nav";
import { navEngineCfg } from "@/shared/nav/engine";

/** The descent-recoverability veto (`descent.unrecoverable`) fired this tick? Read the greedy
 *  executor's last-block diagnostic — the reason isn't carried in the coarse GreedyStep. */
function descentVetoFired(): boolean {
  return navRouteSnapshot().lastBlock.startsWith("descent.unrecoverable");
}

/** Record the blocked target's column as a persistent `ravine` hazard in mc_world.json (read-modify-
 *  write on the worker thread, mirroring drill's `recordDrowned`) so a later run's SCAN/selectDrillVein
 *  skips the same unclimbable pit instead of re-approaching it. Keyed to the target's X/Z. Best-effort:
 *  a write failure is logged, never fatal (the leg is aborting regardless). */
function recordRavine(ctx: Ctx, target: Vec3): void {
  const x = Math.floor(target.x);
  const z = Math.floor(target.z);
  const res = writeHazardMarker(ctx, "ravine", x, z, ctx.st.tickCount);
  if (res.status === "written") ctx.log.info(ctx.st.tickCount, "NAV_RAVINE_MARKED", { x, z });
  else if (res.status === "write-failed")
    ctx.log.warn(ctx.st.tickCount, "NAV_RAVINE_MARK_FAIL", { err: res.error });
}

/** The mission declared an unreachable target non-fatal (onBlocked "skip"): cache it so SCAN won't
 *  re-pick it, then re-SCAN for other reachable ore. When none remain, SCAN exhausts — an unlimited
 *  run parks at PAUSED, a batch run (goalCount>0) completes via isDone. */
function skipTarget(ctx: Ctx, mem: MiningMem, why: string): void {
  const t = mem.target;
  if (t) {
    const key = encodePos(t.x, t.y, t.z);
    mem.cache.add(key);
    mem.veinMined.add(key);
  }
  clearNavOverride(mem);
  ctx.transition(STATE.SCAN, why);
}

/** A column approach (walk-to-vein / waypoint resume): navMode "xz" AND no exact ore target yet.
 *  An exact-ore vein-chase (mem.target set) is NOT a column approach even if navMode is still
 *  "xz" — it needs strict 3D arrival + bestEffort off so an unreachable ore blocks→DIG_TO. */
function isColumnLeg(mem: MiningMem): boolean {
  return mem.navMode === "xz" && mem.target === null;
}

/** GOTO progress-watchdog for the "skip" missions (mine, chop): greedy can answer "moving"
 *  forever while the bot never gets closer (live: lap 1 sat 11.7 s in GOTO toward an ore
 *  with neither arrival nor a block verdict). MONOTONIC route progress (navRouteProgress: cells
 *  advanced along the route greedy follows) — NOT distance to the stand pos, which a legal route
 *  round a ravine or lake must first increase. No gain for nav.gotoStallTicks → skip the target and
 *  re-SCAN, never ERROR. Exempt (null, which resets the clock): other onBlocked policies (drill
 *  owns its approach in DESCEND), a blind position read (greedy cannot step either), and a tick
 *  whose OWN greedy call did in-place work (mine/mineDown/pillar/ladder/bridge — one mine step can
 *  take several aim+break budgets with zero gain; cfg.nav.gotoTimeoutTicks still caps the leg). Paused
 *  (PROGRESS_PAUSE: not counted, NOT reset): a tick on which greedy did NOT run (a guard or reflex
 *  short-circuited the handler, e.g. swim-out holding jump) — route progress cannot move, so the
 *  tick must not count, but a reset would let a guard firing every few ticks re-arm the clock
 *  between frozen greedy ticks forever; the guard's own budgets (cfg.safety.swimOutMaxTicks, the air reflex,
 *  the feet backstop, cfg.nav.gotoTimeoutTicks) time the held stretch. No airborne exemption: a
 *  hop-in-place loop must not re-arm the clock each hop. */
const gotoApproach: ProgressPolicy = {
  name: "goto-approach",
  monotonic: true,
  signature: (ctx: Ctx) => {
    const mem = ctx.slice(MINING_SLICE);
    const posR = ctx.rt.player.pos();
    if (mem.onBlocked !== "skip" || !mem.standPos || !posR.ok) return null;
    const tick = ctx.rt.tick();
    if (!navGreedyCalledOn(tick)) return PROGRESS_PAUSE;
    if (navStepIsStationaryWork(tick)) return null;
    return navRouteProgress();
  },
  budgetTicks: (cfg) => cfg.nav.gotoStallTicks,
  onStall: {
    handle: (ctx: Ctx) => {
      const mem = ctx.slice(MINING_SLICE);
      const posR = ctx.rt.player.pos();
      ctx.log.warn(ctx.st.tickCount, "NAV_GOTO_STALL", {
        target: mem.target,
        stand: mem.standPos,
        pos: posR.ok ? posR.value : null,
      });
      greedyRelease(ctx.rt);
      skipTarget(ctx, mem, "goto stalled (no approach progress) → skip target");
    },
  },
};

/** Greedy could not advance toward `target`. Log it loudly, then resolve per the mission's
 *  onBlocked policy: "dig" (drill) tunnels via DIG_TO (or hands a column approach to its arrival
 *  phase); "skip" (mine, chop) caches the unreachable ore + re-SCANs; otherwise fail-loud
 *  ERROR (or a RECOVER teleport-out when cfg.nav.blockedFailFast is off). */
function greedyBlocked(ctx: Ctx, mem: MiningMem, target: Vec3, step: string): void {
  const { rt, cfg, st } = ctx;
  const posR = rt.player.pos();
  ctx.log.warn(st.tickCount, "NAV_BLOCKED", {
    reason: step,
    target,
    pos: posR.ok ? posR.value : null,
    failFast: cfg.nav.blockedFailFast,
  });
  // Low-filler guard surfacing: pillar/bridge climb-out moves are gated on ≥cfg.nav.fillerMin filler
  // (the downhill "trap" is a no-filler problem, not a height one), so a
  // leg that blocks with the bag near-empty is likely FUEL-STARVED, not impassable. Log it distinctly so
  // the escalation reason (refill/restock) is visible rather than reading as a hard terrain block.
  const filler = fillerStatus(rt, cfg);
  if (!filler.enough) {
    ctx.log.warn(st.tickCount, "FILLER_LOW", {
      count: filler.count,
      min: cfg.nav.fillerMin,
      target,
    });
  }
  // Persist the descent-recoverability veto as a world-bound `ravine` hazard so a LATER run doesn't
  // re-approach the same unclimbable pit (in-run `mem.cache` below only guards the current run). Only
  // for the guard's own veto — a generic no-path / fuel-starve block is not a terrain trap to remember.
  if (cfg.nav.descentGuard && descentVetoFired()) recordRavine(ctx, target);
  if (mem.onBlocked === "dig" && mem.target && mem.standPos) {
    // 3D vein-chase: greedy can't WALK there, so mine a staircase/tunnel to it (DIG_TO). Keep the
    // nav override — DIG_TO needs standPos/target/face. (DIG_TO itself caches + SCANs if even
    // digging can't reach it, so this never loops.)
    ctx.transition(STATE.DIG_TO, `${step} → dig to target`);
    return;
  }
  if (mem.onBlocked === "dig" && mem.target === null && mem.arrivalPhase) {
    // Drill column-approach (walk-to-vein X/Z, no exact ore target yet): a best-effort approach that
    // still blocked has parked as close to the vein's marker column as it can reach. There's nothing to
    // DIG_TO (target null), so DON'T fail loud — hand to the arrival phase (DESCEND), which finishes the
    // last blocks onto the column or, when the column is unreachable across a gap, skips this vein for the
    // next one (its GOTO-stall guard). Turns a scattered, hard-to-reach vein into a skip, not an ERROR.
    const next = mem.arrivalPhase;
    clearNavOverride(mem);
    ctx.transition(next, `${step} → park at vein column (drill finishes or skips it)`);
    return;
  }
  if (mem.onBlocked === "skip") {
    skipTarget(ctx, mem, `${step} → skip unreachable target`);
    return;
  }
  clearNavOverride(mem);
  if (cfg.nav.blockedFailFast) {
    // Fail-fast: surface the failure as ERROR (no silent self-heal). Re-enable RECOVER by
    // setting cfg.nav.blockedFailFast=false once greedy is trusted to escalate cleanly.
    ctx.transition(STATE.ERROR, `greedy ${step}`);
  } else {
    ctx.divert(STATE.RECOVER, `greedy ${step}`);
  }
}

/** Greedy executor step toward the stand pos; arrival → the arrival phase, a block →
 *  greedyBlocked(). Returns void; the caller returns immediately after. */
function greedyGoto(ctx: Ctx, mem: MiningMem, target: Vec3): void {
  // An "xz" leg is a column-approach (walk-to-vein / waypoint resume): the goal Y floats (set to
  // the bot's current Y, not the column surface), so arrive on horizontal distance and plan at the
  // current level — and run best-effort so an unreachable exact cell becomes "approach as close as
  // possible" rather than bailing to Baritone. A "block" leg (exact ore stand pos) stays strict 3D
  // + bestEffort=false, so an unreachable block returns blocked→DIG_TO/BRIDGE.
  const column = isColumnLeg(mem);
  // Apply the operator's runtime engine override (nav_engine: default/astar/dstar/auto) — default is
  // the baked cfg (zero behaviour change); dstar/auto opt into D* Lite where engageable.
  const driveCfg = navEngineCfg(ctx, target);
  const step = greedyStep(ctx.rt, driveCfg, target, { column, bestEffort: column, log: ctx.log });
  if (step === "arrived") {
    const next = mem.arrivalPhase ?? STATE.MINE;
    clearNavOverride(mem);
    ctx.transition(next, "arrived at stand pos (greedy)");
  } else if (isBlocked(step)) {
    greedyBlocked(ctx, mem, target, step);
  }
}

export const navigation: Capability = {
  name: "navigation",

  // Declaring a policy replaces the feet DEFAULT backstop, so it stays listed for the non-skip
  // missions (drill) whose GOTO the approach policy exempts.
  progress: { GOTO: [gotoApproach, DEFAULT_STALL_POLICY] },

  handlers: {
    GOTO(ctx: Ctx): void {
      const { rt, cfg, st } = ctx;
      const mem = ctx.slice(MINING_SLICE);
      if (!mem.standPos) {
        greedyRelease(rt);
        clearNavOverride(mem);
        ctx.transition(STATE.SCAN, "goto without standPos");
        return;
      }
      if (st.phaseTicks > cfg.nav.gotoTimeoutTicks) {
        greedyRelease(rt);
        const next = mem.arrivalPhase ?? STATE.SCAN;
        clearNavOverride(mem);
        ctx.transition(next, "goto timeout");
        return;
      }

      // Greedy is the ONE driver (own navigator; Baritone removed). It owns arrival + the per-tick
      // step-hazard veto; a block routes through greedyBlocked → dig / skip / error / RECOVER.
      greedyGoto(ctx, mem, mem.standPos);
    },
  },
};
