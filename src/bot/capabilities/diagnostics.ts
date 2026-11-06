import type { Result } from "@/core/runtime/types";
// diagnostics — a LIVE facade smoke test, run in the WORKER/tick context.
//
// Why this exists: several facade methods that touch raw Java (player sensors via
// getRaw()+SRG calls, interact.eat/respawn via Client.runOnMainThread) passed the
// mock + `bun run check` yet FAILED in-game — a wrong SRG name, or a closure created
// on the worker thread that the render thread refuses to run (see the GraalJS
// single-thread gotcha). The unit tests can't catch that class: the mock never runs
// the real Java. So this command exercises the real facade where the kernel actually
// lives (the worker thread) and logs a PASS/FAIL per check — readable over `get_logs`.
//
// Each check is SAFE/read-mostly by default (sensors + a no-op lookAt + the alive-guard
// path of respawn). The one destructive probe (eat, consumes one food item) is opt-in
// via `smoke {eat:true}` and only fires when food is below max — the host harness
// (scripts/ops/facade_smoke.py) then confirms the EFFECT by polling player.food().
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { greedyRelease, greedyStep } from "@/shared/nav";

interface Check {
  name: string;
  // Returns a short detail string on success; throwing or a falsy Result → FAIL.
  run(ctx: Ctx): { ok: boolean; detail: string };
}

/** PASS a numeric sensor only when it reads ok AND lands in [min,max] (a stale/garbage
 *  read like maxAir=0 or food=-1 is a real fault we want to see, not a silent pass). */
function num(r: Result<number>, min: number, max: number): { ok: boolean; detail: string } {
  if (!r.ok) return { ok: false, detail: `err: ${r.error}` };
  const inRange = r.value >= min && r.value <= max;
  return { ok: inRange, detail: inRange ? String(r.value) : `out of [${min},${max}]: ${r.value}` };
}

function flag(r: Result<boolean>): { ok: boolean; detail: string } {
  return r.ok ? { ok: true, detail: String(r.value) } : { ok: false, detail: `err: ${r.error}` };
}

/** PASS a string reader only when it reads ok AND is non-empty (the world signature is
 *  the gate for ALL persistence — an empty/err read silently disables the world model). */
function str(r: Result<string>): { ok: boolean; detail: string } {
  if (!r.ok) return { ok: false, detail: `err: ${r.error}` };
  return r.value.length > 0 ? { ok: true, detail: r.value } : { ok: false, detail: "empty string" };
}

// One probe per zero-arg player reader (the facade-drift test asserts this list stays
// complete — a new reader without a probe fails the build). Numeric readers also get a
// sanity range so a stale/garbage value (maxAir=0, food=-1) is a FAIL, not a silent pass.
const CHECKS: Check[] = [
  // An empty username would silently break chat addressing (every `!<bot>` line would miss).
  { name: "player.name", run: (c) => str(c.rt.player.name()) },
  { name: "player.pos", run: (c) => (c.rt.player.pos().ok ? ok("read") : fail("pos")) },
  { name: "player.eyePos", run: (c) => (c.rt.player.eyePos().ok ? ok("read") : fail("eyePos")) },
  { name: "player.input", run: (c) => (c.rt.player.input().ok ? ok("read") : fail("input")) },
  {
    name: "player.velocity",
    run: (c) => (c.rt.player.velocity().ok ? ok("read") : fail("velocity")),
  },
  { name: "player.health", run: (c) => num(c.rt.player.health(), 0, 20) },
  { name: "player.food", run: (c) => num(c.rt.player.food(), 0, 20) },
  { name: "player.air", run: (c) => num(c.rt.player.air(), 0, 1000) },
  { name: "player.maxAir", run: (c) => num(c.rt.player.maxAir(), 1, 1000) },
  { name: "player.alive", run: (c) => flag(c.rt.player.alive()) },
  { name: "player.canBreatheWater", run: (c) => flag(c.rt.player.canBreatheWater()) },
  { name: "player.onGround", run: (c) => flag(c.rt.player.onGround()) },
  { name: "player.yaw", run: (c) => num(c.rt.player.yaw(), -360, 360) },
  { name: "inv.open", run: (c) => (c.rt.inv.open().ok ? ok("opened") : fail("open")) },
  // Carry-inventory read-through: slots() count + per-slot occupancy AS THE WORKER SEES IT.
  // Guards decide off this exact view (bag-full completion, loot suppression) — a live
  // CHOP_BAG_FULL at 25 free slots was only explainable with this probe.
  {
    name: "inv.carrySlots",
    run: (c) => {
      const invR = c.rt.inv.open();
      if (!invR.ok) return fail("open");
      const inv = invR.value;
      const slots = inv.slots();
      let free = 0;
      const occ: string[] = [];
      for (const s of slots) {
        const stk = inv.slot(s);
        if (stk === null) free++;
        else occ.push(`${s}:${stk.id.replace("minecraft:", "")}#${stk.count}`);
      }
      return ok(`n=${slots.length} free=${free} occ=[${occ.slice(0, 8).join(",")}]`);
    },
  },
  // The world signature gates WORLD_SCOPE → ALL persistence (waypoints, world model, the
  // JourneyMap mirror). If this FAILs in the worker, add_waypoint/save silently no-op.
  { name: "world.signature", run: (c) => str(c.rt.world.signature()) },
  // world.items reads dropped-item ENTITIES (the loot guard's input). Diagnostic only —
  // confirms getEntities works from the WORKER thread (not just main.js's, where jeval runs)
  // and that ids resolve (getContainedItemStack, not getItem). Detail = count + nearest id.
  {
    name: "world.items",
    run: (c) => {
      const r = c.rt.world.items(16);
      if (!r.ok) return fail(`items: ${r.error}`);
      const ids = r.value.map((it) => it.id).join(",");
      return ok(`n=${r.value.length} ids=[${ids}]`);
    },
  },
  // fs write→read round-trip: catches real-Java IO faults the mock can't (a wrong
  // charset overload silently broke world-model READ → every save clobbered prior data).
  {
    name: "fs.roundtrip",
    run: (c) => {
      const path = `${c.cfg.worldModelPath}.smoke`;
      const token = `smoke-${c.st.tickCount}`;
      const w = c.rt.fs.write(path, token);
      if (!w.ok) return fail(`write: ${w.error}`);
      const r = c.rt.fs.read(path);
      if (!r.ok) return fail(`read: ${r.error}`);
      return r.value === token ? ok("rw match") : fail(`mismatch: ${String(r.value)}`);
    },
  },
  // Exercises the lookAt main-thread path with a benign target (the player's own feet).
  {
    name: "interact.lookAt",
    run: (c) => {
      const p = c.rt.player.pos();
      if (!p.ok) return fail(`no pos: ${p.error}`);
      return c.rt.interact.lookAt(p.value).ok ? ok("rotated") : fail("lookAt");
    },
  },
  // The navigator steers through setYaw (a raw SRG write), NOT through lookAt (jsMacros' own API):
  // on Fabric lookAt passes while setYaw fails, so a lookAt-only smoke hid a bot that cannot steer
  // (docs/PORTABILITY.md). Re-applying the current yaw exercises that path with no visible turn.
  {
    name: "interact.setYaw(current)",
    run: (c) => {
      const y = c.rt.player.yaw();
      if (!y.ok) return fail(`no yaw: ${y.error}`);
      const r = c.rt.interact.setYaw(y.value);
      return r.ok ? ok("steer path works") : fail(`setYaw: ${r.error}`);
    },
  },
  // respawn() is a no-op while alive (returns ok=false-valued) — confirms the method is
  // callable and the alive-guard short-circuits without scheduling a death-screen click.
  { name: "player.respawn(noop)", run: (c) => flag(c.rt.player.respawn()) },
];

function ok(detail: string): { ok: boolean; detail: string } {
  return { ok: true, detail };
}
function fail(detail: string): { ok: boolean; detail: string } {
  return { ok: false, detail };
}

export const diagnostics: Capability = {
  name: "diagnostics",

  // Seed per-tick tracing from config (off in prod). Toggle live with `trace {on}`.
  init(ctx: Ctx): void {
    ctx.st.tracing = ctx.cfg.traceTicks;
    // T: lines log at TRC, below the default INFO threshold — drop the gate when tracing
    // boots on, else the per-tick trace is silently filtered out of get_logs.
    if (ctx.cfg.traceTicks) ctx.log.setMinLevel("TRC");
  },

  commands: {
    // trace {on?} — toggle per-tick decision tracing at runtime (no reload). When on, every
    // tick logs a T:TICK line (phase/mission/running) + any ctx.trace() annotations, all
    // tailable via get_logs. Off = zero cost. `on` omitted → report current state only.
    trace(ctx: Ctx, cmd: Record<string, unknown>): void {
      if (typeof cmd["on"] === "boolean") {
        ctx.st.tracing = cmd["on"];
        // The T: lines emit at TRC; drop the logger gate to TRC while tracing so they
        // reach get_logs, and restore the configured level when tracing turns off.
        ctx.log.setMinLevel(cmd["on"] ? "TRC" : ctx.cfg.logLevel);
      }
      ctx.log.info(ctx.st.tickCount, "TRACE_SET", { tracing: ctx.st.tracing });
      ctx.reply({ tracing: ctx.st.tracing });
    },

    // smoke {eat?} — run the facade smoke checks now, logging SMOKE per check and a
    // SMOKE_DONE summary. The host reads these via get_logs. With eat:true, also dispatch
    // one real bite (if food < max) so the harness can verify the eat path's effect.
    smoke(ctx: Ctx, cmd: Record<string, unknown>): void {
      const { log, st } = ctx;
      let pass = 0;
      let failed = 0;
      for (const check of CHECKS) {
        // smoke is a diagnostic boundary — a throwing probe must be REPORTED as a failed
        // check, never crash the command into ERROR. Each probe is isolated so one bad
        // facade method doesn't hide the rest of the report.
        let res: { ok: boolean; detail: string };
        // reliability-ok: diagnostic boundary — a throwing probe becomes a FAIL row (see above).
        try {
          res = check.run(ctx);
        } catch (e) {
          res = { ok: false, detail: `threw: ${String(e)}` };
        }
        if (res.ok) pass++;
        else failed++;
        log.log(st.tickCount, res.ok ? "INFO" : "WARN", "SMOKE", {
          check: check.name,
          ok: res.ok,
          detail: res.detail,
        });
      }
      // Opt-in destructive probe: dispatch one bite so the host can confirm food rose.
      if (cmd["eat"] === true) {
        const before = ctx.rt.player.food();
        // reliability-ok: best-effort diagnostic bite — the effect is verified host-side.
        void ctx.rt.interact.eat();
        log.info(st.tickCount, "SMOKE_EAT", {
          foodBefore: before.ok ? before.value : -1,
          note: "verify food rises within ~1s (host polls player.food)",
        });
      }
      log.info(st.tickCount, "SMOKE_DONE", { pass, fail: failed, total: CHECKS.length });
    },

    // greedy_to {x,y,z} — drive ONE tick of the greedy executor toward a target,
    // bypassing the FSM/mission entirely (greedyStep is a plain rt+cfg function). The host
    // calls this repeatedly to walk the bot there step-by-step, watching pos/result; on
    // "arrived"/"blocked" the executor releases its own keys. A LIVE integration test of the
    // real planner + step-hazard veto + setRotation + key drive. greedy_stop aborts.
    greedy_to(ctx: Ctx, cmd: Record<string, unknown>): void {
      const x = Number(cmd["x"]);
      const y = Number(cmd["y"]);
      const z = Number(cmd["z"]);
      if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) {
        ctx.reply({ error: "greedy_to needs numeric x,y,z" });
        return;
      }
      const result = greedyStep(ctx.rt, ctx.cfg, { x, y, z });
      const posR = ctx.rt.player.pos();
      const ogR = ctx.rt.player.onGround();
      ctx.reply({
        result,
        pos: posR.ok ? posR.value : null,
        onGround: ogR.ok ? ogR.value : null,
      });
      ctx.log.info(ctx.st.tickCount, "GREEDY_TO", { target: { x, y, z }, result });
    },

    // greedy_stop — release the executor's movement keys (abort a greedy_to walk).
    greedy_stop(ctx: Ctx): void {
      greedyRelease(ctx.rt);
      ctx.rt.keys.releaseAll();
      ctx.reply({ stopped: true });
    },

    // storage_probe {x,y,z} — read a placed container's contents via rt.storage.read from the
    // WORKER thread (the storage-network seam). De-risks whether a remote tile-entity read +
    // ITEM_HANDLER capability work off main.js's thread (block-entities, unlike item entities,
    // were never read worker-side before). Reply = kind/facing/slots, or the facade error.
    storage_probe(ctx: Ctx, cmd: Record<string, unknown>): void {
      const x = Number(cmd["x"]);
      const y = Number(cmd["y"]);
      const z = Number(cmd["z"]);
      if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) {
        ctx.reply({ error: "storage_probe needs numeric x,y,z" });
        return;
      }
      const r = ctx.rt.storage.read({ x, y, z });
      if (!r.ok) {
        ctx.reply({ ok: false, error: r.error });
        ctx.log.info(ctx.st.tickCount, "STORAGE_PROBE_ERR", { x, y, z, error: r.error });
        return;
      }
      ctx.reply({ ok: true, ...r.value });
      ctx.log.info(ctx.st.tickCount, "STORAGE_PROBE", { x, y, z, kind: r.value.kind });
    },
  },
};
