import type { Runtime } from "@/core/runtime/Runtime";
import type { Vec3 } from "@/core/runtime/types";
// — Pillar-up executor ————————————————————————————————————————————————————————————————————————
// Rising a SHEER wall is a multi-tick action (jump → place filler under the feet at the apex →
// settle onto it, +1 Y), unlike the stateless key-holds of walk/step/parkour. So the executor
// carries a small jump-place state machine here, ported from the drill's PILLAR_UP phase (which
// it now generalises: any mission that asks the navigator to reach an overhead cell gets pillaring
// for free — the mission never reasons about HOW to climb). The planner picks the move (cost-gated
// behind every cheaper climb); greedyStep detects a straight-up next cell and hands it to pillarStep.
import type { Config } from "@/shared/config/schema";
import {
  type GreedyStep,
  greedyRelease,
  mustOnGround,
  mustSetYaw,
  mustVelocity,
} from "@/shared/nav/core";
import { equipFiller } from "@/shared/nav/place-cell";
import { blk } from "@/shared/nav/route";

/** Per-ascent pillar state — a module singleton (like worldView), keyed by the column so a fresh
 *  column restarts the cycle. `baseY` is the feet-Y the current jump-place cycle launched from
 *  (managed on the ground in CENTER, NOT from a transient mid-jump floor(y) — the apex briefly
 *  reads +1, the bug the drill phase documents). `savedSlot` holds the mining-tool hotbar index so
 *  we hand it back when the ascent ends. */
interface PillarRun {
  active: boolean;
  colX: number; // the column being climbed (a new column resets the machine)
  colZ: number;
  sub: "CENTER" | "JUMP" | "PLACE" | "SETTLE";
  baseY: number;
  cycleStart: number; // tick the current jump-place cycle began (per-cycle stall timeout)
  attempts: number; // consecutive cycles that failed to rise → eventually give up (blocked)
  savedSlot: number; // hotbar index the mining tool was in before filler (-1 = unset)
}
function freshPillarRun(): PillarRun {
  return {
    active: false,
    colX: 0,
    colZ: 0,
    sub: "CENTER",
    baseY: 0,
    cycleStart: 0,
    attempts: 0,
    savedSlot: -1,
  };
}
let pillarRun: PillarRun = freshPillarRun();

/** Read-only view of the in-flight ascent (active + column) — greedyStep's tick-ownership test
 *  reads this instead of the singleton, keeping the machine's state private to this module. */
export function pillarState(): { active: boolean; colX: number; colZ: number } {
  return { active: pillarRun.active, colX: pillarRun.colX, colZ: pillarRun.colZ };
}

/** Drop the pillar machine without touching the held tool — the resetGreedyNav path (a fresh drive
 *  starts clean; the tool restore only matters mid-drive, via endPillarIfActive). */
export function resetPillar(): void {
  pillarRun = freshPillarRun();
}

/** Public: end any in-flight pillar ascent and restore the held mining tool. A caller that owns
 *  arrival OUTSIDE greedy's radius test (DIG_TO detects "arrived" via planDigStep, not greedyStep's
 *  return — a vertical pillar never enters the tight centre radius) calls this on its hand-off so the
 *  bot doesn't walk into MINE holding filler. No-op if no ascent is in flight. */
export function endPillarAscent(rt: Runtime): void {
  endPillarIfActive(rt);
}

/** Re-select the hotbar slot the mining tool was in before we equipped filler, and mark the ascent
 *  ended. Called whenever greedyStep takes a NON-pillar action (arrived / walking / blocked) so the
 *  bot doesn't keep holding filler after the climb. No-op if no ascent is in flight. */
export function endPillarIfActive(rt: Runtime): void {
  if (!pillarRun.active) return;
  if (pillarRun.savedSlot >= 0) {
    const invR = rt.inv.open();
    if (invR.ok) invR.value.selectHotbar(pillarRun.savedSlot);
  }
  pillarRun = freshPillarRun();
}

/** Per-tick sensed environment for the pillar sub-steps (computed once, threaded down). */
interface PillarEnv {
  cx: number;
  cz: number;
  px: number; // exact player X/Z (for the centre nudge)
  pz: number;
  feetY: number;
  posY: number;
  vy: number;
  onGround: boolean;
  downLook: Vec3;
}

/**
 * Drive ONE tick of rising in place toward `up` (= feet + (0,+1,0), same column). Reuses the
 * drill's CENTER→JUMP→PLACE→SETTLE cycle but Ctx-free (rt+cfg only), so it lives in the testable
 * executor. Returns "moving" while climbing; "blocked_no_path" if it can't (no filler / stalled) —
 * the navigation capability logs that loud and escalates. The bot rising a block is detected by the
 * OUTER greedyStep re-planning from the higher cell next tick (which re-enters here for the next
 * block until `up` is no longer straight overhead).
 */
export function pillarStep(rt: Runtime, cfg: Config, up: Vec3): GreedyStep {
  const posR = rt.player.pos();
  if (!posR.ok) return "moving";
  const pos = posR.value;
  const cx = up.x;
  const cz = up.z;
  const feetY = Math.floor(pos.y);

  // (Re)start the machine on a fresh column / first entry. baseY is seeded from the grounded feet.
  if (!pillarRun.active || pillarRun.colX !== cx || pillarRun.colZ !== cz) {
    pillarRun = {
      ...freshPillarRun(),
      active: true,
      colX: cx,
      colZ: cz,
      sub: "CENTER",
      baseY: feetY,
      cycleStart: rt.tick(),
    };
  }
  const run = pillarRun;

  const invR = rt.inv.open();
  if (!invR.ok) return "moving"; // can't read the bag this tick — hold, don't thrash
  if (run.savedSlot < 0) run.savedSlot = invR.value.selectedHotbar();
  const fillerId = equipFiller(invR.value, cfg.nav.fillerBlocks);
  if (!fillerId) {
    // Filler ran out since the plan offered the pillar (act-on-truth) → can't climb. Hand the tool
    // back and report blocked; the navigation capability decides (escalate / fail loud).
    endPillarIfActive(rt);
    greedyRelease(rt);
    return blk("pillar.nofiller", "blocked_no_path");
  }

  // Ground contact + vertical speed gate the jump and the place: unknown ends the drive (nav/core.ts),
  // it is never read as "grounded, not rising".
  const env: PillarEnv = {
    cx,
    cz,
    px: pos.x,
    pz: pos.z,
    feetY,
    posY: pos.y,
    vy: mustVelocity(rt).y,
    onGround: mustOnGround(rt),
    downLook: { x: cx + 0.5, y: run.baseY - 0.5, z: cz + 0.5 },
  };

  // Give up after too many failed cycles — a stalled jump (per-cycle timeout below) or a place that
  // never raised us (settle miss). Hand the tool back and report blocked; navigation escalates.
  if (run.attempts >= cfg.nav.pillarMaxAttempts) {
    endPillarIfActive(rt);
    greedyRelease(rt);
    return blk("pillar.attempts", "blocked_no_path");
  }
  // Per-cycle stall guard — for EVERY sub-state, including CENTER. A CENTER that can't reach the
  // column centre (nudging into a wall/lip) used to spin FOREVER holding filler while owning every
  // greedyStep tick — the whole navigator read dead (zero plans) until a mission abort (live,
  // bot_2). Now a stalled centring counts as a failed cycle like a stalled jump:
  // attempts++ → ≥3 → blocked_no_path and the navigation capability escalates.
  if (rt.tick() - run.cycleStart > cfg.nav.pillarCycleTimeoutTicks) {
    rt.keys.set("key.jump", false);
    run.attempts += 1;
    run.sub = "CENTER";
    run.cycleStart = rt.tick(); // fresh budget for the retry (else it re-times-out every tick)
  }

  if (run.sub === "CENTER") pillarCenter(rt, cfg, run, env);
  else if (run.sub === "JUMP") pillarJump(rt, run, env);
  else if (run.sub === "PLACE") pillarPlace(rt, cfg, run, env);
  else pillarSettle(rt, run, env);
  return "moving";
}

/** CENTER → nudge onto the column centre so the placed block lands squarely under the feet; once
 *  centred + grounded, launch a jump-place cycle from this feet-Y. Inlined (NOT a recursive
 *  greedyStep) — a nested greedyStep would run endPillarIfActive and clobber this very ascent. */
function pillarCenter(rt: Runtime, cfg: Config, run: PillarRun, env: PillarEnv): void {
  rt.keys.set("key.jump", false);
  const dx = env.cx + 0.5 - env.px;
  const dz = env.cz + 0.5 - env.pz;
  if (Math.hypot(dx, dz) <= cfg.drill.centerTol) {
    rt.keys.set("key.forward", false);
    rt.keys.set("key.sprint", false);
    if (env.onGround) {
      run.sub = "JUMP";
      run.baseY = env.feetY;
      run.cycleStart = rt.tick();
    }
    return;
  }
  // Not yet centred — face the column centre and walk toward it (no sprint: a short precise nudge).
  mustSetYaw(rt, Math.atan2(-dx, dz) * (180 / Math.PI)); // failed turn → drive ends, keys released
  rt.keys.set("key.forward", true);
  rt.keys.set("key.sprint", false);
}

/** JUMP → press jump off the ground, then wait for the apex (PLACE). */
function pillarJump(rt: Runtime, run: PillarRun, env: PillarEnv): void {
  greedyRelease(rt);
  void rt.interact.lookAt(env.downLook);
  if (env.onGround) {
    rt.keys.set("key.jump", true);
    run.sub = "PLACE";
    run.cycleStart = rt.tick();
  }
}

/** PLACE → at/just past the apex (feet cleared the cell + falling), place filler on the TOP face of
 *  the block below; the bot drops onto it (+1 Y, SETTLE). Same two physics gates as the drill. */
function pillarPlace(rt: Runtime, cfg: Config, run: PillarRun, env: PillarEnv): void {
  void rt.interact.lookAt(env.downLook);
  const cleared = env.posY - run.baseY >= cfg.nav.pillarApexMinY;
  if (env.onGround || !cleared || env.vy > cfg.nav.pillarApexVy) return;
  rt.keys.set("key.jump", false);
  void rt.interact.placeBlock({ x: env.cx, y: run.baseY - 1, z: env.cz }, "TOP");
  run.sub = "SETTLE";
}

/** SETTLE → back on the ground: a +1 rise means the place worked (next cycle from CENTER); no rise
 *  means a miss — retry, then give up after a few (the outer step turns that into blocked). */
function pillarSettle(rt: Runtime, run: PillarRun, env: PillarEnv): void {
  rt.keys.set("key.jump", false);
  if (!env.onGround) return;
  if (env.feetY >= run.baseY + 1) {
    run.attempts = 0;
    run.sub = "CENTER";
    return;
  }
  run.attempts += 1;
  run.sub = "CENTER";
  // attempts is re-checked at the top of the next pillarStep → blocked_no_path at ≥3 (the
  // navigation capability owns the give-up; the executor has no mem.cache to mark the ore).
}
