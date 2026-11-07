import { startExcavation } from "@/bot/missions/drill/excavate";
import { AIR, floorUnsafe, footprintAt, recordDrowned } from "@/bot/missions/drill/floor-safety";
import { selectDrillVein, skipUnreachableVein } from "@/bot/missions/drill/select-vein";
import { DRILL_RUN, DRILL_SLICE } from "@/bot/missions/drill/state";
import type { HarvestProfile } from "@/bot/missions/harvest/profile";
import { MINING_SLICE, setMiningTarget } from "@/bot/missions/mine/mining-mem";
import { STATE } from "@/bot/profile/states";
import { must } from "@/core/prim/invariant";
import { floorVec } from "@/core/prim/pos";
import type { Runtime } from "@/core/runtime/Runtime";
import type { Vec3 } from "@/core/runtime/types";
// descend — the drill mission's downward shaft digger. The prospector gives a
// vein's X/Z but NOT its Y, so after walking to that X/Z we dig a 1-wide column straight down with
// the real hammer (no teleport) until the shaft exposes the prospected ore, then hand off to the
// existing MINE vein-follow. Fail-LOUD: a hazard below, a deep fall (cave/void), or hitting the
// depth floor with no vein → ERROR (visible), never a blind plunge.
//
// Depends on the shared MINING_SLICE/profile (same blackboard as scan/mine) + the mine break
// primitive (rt.mine.setTarget/breakAsync). The hard parts (exposure test, fall safety) are pure
// domain (scan/senses/movement-physics), so this stays thin and the logic is unit-tested.
import { isWater } from "@/shared/domain/block-traits";
import { exposedTargetNear } from "@/shared/domain/scan";
import type { BlockReader } from "@/shared/domain/senses";
import { strategyForTool } from "@/shared/domain/tooling";
import { heldStack } from "@/shared/held";
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { PROGRESS_PAUSE, approachSig } from "@/shared/kernel/progress";
import { greedyRelease, greedyStep, navSearchResumed } from "@/shared/nav";
import { stepBreak } from "@/shared/nav/break-cell";

/** MINE→GOTO vein-follow toward an ore ≥2 away in Y that greedy can't step to in a 1-wide shaft.
 *  Redirect to a dig leg (mirrors the DIG_TO/DESCEND fan-out) — returns true if it transitioned:
 *   • below, laterally OFFSET → DIG_TO: staircase DOWN toward it (planDigStep descends, vy<0) — a
 *     straight-down shaft could never reach it (the excavate-stall, live-caught on a tin vein).
 *   • below, SAME column      → DESCEND: dig straight down (radius scan re-detects + hands to MINE).
 *   • above                   → DIG_TO: staircase UP (3D vein-chase; caches + SCANs if undiggable).
 *  Horizon-first: before descending for a below ore, mine any exposed at-or-
 *  above target ore near here first — the below ore stays in the world, re-found once the horizon dries. */
function redirectSubfloorVeinFollow(ctx: Ctx): boolean {
  const mem = ctx.slice(MINING_SLICE);
  const posR = ctx.rt.player.pos();
  if (!(posR.ok && mem.standPos)) return false;
  const feet = floorVec(posR.value);
  const feetY = feet.y;
  if (mem.standPos.y <= feetY - 2) {
    const profile = mem.profile;
    const horizonOre = profile
      ? exposedTargetNear(
          reader(ctx.rt),
          (id) => profile.isTarget(id),
          feet,
          ctx.cfg.drill.horizonRadius,
          feetY,
        )
      : null;
    if (horizonOre) {
      const deferredBelow = mem.standPos;
      const strategy = strategyForTool(heldStack(ctx.rt)?.id ?? null);
      const sol = setMiningTarget(mem, horizonOre, strategy, posR.value);
      greedyRelease(ctx.rt);
      ctx.log.info(ctx.st.tickCount, "DRILL_HORIZON_FIRST", { ore: horizonOre, deferredBelow });
      ctx.transition(sol.sameStandPos ? STATE.MINE : STATE.GOTO, "horizon ore before descend");
      return true;
    }
    if ((mem.standPos.x !== feet.x || mem.standPos.z !== feet.z) && mem.target) {
      greedyRelease(ctx.rt);
      ctx.log.info(ctx.st.tickCount, "DRILL_DIG_DOWN", { target: mem.target, stand: mem.standPos });
      ctx.transition(STATE.DIG_TO, "drill: offset ore below → dig a staircase down to it");
      return true;
    }
    greedyRelease(ctx.rt);
    ctx.log.info(ctx.st.tickCount, "DRILL_SUBFLOOR", { target: mem.standPos });
    ctx.transition(STATE.DESCEND, "drill: ore below → dig down to it");
    return true;
  }
  if (mem.standPos.y >= feetY + 2 && mem.target) {
    greedyRelease(ctx.rt);
    ctx.log.info(ctx.st.tickCount, "DRILL_DIG_UP", { target: mem.target, stand: mem.standPos });
    ctx.transition(STATE.DIG_TO, "drill: ore above shaft → dig up to it");
    return true;
  }
  return false;
}

/** Block reader treating an unreadable cell as solid stone — conservative for TARGETING: never a
 *  false ore target, never a false air-exposure. Do NOT use this for the dig-safety check: masking
 *  unknown as stone would let the shaft break blind into an unverified cell (see {@link knownReader}). */
function reader(rt: Runtime): (x: number, y: number, z: number) => string {
  return (x, y, z) => {
    const r = rt.world.blockId({ x, y, z });
    return r.ok ? r.value : "minecraft:stone";
  };
}

/** Honest reader for the dig-SAFETY check: an unreadable/unloaded cell reads as `null` (UNKNOWN),
 *  NOT masked as stone. The safety rule is "never dig under yourself unless you know what is below"
 *  — the floor we break and the column we'd fall into must be KNOWN; an unknown cell is refused,
 *  never assumed solid ground. (The senses `BlockReader` convention: null is the conservative
 *  unknown.) */
function knownReader(rt: Runtime): BlockReader {
  return (x, y, z) => {
    const r = rt.world.blockId({ x, y, z });
    return r.ok ? r.value : null;
  };
}

type Read = (x: number, y: number, z: number) => string;

/** Vein exposed by the shaft → set up the MINE handoff; or the depth floor reached → fail loud.
 *  Returns true if it handled this tick (caller returns). An ore detected BELOW us (not minable
 *  from here and not reachable by walking up/level) is recorded but NOT handed off — we keep
 *  digging down toward it (returning false), else DESCEND↔GOTO would ping-pong forever. */
function reachVeinOrFloor(
  ctx: Ctx,
  read: Read,
  profile: HarvestProfile,
  pos: Vec3,
  feet: Vec3,
): boolean {
  const { rt, cfg, st } = ctx;
  const mem = ctx.slice(MINING_SLICE);
  // Surface-scatter skip: the prospector gives the vein's X/Z but not its Y, so on
  // eroded/ore-rich terrain the vein material is exposed at the surface too. Engaging that first
  // surface clump would abort the descent one block down and never reach the BURIED band the drill was
  // sent for. So ignore exposed ore until the shaft is cfg.drill.surfaceSkip blocks below where it started;
  // deeper than that, the exposed target IS the vein band. surfaceY NaN (not yet recorded) → don't
  // engage yet either (the handler records it before this call, so NaN only at the very first tick).
  const surfaceY = ctx.slice(DRILL_RUN).surfaceY;
  const belowSurface = !Number.isNaN(surfaceY) && feet.y <= surfaceY - cfg.drill.surfaceSkip;
  const hit = belowSurface
    ? exposedTargetNear(read, (id) => profile.isTarget(id), feet, cfg.drill.scanRadius)
    : null;
  if (hit) {
    const strategy = strategyForTool(heldStack(rt)?.id ?? null);
    const sol = setMiningTarget(mem, { x: hit.x, y: hit.y, z: hit.z, id: hit.id }, strategy, pos);
    if (profile.emitOreFound) ctx.bus.emit("oreFound", hit);
    if (sol.sameStandPos || sol.standPos.y >= feet.y) {
      // The shaft reached the vein's ore band → strip-mine the whole VOLUME, not just this grazed
      // clump. Anchor the corridor plane at the ORE'S depth (hit.y), NOT the bot's transient
      // reach-feet Y: the exposed ore can sit a block BELOW the feet that first saw it (cfg.drill.scanRadius
      // reaches down), and anchoring at feet.y then put the top corridor one ABOVE the band — so the
      // first level dug air, and the instant MINE landed the bot at the true ore level it was stranded
      // ONE BELOW the plane, turning every remaining corridor cell into an up-step over the gap the
      // level-only bridge driver can't cross (live: drill-gap-vein PLACE_CELL never fired,
      // whole band skipped). Clamp to feet.y so a rare ore ABOVE feet doesn't put the plane overhead
      // (corridors only descend; overhead ore is caught by the top corridor's vein-follow reach).
      const anchorY = Math.min(hit.y, feet.y);
      ctx.log.info(st.tickCount, "DRILL_VEIN_REACHED", { ...hit, depthY: feet.y, anchorY });
      const drill = ctx.slice(DRILL_SLICE);
      const center = drill.vein
        ? { x: drill.vein.x, y: anchorY, z: drill.vein.z }
        : { x: hit.x, y: anchorY, z: hit.z };
      startExcavation(ctx, center, drill.bbox);
      ctx.transition(STATE.EXCAVATE, `drill reached ${hit.id} → excavate volume`);
      return true;
    }
    // Ore is below us — keep digging down toward it (mem.target stays set for the later handoff).
  }
  if (feet.y <= cfg.drill.minY) {
    // Hit the depth floor. If the multi-band descent has already stripped ≥1 band, this is a
    // successful exhaustion ("dig every vein on the way down" ran out of veins) → graceful PAUSED,
    // not a fault. Only a shaft that reached bedrock having mined NOTHING is the loud no-vein ERROR
    // (the prospector marker was wrong / the vein isn't under this column).
    if (ctx.slice(DRILL_SLICE).bandsMined > 0) {
      ctx.log.info(st.tickCount, "DRILL_DEPTH_DONE", {
        reachedY: feet.y,
        bands: ctx.slice(DRILL_SLICE).bandsMined,
      });
      ctx.transition(STATE.PAUSED, "drill: depth floor reached — all bands mined");
      return true;
    }
    // Dug to bedrock and found NOTHING → the prospector marker was wrong (no vein under this column).
    // Skip it for the next cached vein rather than fail loud (PAUSE when none remain) — same graceful
    // "skip them without falling into ERROR" as an unreachable/void column.
    ctx.log.warn(st.tickCount, "DRILL_NO_VEIN", { reachedY: feet.y, minY: cfg.drill.minY });
    skipUnreachableVein(ctx);
    return true;
  }
  return false;
}

/** Break ONE support block via the shared AIM→BREAK routine (looks down at the cell, then breaks).
 *  Cleared → tally it; timeout → fail loud (ERROR), since a stuck shaft dig is unrecoverable. */
function breakSupport(ctx: Ctx, target: Vec3): void {
  const run = ctx.slice(DRILL_RUN);
  const outcome = stepBreak(ctx.rt, ctx.cfg, ctx.st.tickCount, run, target, "TOP");
  if (outcome === "cleared") {
    ctx.slice(MINING_SLICE).brokenCount++;
  } else if (outcome === "timeout") {
    ctx.log.warn(ctx.st.tickCount, "DRILL_BREAK_TIMEOUT", { at: target });
    ctx.transition(STATE.ERROR, "drill break timeout");
  }
}

/** Phases the no-target re-target/park guard must never fire in: PAUSED (it IS the park — no
 *  spam), RECOVER/EAT (a reflex or interrupt owns the FSM; the handler must run), ERROR
 *  (terminal). Everything productive (IDLE/GOTO/DESCEND/SCAN/…) may re-target. */
const GUARD_SKIP_PHASES: ReadonlySet<string> = new Set([
  STATE.PAUSED,
  STATE.RECOVER,
  STATE.EAT,
  STATE.ERROR,
]);

export const descend: Capability = {
  name: "descend",

  // Universal progress contract: DESCEND's three silent-wedge watchdogs, folded onto the
  // kernel's one detector. Each is a ProgressPolicy whose signature returns null (exempt) outside its
  // sub-mode, so at most one is live per tick — a clean partition of airborne / off-column-approach /
  // on-column-dig. The kernel does the "signature frozen past budget" detection; each onStall is the
  // old detector's recovery ACTION verbatim.
  progress: {
    DESCEND: [
      {
        // Airborne-hang (the /rtp vine-column wedge): a bot that never lands. Grounded ticks are
        // exempt (the other two own them); a sustained airborne run shows a constant signature and
        // trips at stallTicks → skip the vein. A real fall re-grounds in a few ticks (clock resets).
        name: "descend-airborne",
        signature: (ctx: Ctx) => {
          const g = ctx.rt.player.onGround();
          return g.ok && !g.value ? "airborne" : null;
        },
        budgetTicks: (cfg) => cfg.drill.stallTicks,
        onStall: {
          handle: (ctx: Ctx) => {
            ctx.log.warn(ctx.st.tickCount, "DRILL_AIRBORNE_STALL", {});
            skipUnreachableVein(ctx);
          },
        },
      },
      {
        // Shaft-depth freeze ("breaks keep succeeding but feet.y never drops"). Live only when
        // grounded + ON the marker column (digging); feet.y is the shaft depth — it must keep
        // dropping. Frozen past stallTicks → DIG_TO if the ore is laterally OFFSET (a vertical shaft
        // can never reach it), else the fail-LOUD ERROR.
        name: "descend-shaft-depth",
        signature: (ctx: Ctx) => {
          const posR = ctx.rt.player.pos();
          if (!posR.ok) return null;
          const g = ctx.rt.player.onGround();
          if (g.ok && !g.value) return null; // airborne → the airborne policy owns it
          const feet = floorVec(posR.value);
          const run = ctx.slice(DRILL_RUN);
          const drill = ctx.slice(DRILL_SLICE);
          const anchor = !run.shaftStarted && drill.vein ? drill.vein : feet;
          if (feet.x !== anchor.x || feet.z !== anchor.z) return null; // off-column → approach owns it
          return feet.y;
        },
        budgetTicks: (cfg) => cfg.drill.stallTicks,
        onStall: {
          handle: (ctx: Ctx) => {
            const { rt, st } = ctx;
            const posR = rt.player.pos();
            const feet = posR.ok ? floorVec(posR.value) : null;
            const mem = ctx.slice(MINING_SLICE);
            // Dig-out recovery (tunnel a passage to it): an OFFSET target a vertical shaft can't
            // reach → staircase to it via DIG_TO (fail-graceful; caches + SCANs if even digging
            // can't reach).
            if (
              feet &&
              mem.target &&
              mem.standPos &&
              (mem.standPos.x !== feet.x || mem.standPos.z !== feet.z)
            ) {
              ctx.log.info(st.tickCount, "DRILL_STALL_DIGOUT", {
                target: mem.target,
                stand: mem.standPos,
              });
              greedyRelease(rt);
              ctx.transition(
                STATE.DIG_TO,
                "drill: shaft stalled with an offset target → dig out to it",
              );
              return;
            }
            ctx.log.warn(st.tickCount, "DRILL_STALL", { feetY: feet?.y ?? null });
            ctx.transition(STATE.ERROR, "drill descend stalled (no downward progress)");
          },
        },
      },
      {
        // Approach GOTO-stall: the marker-column walk that returns "moving" while the bot never gets
        // closer (parked across a gap). Live only off-column + grounded; a MONOTONIC signature of the
        // negated, eps-quantized horizontal distance — no STRICT gain (closer by ≥approachProgressEps)
        // for approachBlockedTicks → skip the vein for the next-nearest. A tick that only resumed the
        // walk's route search is paused (not counted): the body holds still by design until the
        // search has its answer. The handler calls greedyStep on every off-column grounded tick, so
        // navSearchResumed reads this tick's call.
        name: "descend-approach",
        monotonic: true,
        signature: (ctx: Ctx) => {
          const posR = ctx.rt.player.pos();
          if (!posR.ok) return null;
          const g = ctx.rt.player.onGround();
          if (g.ok && !g.value) return null; // airborne → the airborne policy owns it
          const feet = floorVec(posR.value);
          const run = ctx.slice(DRILL_RUN);
          const drill = ctx.slice(DRILL_SLICE);
          const anchor = !run.shaftStarted && drill.vein ? drill.vein : feet;
          if (feet.x === anchor.x && feet.z === anchor.z) return null; // on-column → depth owns it
          if (navSearchResumed()) return PROGRESS_PAUSE;
          return approachSig(posR.value, anchor, ctx.cfg.drill.approachProgressEps, true);
        },
        budgetTicks: (cfg) => cfg.drill.approachBlockedTicks,
        onStall: { handle: (ctx: Ctx) => skipUnreachableVein(ctx) },
      },
    ],
  },

  guard(ctx: Ctx): boolean {
    const drill = ctx.slice(DRILL_SLICE);
    // No cached vein → don't dig blindly. Re-attempt from (possibly refreshed) markers; if the host
    // ran `prospect` since, this re-targets and continues. Still empty → graceful PAUSE + alert (NOT
    // a hard ERROR): the prospector is dead/uncharged, so wait for a human to recharge it (a Turbo
    // Charger, EU) + refresh veins, then `resume` re-targets. Skipped while already PAUSED (no spam)
    // AND while an emergency/maintenance landing owns the FSM: PAUSING over RECOVER/EAT preempts the
    // handler a reflex diverted to — the swim-out/respawn never ran and a bot drowned in the
    // RECOVER→PAUSED ping-pong (live). ERROR is terminal; never re-target out of it.
    if (drill.noTarget && !GUARD_SKIP_PHASES.has(ctx.st.phase)) {
      if (selectDrillVein(ctx, drill.ore)) {
        ctx.transition(STATE.GOTO, "drill: vein cache refreshed → re-target");
        return true;
      }
      ctx.log.warn(ctx.st.tickCount, "DRILL_NEEDS_PROSPECT", {
        ore: drill.ore ?? "any",
        hint: "recharge the prospector + run `prospect` to refresh veins, then resume",
      });
      ctx.transition(STATE.PAUSED, "drill: no cached vein — prospector empty/uncharged");
      return true;
    }
    // Vein-follow in a 1-wide shaft (dig the rest): greedy can only step ±1 in Y, so a MINE→GOTO
    // toward an ore far above/below our shaft would just blocked_no_path. Redirect those to a dig leg.
    if (ctx.st.phase === STATE.GOTO && redirectSubfloorVeinFollow(ctx)) return true;
    return false;
  },

  handlers: {
    DESCEND(ctx: Ctx): void {
      const { rt, cfg, st } = ctx;
      const profile = must(
        ctx.slice(MINING_SLICE).profile,
        "drill descend without a profile (mission init missed)",
      );

      const posR = rt.player.pos();
      if (!posR.ok) return; // can't sense this tick — hold
      const pos = posR.value;

      // Release any centring movement from last tick (re-asserted below if still centring). Keeps
      // keys clean while sensing/falling and on every transition out of DESCEND.
      greedyRelease(rt);

      const feet = floorVec(pos);
      const read = reader(rt);
      const run = ctx.slice(DRILL_RUN);

      // Flooded-column watchdog (drowning fix — the "not fully submerged, but in a flow" case).
      // Runs BEFORE the grounded gate so it accumulates while the bot bobs/floats in a flooded
      // marker column. The submergesAt veto + swim-out reflex only own FULL submersion (feet + head
      // water): they surface the bot on every dip, so DESCEND keeps retrying and the horizontal
      // approach counter is reset by the bobbing → it never converges. Any SUSTAINED water contact
      // at our column (feet cell or the cell below is water) means the shaft can't be dug — a
      // 1-wide shaft floods and water is unmineable, still OR flowing — so record the column
      // drowned (persistent, don't come back) and skip, exactly like the fully-submerged drown
      // trap. Gated on bandsMined===0: a productive shaft bottoming out into water is the graceful
      // DEPTH_DONE case (floorUnsafe owns it), not a flooded-approach bail. A short waded puddle
      // resets the counter.
      if (ctx.slice(DRILL_SLICE).bandsMined === 0) {
        const inWater =
          isWater(read(feet.x, feet.y, feet.z)) || isWater(read(feet.x, feet.y - 1, feet.z));
        if (inWater) {
          run.waterContactTicks++;
          if (run.waterContactTicks > cfg.drill.waterContactTicks) {
            ctx.log.warn(st.tickCount, "DRILL_FLOODED_COLUMN", {
              at: feet,
              contactTicks: run.waterContactTicks,
            });
            recordDrowned(ctx, feet);
            skipUnreachableVein(ctx);
            return;
          }
        } else {
          run.waterContactTicks = 0;
        }
      }

      // Don't dig mid-fall — wait until grounded so the shaft stays a clean column and the safety
      // checks read a settled position. Never wait FOREVER: a bot that never lands (live:
      // /rtp parked bot_2 hanging in a jungle vine column, onGround false with y frozen — DESCEND
      // silently wedged 30+ min) is caught by the DESCEND "airborne" ProgressPolicy (below), which
      // sees a constant signature while airborne and skips the vein past cfg.drill.stallTicks. A real
      // shaft fall re-grounds within a few ticks (the policy exempts grounded ticks → clock resets).
      const groundedR = rt.player.onGround();
      if (groundedR.ok && !groundedR.value) return;

      // Per-shaft-LAYER reset: a new feet.y refreshes the centring budget (the shaft-depth stall is
      // now the DESCEND "shaft-depth" ProgressPolicy, keyed on feet.y — no bespoke tick counter).
      if (run.lastFeetY !== feet.y) {
        run.lastFeetY = feet.y;
        run.centerTicks = 0;
      }
      // Record the arrival surface once (first grounded descend tick), before any ore-engagement
      // check — reachVeinOrFloor skips exposed ore until cfg.drill.surfaceSkip blocks below this.
      if (Number.isNaN(run.surfaceY)) run.surfaceY = feet.y;

      // Vein reached (→MINE) or dug to the depth floor (→ERROR)?
      if (reachVeinOrFloor(ctx, read, profile, pos, feet)) return;

      // (The "breaks keep succeeding but feet.y never drops" spin — and the DIG_TO-if-offset-else-
      // ERROR recovery — is now the DESCEND "shaft-depth" ProgressPolicy's onStall, below; a single
      // hard block still trips the break timeout → ERROR first.)

      // Centre before digging so the shaft is a clean 1-wide column (a straddling bot would dig its
      // front/behind columns too). The anchor is the prospected MARKER column until the shaft is cut
      // — GOTO's "xz" leg arrives within cfg.nav.gotoArrivalDist (~2.5) of the vein, so digging at the arrival
      // block would cut a clean shaft 1–2 blocks OFF the vein (miss it, or open a void). So the first
      // layer walks ONTO the marker first; once the shaft is started the bot drops straight down it,
      // and deeper layers (+ re-descents after a MINE leg) anchor to the current block.
      const drill = ctx.slice(DRILL_SLICE);
      const anchor = !run.shaftStarted && drill.vein ? drill.vein : feet;
      // Step 1 — get onto the marker COLUMN. When the bot stands in a DIFFERENT block (the off-marker
      // arrival), walk there with a GoalXZ column approach, NOT a tight-radius point goal: no integer
      // cell sits within cfg.drill.centerTol of the column centre, so a radius goal would find no path and
      // wedge (blocked_no_path) — the column goal arrives on cell membership. The stall watchdog
      // (cfg.drill.stallTicks, 6 s) is the hang backstop for this coarse walk.
      if (feet.x !== anchor.x || feet.z !== anchor.z) {
        greedyStep(
          rt,
          cfg,
          { x: anchor.x + 0.5, y: pos.y, z: anchor.z + 0.5 },
          { column: true, bestEffort: true },
        );
        // GOTO-stall skip ("reach scattered veins, or skip them"): a wall-bumping approach
        // returns "moving" while the bot never advances (live-caught: bot frozen, greedy "moving"). The
        // detection is now the DESCEND "approach" ProgressPolicy — a MONOTONIC signature of the closest
        // horizontal approach to the marker column; no strict gain for cfg.drill.approachBlockedTicks →
        // its onStall skips the vein for the next-nearest (never a spin to the loud DRILL_STALL).
        return;
      }
      // Step 2 — on the marker column: fine-nudge onto the block centre so the 1-wide shaft is clean.
      // This stays a tight-radius point goal (sub-block), backstopped by the per-layer centring budget
      // so a wall-pinned bot footprint-digs instead of hanging (greedyStep's inGoalCell micro-walk
      // drives it — the bot already stands IN the target cell, so no cross-cell plan is needed).
      const cx = anchor.x + 0.5;
      const cz = anchor.z + 0.5;
      const offset = Math.hypot(pos.x - cx, pos.z - cz);
      if (offset > cfg.drill.centerTol && run.centerTicks < cfg.drill.centerMaxTicks) {
        run.centerTicks++;
        greedyStep(rt, cfg, { x: cx, y: pos.y, z: cz }, { arrivalRadius: cfg.drill.centerTol });
        return;
      }
      // Centred on the (marker) column and committed to digging → the shaft is started: deeper layers
      // and re-descents now anchor to the current block, not back at the marker.
      run.shaftStarted = true;

      // The columns our AABB rests on, one block down. Break every solid one — clearing only the
      // centre leaves the bot wedged on a leftover support (it straddles up to 4 columns).
      const foot = footprintAt(cfg.drill.footprintHalfWidth, pos, feet.y - 1);
      if (floorUnsafe(ctx, knownReader(rt), foot)) return;
      const solid = foot.filter((b) => !AIR.has(read(b.x, b.y, b.z)));
      // All supports already air (a safe ≤maxFall hole) → let gravity drop us; re-evaluate grounded.
      if (solid.length === 0) return;
      breakSupport(ctx, must(solid[0], "non-empty solid footprint"));
    },
  },
};
