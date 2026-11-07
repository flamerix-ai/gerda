import { DRILL_RUN, DRILL_SLICE } from "@/bot/missions/drill/state";
import { MINING_SLICE, setMiningTarget } from "@/bot/missions/mine/mining-mem";
import { STATE } from "@/bot/profile/states";
import { must } from "@/core/prim/invariant";
import { canSurviveFall } from "@/core/prim/movement-physics";
import { cellCenter, floorVec } from "@/core/prim/pos";
import type { Runtime } from "@/core/runtime/Runtime";
import type { Vec3 } from "@/core/runtime/types";
// excavate — the drill's vein-VOLUME strip-miner (EXCAVATE phase). Once DESCEND reaches
// the vein's ore band, this walks the pure serpentine corridor plan (domain/excavate) with the same
// hands as DIG_TO — plan a single step (planDigStep), break the solid cells, greedyStep into the
// cleared cell — so it digs 1-wide corridors across the vein footprint. Each corridor arrival checks
// for exposed ore in reach and hands to MINE (which vein-follows the whole contiguous clump); MINE's
// "vein exhausted → SCAN" is redirected back here by this capability's guard, so the loop is
// EXCAVATE → MINE → EXCAVATE until the plan is dug. Then (cfg.drill.multiBand, "dig every vein on
// the way down") the shaft resumes DESCENDing to the NEXT band, until the depth floor ends the run
// gracefully (PAUSED). Fail-GRACEFUL: an unreachable/hazardous corridor cell is skipped (never
// ERROR), matching the rest of the drill.
import type { Config } from "@/shared/config/schema";
import { planDigStep } from "@/shared/domain/dig-nav";
import { planExcavation } from "@/shared/domain/excavate";
import type { VeinBBox } from "@/shared/domain/resource-target";
import { exposedTargetNear } from "@/shared/domain/scan";
import { hazardAt, walkableAt } from "@/shared/domain/senses";
import { strategyForTool } from "@/shared/domain/tooling";
import { heldStack } from "@/shared/held";
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { defineSlice } from "@/shared/kernel/slice";
import { fillerStatus, greedyRelease, greedyStep, isBlocked, navRouteSnapshot } from "@/shared/nav";
import { type BreakRun, freshBreakRun, stepBreak } from "@/shared/nav/break-cell";

const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);

/** The active excavation: the ordered corridor cells, the cursor into them, and whether a plan is
 *  live. Set up by `startExcavation` (called from DESCEND on vein-reached); persists across the
 *  EXCAVATE↔MINE loop so mining a clump and returning resumes the same corridor cursor. */
export const EXCAVATE_SLICE = defineSlice<{
  cells: Vec3[];
  idx: number;
  active: boolean;
  checkedIdx: number; // last corridor idx whose exposed-ore was checked (avoid re-check thrash)
}>("excavate", () => ({ cells: [], idx: 0, active: false, checkedIdx: -1 }));

interface ExcavateRun extends BreakRun {
  stall: number; // consecutive no-progress ticks on the current corridor cell → skip it
  forIdx: number; // the corridor idx this run state belongs to (resets the stall budget)
  bridgeIdx: number; // corridor idx whose void-crossing was already logged (once per cell, not per tick)
  // Heartbeat for the universal progress contract: the fingerprint the EXCAVATE
  // ProgressPolicy reads. The per-cell `stall` counter only increments on a BLOCKED greedy verdict,
  // so a wedge where greedy keeps answering "moving" (live: bot fell 2 below the band
  // through the void gap it was bridging; the per-tick key release cut every up-step jump one tick
  // in, so it hopped in place for 11+ minutes) never trips it. This fingerprints observable progress
  // (cursor, grounded feet cell, current break target); the handler updates it from GROUNDED ticks
  // ONLY, so a hop loop that flips grounded/airborne can't re-arm the kernel's clock every hop.
  progressSig: string;
  // One rescue per corridor cell: on a progress stall (kernel fires the EXCAVATE policy's onStall),
  // drive greedyStep CONTINUOUSLY (bypassing the settle gate + key release, exactly like a GOTO leg)
  // toward the corridor cell until this tick — greedy's full drive can climb/pillar/mine back into
  // the band, which the settle-gated corridor step cannot. A second stall on the same idx (or a
  // blocked rescue verdict) skips the cell.
  rescueIdx: number;
  rescueUntil: number;
}
const EXC_RUN = defineSlice<ExcavateRun>("excavateRun", () => ({
  ...freshBreakRun(),
  stall: 0,
  forIdx: -1,
  bridgeIdx: -1,
  progressSig: "",
  rescueIdx: -1,
  rescueUntil: 0,
}));

type Read = (x: number, y: number, z: number) => string;

function reader(rt: Runtime): Read {
  return (x, y, z) => {
    const r = rt.world.blockId({ x, y, z });
    return r.ok ? r.value : "minecraft:stone"; // unreadable = solid (conservative, never a fake)
  };
}

/** Would a bridge EVER reach this floorless corridor cell? bridgePlace (movement-types) only starts a
 *  bridge that hits real ground within `bridgeMaxRun` — it never bridges into a bottomless void. The
 *  serpentine is pure geometry over the FULL ±maxRadius box, so it emits many cells hanging over PURE
 *  void with no ore and no landing anywhere near; greedy jitters "moving" toward each until the 200-tick
 *  corridor watchdog skips it, so the bot burns minutes on unreachable ±maxRadius corner cells and falls
 *  before it ever reaches the real vein (live drill-gap-vein: whole band lost this way).
 *  Prune such a cell in ONE check: a landing exists iff some cell within `bridgeMaxRun` (Chebyshev) of the
 *  target is walkable at the bridge level, one step UP (a rim's top-face foothold — a pickaxe mines ore
 *  standing ore.y+1), or a survivable drop below (a lower far rim) — mirroring bridgePlace's own landfall
 *  search so we prune exactly the cells it would refuse, no more. Early-outs on the first landing found. */
function hasBridgeLandfall(read: Read, target: Vec3, cfg: Config): boolean {
  const run = Math.max(1, Math.floor(cfg.nav.bridgeMaxRun));
  const cap = { maxFallDamage: cfg.nav.maxFallDamage };
  for (let dx = -run; dx <= run; dx++) {
    for (let dz = -run; dz <= run; dz++) {
      if (dx === 0 && dz === 0) continue;
      const ax = target.x + dx;
      const az = target.z + dz;
      if (walkableAt(read, { x: ax, y: target.y + 1, z: az })) return true;
      for (let down = 0; down <= cfg.nav.maxDrop && canSurviveFall(down, cap); down++) {
        if (walkableAt(read, { x: ax, y: target.y - down, z: az })) return true;
      }
    }
  }
  return false;
}

/** Void guard for one corridor stand-cell — the fix for ravine/gap thrash. planExcavation is pure
 *  geometry: it enumerates every cell in the vein box blind to terrain, so a box overlapping a cave/
 *  ravine/gap emits stand-cells hanging over open air. You can't strip-mine air and greedy can't stand
 *  there. Returns "skip" (skipCell already fired — the caller MUST return) when the cell hangs over a
 *  void we can't cross, "proceed" otherwise. Only inspects cells we haven't reached yet (a cell the bot
 *  already stands on has a solid floor, so it's never wrongly skipped); a shallow 1-block drop is left
 *  to greedy, only a real void (air ≥ cfg.excavate.voidProbe blocks down) is pruned. When filler + cfg.nav.bridge
 *  are available AND a landfall is in range, keeps the cell so the dig/step path bridges across it. */
function guardVoidCell(ctx: Ctx, feet: Vec3, target: Vec3): "skip" | "proceed" {
  const { rt, cfg, st } = ctx;
  if (feet.x === target.x && feet.z === target.z && feet.y === target.y) return "proceed";

  const probe = reader(rt);
  for (let d = 1; d <= Math.max(1, cfg.excavate.voidProbe); d++) {
    if (!AIR.has(probe(target.x, target.y - d, target.z))) return "proceed"; // solid floor below → real cell
  }

  const exc = ctx.slice(EXCAVATE_SLICE);
  const run = ctx.slice(EXC_RUN);
  // Voided. Mine ACROSS the void (not around it) when we can deck it: greedy's bridgePlace lays filler
  // under the next cell and walks on, so with filler + cfg.nav.bridge the far side of a ravine-bisected vein
  // stays mineable. Skip only when we can't deck it (no filler / bridge off).
  if (!(cfg.nav.bridge && fillerStatus(rt, cfg).enough)) {
    ctx.log.info(st.tickCount, "EXCAVATE_VOID_SKIP", { at: target, reason: "no bridge" });
    skipCell(ctx, "excavate: stand-cell over a void, no bridge → skip");
    return "skip";
  }
  // Bridging needs somewhere to land: the terrain-blind serpentine also emits whole ROWS hanging over
  // open air with no rim in any direction (live drill-gap-vein: the z=-4 rows). Greedy can't offer
  // bridgePlace with no landfall, so it just walks-and-blocks on every such cell, burning cfg.drill.digToStallTicks
  // apiece before skipping — the bot never reaches the reachable far rim. Prune these in ONE tick so the
  // serpentine advances to the row where the far ore IS bridgeable.
  if (!hasBridgeLandfall(probe, target, cfg)) {
    ctx.log.info(st.tickCount, "EXCAVATE_VOID_SKIP", { at: target, reason: "no landfall" });
    skipCell(ctx, "excavate: void cell with no bridge landfall in range → skip");
    return "skip";
  }
  if (run.bridgeIdx !== exc.idx) {
    run.bridgeIdx = exc.idx;
    ctx.log.info(st.tickCount, "EXCAVATE_VOID_BRIDGE", { at: target });
  }
  return "proceed";
}

/** Build + install the excavation plan for a vein whose ore band the shaft just reached (anchor =
 *  first-ore cell). Called by DESCEND's reachVeinOrFloor before transitioning to EXCAVATE. */
export function startExcavation(ctx: Ctx, anchor: Vec3, bbox?: VeinBBox | undefined): void {
  const { cfg } = ctx;
  const plan = planExcavation({
    center: anchor,
    bbox,
    maxRadius: cfg.excavate.maxRadius,
    bandHeight: cfg.excavate.bandHeight,
    rowSpacing: cfg.excavate.rowSpacing,
    levelSpacing: cfg.excavate.levelSpacing,
    maxCells: cfg.excavate.maxCells,
  });
  const exc = ctx.slice(EXCAVATE_SLICE);
  exc.cells = [...plan.cells];
  exc.idx = 0;
  exc.active = true;
  exc.checkedIdx = -1;
  const run = ctx.slice(EXC_RUN);
  run.stall = 0;
  run.forIdx = -1;
  ctx.log.info(ctx.st.tickCount, "EXCAVATE_PLAN", {
    anchor,
    box: plan.box,
    cells: plan.cells.length,
    truncated: plan.truncated,
  });
}

/** Finish excavating this band. Count it, then (multi-band, "dig every vein on the way down")
 *  re-anchor the shaft to the marker column and DESCEND to the NEXT band — the depth floor
 *  ends the run gracefully (descend's reachVeinOrFloor → PAUSED once bandsMined>0). With multi-band
 *  off, fall to SCAN for a final sweep (→ PAUSED when dry), the single-band behaviour. */
function done(ctx: Ctx, reason: string): void {
  const exc = ctx.slice(EXCAVATE_SLICE);
  exc.active = false;
  greedyRelease(ctx.rt);
  ctx.log.info(ctx.st.tickCount, "EXCAVATE_DONE", { mined: ctx.slice(MINING_SLICE).brokenCount });
  ctx.slice(DRILL_SLICE).bandsMined++;
  if (ctx.cfg.drill.multiBand) {
    // Keep digging down for more veins instead of parking. Reset shaftStarted so the next DESCEND
    // leg walks back onto the marker column + re-centres (the bot is at a corridor edge now, ±bbox
    // from the marker); surfaceY is deliberately NOT reset, so the surface-scatter skip never
    // re-arms deep underground.
    const run = ctx.slice(DRILL_RUN);
    run.shaftStarted = false;
    run.centerTicks = 0;
    ctx.log.info(ctx.st.tickCount, "DRILL_NEXT_BAND", {
      bandsMined: ctx.slice(DRILL_SLICE).bandsMined,
    });
    ctx.transition(STATE.DESCEND, `${reason} → descend to next band`);
    return;
  }
  ctx.transition(STATE.SCAN, reason);
}

/** Hand the just-exposed ore to the MINE vein-follow (or GOTO if the stand pos differs). Returns
 *  true if it handed off (caller returns). Only fires once per corridor idx (checkedIdx) so a
 *  cached-unreachable exposed ore can't re-trigger every tick. */
function grabExposedOre(ctx: Ctx, feet: Vec3): boolean {
  const { rt, cfg, st } = ctx;
  const exc = ctx.slice(EXCAVATE_SLICE);
  if (exc.checkedIdx === exc.idx) return false; // already checked this corridor cell
  exc.checkedIdx = exc.idx;
  const mem = ctx.slice(MINING_SLICE);
  const profile = mem.profile;
  if (!profile) return false;
  const hit = exposedTargetNear(
    reader(rt),
    (id) => profile.isTarget(id),
    feet,
    cfg.drill.scanRadius,
  );
  if (!hit) return false;
  const strategy = strategyForTool(heldStack(rt)?.id ?? null);
  const sol = setMiningTarget(mem, hit, strategy, { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 });
  greedyRelease(rt);
  ctx.log.info(st.tickCount, "EXCAVATE_ORE", { ore: hit, stand: sol.standPos });
  ctx.transition(sol.sameStandPos ? STATE.MINE : STATE.GOTO, "excavate: exposed ore → mine");
  return true;
}

/** Break ONE corridor cell via the shared AIM→BREAK; timeout → skip this corridor cell (graceful). */
function breakCell(ctx: Ctx, target: Vec3): void {
  const outcome = stepBreak(ctx.rt, ctx.cfg, ctx.st.tickCount, ctx.slice(EXC_RUN), target, "TOP");
  if (outcome === "timeout") {
    ctx.log.warn(ctx.st.tickCount, "EXCAVATE_BREAK_TIMEOUT", { at: target });
    skipCell(ctx, "excavate break timeout");
  }
}

/** Give up the current corridor cell (unreachable / hazard / stuck) and advance the cursor. Never
 *  ERROR — the next corridor may still be diggable, and a fully-undiggable plan ends at SCAN→PAUSED.
 *  Logged: a silent skip loop reads as a healthy EXCAVATE from the journal (live — the
 *  jump-in-place wedge took an hour to diagnose partly because this path left no trace). */
function skipCell(ctx: Ctx, reason: string): void {
  const exc = ctx.slice(EXCAVATE_SLICE);
  const run = ctx.slice(EXC_RUN);
  ctx.log.info(ctx.st.tickCount, "EXCAVATE_SKIP_CELL", { idx: exc.idx, reason });
  exc.idx++;
  run.stall = 0;
  greedyRelease(ctx.rt);
}

export const excavate: Capability = {
  name: "excavate",

  // Universal progress contract: the below-band jump-in-place watchdog. Detection is the
  // kernel's (signature frozen past budget); the recovery ACTION — one continuous-drive rescue leg,
  // then skip the cell — is this policy's onStall. The signature is the handler's grounded heartbeat
  // (cursor|feet|break-target), "init" before the first grounded tick so a never-grounds airborne
  // wedge still accumulates. Exempt while a rescue leg is in flight (it holds keys continuously; its
  // own arrival/blocked handling is in the handler) so the watchdog doesn't double-fire on it.
  progress: {
    EXCAVATE: {
      name: "excavate-corridor",
      signature: (ctx: Ctx) => {
        const run = ctx.slice(EXC_RUN);
        if (run.rescueUntil > ctx.st.tickCount) return null;
        return run.progressSig || "init";
      },
      budgetTicks: (cfg) => cfg.excavate.stallTicks,
      onStall: {
        handle: (ctx: Ctx) => {
          const exc = ctx.slice(EXCAVATE_SLICE);
          const run = ctx.slice(EXC_RUN);
          if (run.rescueIdx === exc.idx) {
            skipCell(ctx, "excavate stalled twice on this cell → skip");
            return;
          }
          run.rescueIdx = exc.idx;
          run.rescueUntil = ctx.st.tickCount + ctx.cfg.excavate.rescueTicks;
          ctx.log.warn(ctx.st.tickCount, "EXCAVATE_STALL", {
            idx: exc.idx,
            rescueTicks: ctx.cfg.excavate.rescueTicks,
          });
        },
      },
    },
  },

  // Route the generic MINE→SCAN handoff back into EXCAVATE while a plan is live: after MINE
  // vein-follows a clump to exhaustion it lands in SCAN; if excavation is still unfinished, resume
  // the corridor instead of parking. When the plan IS finished (idx past the end) the guard stays
  // out of the way, so SCAN runs its normal spiral → PAUSED.
  guard(ctx: Ctx): boolean {
    if (ctx.st.phase !== STATE.SCAN) return false;
    const exc = ctx.slice(EXCAVATE_SLICE);
    if (!exc.active || exc.idx >= exc.cells.length) return false;
    ctx.transition(STATE.EXCAVATE, "excavate: resume corridor after mining clump");
    return true;
  },

  handlers: {
    EXCAVATE(ctx: Ctx): void {
      const { rt, cfg, st } = ctx;
      const exc = ctx.slice(EXCAVATE_SLICE);
      const run = ctx.slice(EXC_RUN);

      if (!exc.active || exc.idx >= exc.cells.length) {
        done(ctx, "excavate: plan complete");
        return;
      }

      const posR = rt.player.pos();
      if (!posR.ok) return;
      const target = must(exc.cells[exc.idx], "excavate idx in range");
      const groundedR = rt.player.onGround();
      const grounded = !groundedR.ok || groundedR.value; // unreadable → assume settled (matches the old gate)

      // Heartbeat for the universal progress contract: fingerprint observable progress
      // (cursor, grounded feet cell, current break target) so the EXCAVATE ProgressPolicy can detect
      // the below-band hop-in-place wedge — greedy answers "moving" forever while the bot never
      // advances (live, 11+ min of jumping; the per-cell `stall` budget only counts
      // BLOCKED verdicts, so it never trips). Update from GROUNDED ticks ONLY: a jump loop alternates
      // grounded/airborne every few ticks, and a sig that encoded that flip would re-arm the kernel's
      // clock each hop — blinding the watchdog in exactly the wedge it exists for. Airborne ticks
      // leave the fingerprint frozen so time accumulates; the policy's onStall drives the rescue/skip.
      if (grounded) {
        const f = floorVec(posR.value);
        run.progressSig = `${exc.idx}|${f.x},${f.y},${f.z}|${run.forKey}`;
      }
      if (run.rescueUntil > st.tickCount) {
        // Rescue in flight (armed by the EXCAVATE policy's onStall): drive greedy EVERY tick (keys
        // held across the jump arc — no release, no settle gate), exactly like a GOTO leg. Arrived →
        // resume the normal corridor logic below; blocked → the cell is genuinely unreachable, skip
        // it; still moving → keep the keys this tick (the policy exempts these ticks from the clock).
        const rstep = greedyStep(rt, cfg, cellCenter(target), { block: true, log: ctx.log });
        if (rstep === "arrived") {
          run.rescueUntil = 0;
        } else if (isBlocked(rstep)) {
          run.rescueUntil = 0;
          skipCell(ctx, "excavate rescue blocked → skip");
          return;
        } else {
          return; // moving — let the drive keep its keys this tick
        }
      }

      greedyRelease(rt); // re-asserted below if we move this tick

      // Settle before reading/breaking (a mid-fall read gives a floating feet cell).
      if (!grounded) return;

      const feet = floorVec(posR.value);

      // New corridor cell → fresh break/stall budget.
      if (run.forIdx !== exc.idx) {
        run.forIdx = exc.idx;
        run.stall = 0;
        run.forKey = "";
      }

      // Void guard — the fundamental fix for ravine/gap thrash (see guardVoidCell). Prune a stand-cell
      // hanging over open air THIS tick instead of jittering greedy toward it for cfg.drill.digToStallTicks.
      if (guardVoidCell(ctx, feet, target) === "skip") return;

      const plan = planDigStep(feet, target);
      if (plan === "arrived") {
        // At the corridor cell: sweep any ore its walls expose (→MINE), else advance the cursor.
        if (grabExposedOre(ctx, feet)) return;
        exc.idx++;
        return;
      }
      if (plan === "needPillar") {
        // A corridor level is never ABOVE the current one (we only descend), so this shouldn't occur;
        // if it does, the cell isn't diggable from here — skip it.
        skipCell(ctx, "excavate: needPillar (unexpected up-step) → skip");
        return;
      }

      const read = reader(rt);
      // Hazard veto: never mine a corridor into lava/etc — skip the cell.
      for (const c of plan.clear) {
        if (hazardAt(read, c)) {
          ctx.log.warn(st.tickCount, "EXCAVATE_HAZARD", { at: c });
          skipCell(ctx, "excavate hit a hazard → skip");
          return;
        }
      }

      // Clear the path one solid cell at a time; only once it's all air do we step in.
      const solid = plan.clear.filter((c) => !AIR.has(read(c.x, c.y, c.z)));
      if (solid.length > 0) {
        breakCell(ctx, must(solid[0], "non-empty solid clear list"));
        run.stall = 0; // breaking IS progress
        return;
      }

      // Path clear → let greedy walk/jump INTO the next cell. A GoalBlock (exact feet-cell) arrival,
      // NOT a sub-block radius: the corridor step targets a DIFFERENT cell, and a GoalNear radius around
      // a cell centre can never be satisfied by the planner (planPath tests integer cells; the closest
      // cell coord is ~0.87 from its own centre > cfg.drill.centerTol) → every corridor step blocked_no_path
      // and the whole excavation skipped without mining (the live NO_PATH spin). GoalBlock floors → the
      // adjacent cleared cell matches, greedy walks in.
      const step = greedyStep(rt, cfg, cellCenter(plan.next), { block: true, log: ctx.log });
      if (step === "arrived") {
        run.stall = 0;
      } else if (isBlocked(step)) {
        run.stall++;
        if (run.stall >= cfg.drill.digToStallTicks) {
          // Surface the greedy branch/reason (navRouteSnapshot.lastStep) so a systematic NO_PATH is
          // diagnosable: which planner branch refused, and the exact next/feet cells it read.
          const snap = navRouteSnapshot().lastStep;
          ctx.log.info(st.tickCount, "EXCAVATE_NO_PATH", {
            next: plan.next,
            target,
            feet,
            step,
            branch: snap.branch,
            snapNext: snap.next,
          });
          skipCell(ctx, "excavate: greedy can't reach next cell → skip");
        }
      } else {
        run.stall = 0; // "moving" is progress
      }
    },
  },
};
