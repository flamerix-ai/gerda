import { STATE } from "@/bot/profile/states";
import { dist } from "@/core/prim/pos";
import type { Vec3 } from "@/core/runtime/types";
// navProbe — a per-tick live test harness for the greedy navigator (own navigator; Baritone
// removed). While a greedy_drive {x,y,z} target is set it drives the bot there EVERY tick (the
// production cadence navigation.GOTO uses) and logs NAV_PROBE_DONE with the tick count + route
// snapshot, so a leg can be exercised in isolation without faking a mission.
//
// Test-only + self-limiting: drives ONLY while idle/paused (never during a real mission phase)
// and ONLY while a target is set, auto-clearing on arrived/blocked/timeout. The per-tick
// step-hazard veto is continuous (unlike the intermittent diagnostics greedy_to).
import type { Config } from "@/shared/config/schema";
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { defineSlice } from "@/shared/kernel/slice";
import {
  greedyRelease,
  greedyStep,
  navRouteSnapshot,
  parkourSnapshot,
  parkourTraceDump,
  resetGreedyNav,
} from "@/shared/nav";

interface NavProbeMem {
  target: Vec3 | null;
  startTick: number;
  lastParkourSig: string; // dedup the per-tick parkour trace → log only on a state CHANGE
  lastStepSig: string; // dedup the per-tick branch+next decision → log only on a CHANGE
}
const NAV_PROBE_SLICE = defineSlice<NavProbeMem>("navProbe", () => ({
  target: null,
  startTick: 0,
  lastParkourSig: "",
  lastStepSig: "",
}));

// Runtime arrival-tolerance override for the probe — lets us demo exact-block landing (tighten
// to ~0.4) without a redeploy. null → fall back to cfg.nav.gotoArrivalDist.
const NAV_ARRIVAL_SLICE = defineSlice<{ dist: number | null }>("navArrival", () => ({
  dist: null,
}));

// Runtime timeout override for the probe (ticks) — lets us run a LONG natural traverse (a whole
// mountain crossing of hundreds of blocks at ~1 block/s climbing) past the default cfg.nav.gotoTimeoutTicks
// (~20s) without a redeploy. null → fall back to cfg.nav.gotoTimeoutTicks. Set via set_timeout.
const NAV_TIMEOUT_SLICE = defineSlice<{ ticks: number | null }>("navTimeout", () => ({
  ticks: null,
}));

// Per-drive engine override (A/B without a redeploy): `on` forces cfg.nav.dStar (the D* Lite
// incremental engine) for this leg, and `noFiller` strips the filler/mine moves so D* Lite is
// actually engageable (those large-reach moves keep A*) — i.e. the "cross the hill WITHOUT
// laying stones" run. Both default off → the production config drives. set via set_dstar.
const NAV_DSTAR_SLICE = defineSlice<{ on: boolean; noFiller: boolean }>("navDStar", () => ({
  on: false,
  noFiller: false,
}));

// Decides the END of a probe run: logs the NAV_PROBE_DONE verdict (result + tick cost + how far
// short of the target we stopped + the route counters) and tears the drive down — clears the target,
// releases the greedy keys and stops the nav arm. Every exit path (timeout/arrived/blocked) goes
// through here so a run can never leave keys held or a stale target driving.
function finishProbeRun(ctx: Ctx, mem: NavProbeMem, target: Vec3, result: string): void {
  const { rt, st } = ctx;
  const endR = rt.player.pos();
  const finalDist = endR.ok ? Math.round(dist(endR.value, target) * 100) / 100 : null;
  const snap = navRouteSnapshot();
  const eng = ctx.slice(NAV_DSTAR_SLICE);
  ctx.log.info(st.tickCount, "NAV_PROBE_DONE", {
    impl: eng.on ? "dstar" : "astar",
    noFiller: eng.noFiller,
    result,
    target,
    ticks: st.tickCount - mem.startTick,
    finalDist,
    end: endR.ok ? endR.value : null,
    lastBlock: snap.lastBlock,
    plans: snap.plans,
    follows: snap.follows,
  });
  mem.target = null;
  greedyRelease(rt);
  rt.nav.stop(); // also halts the Baritone arm if that was driving
}

// Decides WHICH config this drive runs under: the per-drive engine override (set_dstar) forces the
// D* Lite engine and/or strips the filler/mine moves so it's engageable, WITHOUT touching the baked
// config. Both flags off (the default slice) → the production config passes through unchanged.
function probeDriveConfig(cfg: Config, eng: { on: boolean; noFiller: boolean }): Config {
  if (!eng.on && !eng.noFiller) return cfg;
  return {
    ...cfg,
    nav: {
      ...cfg.nav,
      dStar: eng.on,
      ...(eng.noFiller ? { bridge: false, pillar: false, mine: false, waterDrop: false } : {}),
    },
  };
}

// Decides whether the parkour run-up is worth a NAV_PARKOUR row this tick: only on a CHANGE of its
// phase/launch state — per-tick logging floods the ring buffer and evicts the bridge-phase events
// that precede a fall (learned the hard way). Sample the trajectory (~every 4 ticks) AND always log
// a launch/phase change — keying only on phase/takeoff would hide an oscillation (re-init keeps the
// same takeoff) and the launch tick.
function traceParkourChange(ctx: Ctx, mem: NavProbeMem): void {
  const { rt, st } = ctx;
  const pk = parkourSnapshot();
  const sig = pk.active
    ? `${pk.phase}:${pk.launched}:${pk.takeoffX}:${pk.anchorX}:${Math.floor(st.tickCount / 4)}`
    : "";
  if (sig === mem.lastParkourSig) return;
  mem.lastParkourSig = sig;
  if (!pk.active) return;
  const v = rt.player.velocity();
  const og = rt.player.onGround();
  const p = rt.player.pos();
  ctx.log.info(st.tickCount, "NAV_PARKOUR", {
    phase: pk.phase,
    takeoffX: pk.takeoffX,
    anchorX: pk.anchorX,
    launched: pk.launched,
    speed: v.ok ? Math.round(Math.hypot(v.value.x, v.value.z) * 1000) / 1000 : null,
    x: p.ok ? Math.round(p.value.x * 100) / 100 : null,
    y: p.ok ? Math.round(p.value.y * 100) / 100 : null,
    ground: og.ok ? og.value : null,
  });
}

// Decides whether the DRIVE's actual branch+next decision changed, and logs NAV_STEP only then — a
// leg that loops shows a fixed `branch:next` that never advances (the cached-reader-vs-live
// divergence we're hunting: e.g. branch "mine"/"bridge" pinned on a cell that never clears). Logging
// every tick floods the ring; the change-key (branch + next cell + the moving/blocked result)
// surfaces the loop without the noise.
function traceStepChange(ctx: Ctx, mem: NavProbeMem, result: string): void {
  const { rt, st } = ctx;
  const ls = navRouteSnapshot().lastStep;
  const stepSig = `${ls.branch}|${ls.next ? `${ls.next.x},${ls.next.y},${ls.next.z}` : "-"}|${result}`;
  if (stepSig === mem.lastStepSig) return;
  mem.lastStepSig = stepSig;
  const p = rt.player.pos();
  ctx.log.info(st.tickCount, "NAV_STEP", {
    branch: ls.branch,
    next: ls.next,
    feet: ls.feet,
    result,
    x: p.ok ? Math.round(p.value.x * 100) / 100 : null,
    y: p.ok ? Math.round(p.value.y * 100) / 100 : null,
    z: p.ok ? Math.round(p.value.z * 100) / 100 : null,
  });
}

export const navProbe: Capability = {
  name: "navProbe",
  // Heartbeat: drive the probe EVERY tick, even with no mission running, so greedy_drive works from a
  // clean IDLE — no need to fake a mission (mission_start mine → pause) just to get running:true. That
  // fake was a real confound source (the mine mission could find live ore / wander off mid-test). The
  // guard still self-limits: it only acts while a target is set AND phase is IDLE/PAUSED, and always
  // returns false (never preempts a real guard), so this is safe to run unconditionally.
  always: true,

  guard(ctx: Ctx): boolean {
    const mem = ctx.slice(NAV_PROBE_SLICE);
    if (!mem.target) return false;
    // Drive only while idle/paused — never fight a real mission's own movement.
    if (ctx.st.phase !== STATE.IDLE && ctx.st.phase !== STATE.PAUSED) return false;

    const { rt, cfg, st } = ctx;
    const target = mem.target;

    // Shared timeout so a wedged leg can't drive forever (overridable for long natural legs).
    const timeoutTicks = ctx.slice(NAV_TIMEOUT_SLICE).ticks ?? cfg.nav.gotoTimeoutTicks;
    if (st.tickCount - mem.startTick > timeoutTicks) {
      finishProbeRun(ctx, mem, target, "timeout");
      return false;
    }

    const arrival = ctx.slice(NAV_ARRIVAL_SLICE).dist ?? cfg.nav.gotoArrivalDist;
    const driveCfg = probeDriveConfig(cfg, ctx.slice(NAV_DSTAR_SLICE));
    const result = greedyStep(rt, driveCfg, target, { arrivalRadius: arrival });
    traceParkourChange(ctx, mem);
    traceStepChange(ctx, mem, result);
    if (result !== "moving") finishProbeRun(ctx, mem, target, result);
    return false; // never preempt real guards
  },

  commands: {
    // greedy_drive {x,y,z} — drive the greedy navigator to a target (the test/bench probe).
    greedy_drive(ctx: Ctx, cmd: Record<string, unknown>): void {
      const x = Number(cmd["x"]);
      const y = Number(cmd["y"]);
      const z = Number(cmd["z"]);
      if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) {
        ctx.reply({ error: "greedy_drive needs numeric x,y,z" });
        return;
      }
      resetGreedyNav(); // fresh planning cache
      const mem = ctx.slice(NAV_PROBE_SLICE);
      mem.target = { x, y, z };
      mem.startTick = ctx.st.tickCount;
      ctx.reply({ driving: { x, y, z }, impl: "greedy", phase: ctx.st.phase });
    },

    // nav_trace — dump the full per-tick parkour trace from the last greedy_drive (UN-sampled,
    // one row per tick the parkour executor ran). The debug instrument that replaces grepping the
    // evicting/sampled NDJSON log: reveals the exact launch tick, speed + across at takeoff, and the
    // action the executor took each tick. {tail?} returns only the last N rows.
    nav_trace(ctx: Ctx, cmd: Record<string, unknown>): void {
      const full = parkourTraceDump();
      const tail = Number(cmd["tail"]);
      const rows = Number.isFinite(tail) && tail > 0 ? full.slice(-tail) : full;
      ctx.reply({ count: full.length, returned: rows.length, trace: rows });
    },

    // greedy_drive_stop — clear the target and release movement keys.
    greedy_drive_stop(ctx: Ctx): void {
      ctx.slice(NAV_PROBE_SLICE).target = null;
      greedyRelease(ctx.rt);
      ctx.rt.keys.releaseAll();
      ctx.reply({ stopped: true });
    },

    // set_dstar {on?, noFiller?} — per-drive engine override for the A/B (no redeploy). `on` forces
    // the D* Lite incremental engine; `noFiller` strips filler/mine moves so D* Lite engages (the
    // "cross the hill without laying stones" run). Both false → the baked config. Persists across
    // greedy_drive calls until cleared (set_dstar {} → both off).
    set_dstar(ctx: Ctx, cmd: Record<string, unknown>): void {
      const s = ctx.slice(NAV_DSTAR_SLICE);
      const truthy = (v: unknown): boolean => v === true || v === "true" || v === 1;
      s.on = truthy(cmd["on"]);
      s.noFiller = truthy(cmd["noFiller"]);
      ctx.reply({ navDStar: s.on, noFiller: s.noFiller });
    },

    // set_timeout {ticks} — runtime timeout override for the probe (how long a leg may drive before
    // it gives up). ticks <= 0 or omitted clears the override → cfg.nav.gotoTimeoutTicks. Raise it to run
    // a long natural mountain crossing (hundreds of blocks) that the default ~20s would cut short.
    set_timeout(ctx: Ctx, cmd: Record<string, unknown>): void {
      const slice = ctx.slice(NAV_TIMEOUT_SLICE);
      const t = Number(cmd["ticks"]);
      slice.ticks = Number.isFinite(t) && t > 0 ? t : null;
      ctx.reply({
        timeout: slice.ticks ?? ctx.cfg.nav.gotoTimeoutTicks,
        override: slice.ticks !== null,
      });
    },

    // set_arrival {dist} — runtime arrival tolerance for the probe (how close = "arrived").
    // dist <= 0 or omitted clears the override → cfg.nav.gotoArrivalDist. Tighten (e.g. 0.4) to
    // demo landing exactly on the target block; the walk-down final approach keeps it safe.
    set_arrival(ctx: Ctx, cmd: Record<string, unknown>): void {
      const slice = ctx.slice(NAV_ARRIVAL_SLICE);
      const d = Number(cmd["dist"]);
      slice.dist = Number.isFinite(d) && d > 0 ? d : null;
      ctx.reply({
        arrival: slice.dist ?? ctx.cfg.nav.gotoArrivalDist,
        override: slice.dist !== null,
      });
    },
  },
};
