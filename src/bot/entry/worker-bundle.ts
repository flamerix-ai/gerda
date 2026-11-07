// Gerda Bot entry point — OUR implementation of the harness `Module` contract
// (init/tick/command/stop) that worker.js eval-loads. The last line assigns
// `globalThis.Module`, which resolves as the bare `Module` identifier the worker
// reads after `eval(code)` (GraalJS ES2022).
//
// The harness accepts ANY Module implementation (see harness/bot_template.js for
// a plain-JS skeleton) — this one is the full TS kernel: capabilities are
// registered here; the kernel owns the tick pipeline (guards → phase dispatch)
// and command routing.
import { makeChatCommand } from "@/bot/capabilities/chat-command";
import { core } from "@/bot/capabilities/core";
import { diagnostics } from "@/bot/capabilities/diagnostics";
import { makeEventExport } from "@/bot/capabilities/event-export";
import { hud } from "@/bot/capabilities/hud";
import { maintenance } from "@/bot/capabilities/maintenance";
import { makeMissionControl } from "@/bot/capabilities/mission-control";
import { navEngine } from "@/bot/capabilities/nav-engine";
import { navProbe } from "@/bot/capabilities/nav-probe";
import { persistence } from "@/bot/capabilities/persistence";
import { recover } from "@/bot/capabilities/recover";
import { sensors } from "@/bot/capabilities/sensors";
import { telemetry } from "@/bot/capabilities/telemetry";
import { chopMission } from "@/bot/missions/chop";
import { craftMission } from "@/bot/missions/craft";
import { drillMission } from "@/bot/missions/drill";
import { fetchMission } from "@/bot/missions/fetch";
import { followMission } from "@/bot/missions/follow";
import { gotoMission } from "@/bot/missions/goto";
import { huntMission } from "@/bot/missions/hunt";
import { interactMission } from "@/bot/missions/interact";
import { lootRunMission } from "@/bot/missions/loot-run";
import { mineMission } from "@/bot/missions/mine";
import { prospectMission } from "@/bot/missions/prospect";
import { searchMission } from "@/bot/missions/search";
import { smeltMission } from "@/bot/missions/smelt";
import { stashMission } from "@/bot/missions/stash";
import { storageMission } from "@/bot/missions/storage";
import { makeOrchestrator } from "@/bot/orchestrator";
import { gatherAndMine } from "@/bot/plans/gather-and-mine";
import { makeSustainCycle } from "@/bot/plans/sustain-cycle";
import { sustainMineSmelt } from "@/bot/plans/sustain-mine-smelt";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import type { Runtime } from "@/core/runtime/Runtime";
import { createJsMacrosRuntime } from "@/core/runtime/jsmacros";
import { assertConfigOverrideKeys } from "@/shared/config/schema";
import { chatTextOf } from "@/shared/domain/chat-command";
import { Bus } from "@/shared/kernel/bus";
import {
  type BotState,
  type CommandOutcome,
  Kernel,
  makeInitialState,
} from "@/shared/kernel/capability";
import { EventBuffer, type RingEvent } from "@/shared/kernel/event-buffer";
import { type LogSink, Logger } from "@/shared/kernel/logger";
import { reflexes } from "@/shared/reflexes";

const MACROS_REL = "/config/jsMacros/Macros";

// Build provenance — esbuild `define` (tsup.config.ts) replaces these at build time
// with the git rev (+`-dirty`) and ISO build time. The typeof guard keeps the source
// runnable under vitest, where no define is applied (→ "dev").
declare const __BUILD_REV__: string;
declare const __BUILD_TIME__: string;
const BUILD = {
  rev: typeof __BUILD_REV__ !== "undefined" ? __BUILD_REV__ : "dev",
  time: typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "dev",
};

// OPTIONAL fork/user config override, baked in by esbuild `define` (tsup.config.ts) from the
// gitignored `config/local.overrides.json`. Absent (or under vitest, where no define runs → the
// typeof guard) → {}. Validated fail-loud HERE (unknown top-level key → ContractError naming it)
// before makeGerdaConfig merges it UNDER the runtime-computed keys (worldModelPath/JM), so those win.
declare const __CONFIG_OVERRIDES__: unknown;
const BUILD_OVERRIDES = assertConfigOverrideKeys(
  typeof __CONFIG_OVERRIDES__ !== "undefined" ? __CONFIG_OVERRIDES__ : {},
  "config/local.overrides.json",
);

// Docs for the worker's own (game-logic) commands — travels WITH the bundle, so
// when a new capability adds commands and the bundle is reloaded, the manifest
// the container serves updates automatically (see Module.describe below). Names
// are matched against the kernel's registered commands; unknown names still get
// reported (so nothing is hidden), just without a description — and
// test-ts/commands-ref.test.ts fails the commit on such a row, or on a row no command answers.
// docs/COMMANDS.md is rendered from this table (`just commands-ref`).
const WORKER_COMMAND_DOCS: Record<
  string,
  { desc: string; params: { name: string; type: string; required?: boolean; desc?: string }[] }
> = {
  start: { desc: "start the bot → re-enter the active mission's initial phase", params: [] },
  pause: { desc: "pause the bot → PAUSED", params: [] },
  resume: { desc: "resume the bot from PAUSED", params: [] },
  halt: { desc: "stop the bot (release input, #stop) → PAUSED", params: [] },
  mission_start: {
    desc: "activate a mission by name (switchable at runtime, no reload)",
    params: [
      { name: "name", type: "string", required: true },
      { name: "params", type: "object", required: false },
    ],
  },
  mission_abort: { desc: "stop the active mission → IDLE", params: [] },
  mission_status: { desc: "log the active mission + phase", params: [] },
  missions: { desc: "log the available mission names", params: [] },
  metrics: { desc: "write the telemetry .prom snapshot now + log its path", params: [] },
  smoke: {
    desc: "live facade smoke test (worker context): logs SMOKE per check + SMOKE_DONE",
    params: [
      {
        name: "eat",
        type: "bool",
        required: false,
        desc: "also dispatch one real bite (destructive)",
      },
    ],
  },
  trace: {
    desc: "DIAG: toggle per-tick decision tracing (T:TICK lines in get_logs) without a reload",
    params: [{ name: "on", type: "bool", required: false, desc: "omit → report current state" }],
  },
  storage_probe: {
    desc: "DIAG: read a placed container's contents from the worker thread (kind/facing/slots)",
    params: [
      { name: "x", type: "int", required: true },
      { name: "y", type: "int", required: true },
      { name: "z", type: "int", required: true },
    ],
  },
  goto_waypoint: {
    desc: "send the bot to a known vein, then mine it",
    params: [{ name: "name", type: "string", required: false, desc: "default: nearest vein" }],
  },
  greedy_to: {
    desc: "DIAG: drive one tick of the greedy navigator toward x/y/z — call repeatedly",
    params: [
      { name: "x", type: "int", required: true },
      { name: "y", type: "int", required: true },
      { name: "z", type: "int", required: true },
    ],
  },
  greedy_stop: { desc: "DIAG: release the greedy navigator's movement keys (abort)", params: [] },
  greedy_drive: {
    desc: "DIAG: per-tick greedy nav to x/y/z (continuous veto; safe live test) — idle/paused only",
    params: [
      { name: "x", type: "int", required: true },
      { name: "y", type: "int", required: true },
      { name: "z", type: "int", required: true },
    ],
  },
  greedy_drive_stop: { desc: "DIAG: clear the per-tick greedy target + release keys", params: [] },
  nav_trace: {
    desc: "DIAG: dump the un-sampled per-tick parkour trace of the last greedy_drive",
    params: [{ name: "tail", type: "int", required: false, desc: "return only the last N rows" }],
  },
  set_arrival: {
    desc: "DIAG: runtime arrival tolerance for greedy_drive (≤0 clears → cfg.nav.gotoArrivalDist)",
    params: [{ name: "dist", type: "number", required: false, desc: "e.g. 0.4 for exact-block" }],
  },
  set_dstar: {
    desc: "DIAG: per-drive engine override for greedy_drive A/B — D* Lite engine + strip filler moves",
    params: [
      { name: "on", type: "bool", required: false, desc: "force the D* Lite incremental engine" },
      {
        name: "noFiller",
        type: "bool",
        required: false,
        desc: "strip bridge/pillar/mine so D* engages",
      },
    ],
  },
  set_timeout: {
    desc: "DIAG: runtime timeout (ticks) for greedy_drive — raise for a long natural traverse (≤0 clears → cfg.nav.gotoTimeoutTicks)",
    params: [{ name: "ticks", type: "number", required: false, desc: "e.g. 3000 (~150s)" }],
  },
  nav_engine: {
    desc: "set the navigator engine for production GOTO (no redeploy) — D* Lite only engages on filler-free legs",
    params: [
      {
        name: "engine",
        type: "string",
        required: false,
        desc: "default|astar|dstar|auto (omit → report current)",
      },
    ],
  },
  sensors: {
    desc: "DIAG: live read-out of the sustain-loop sensors — vein exhaustion + item stock (the cycle's guards)",
    params: [
      { name: "items", type: "array", required: false, desc: "item ids to report stock for" },
      {
        name: "includeStorage",
        type: "boolean",
        required: false,
        desc: "also count the open container's storage slots (default carry only)",
      },
    ],
  },
  add_waypoint: {
    desc: "record a waypoint (at the player, or at x/y/z)",
    params: [
      { name: "name", type: "string", required: false },
      { name: "kind", type: "string", required: false },
      { name: "x", type: "int", required: false },
      { name: "y", type: "int", required: false },
      { name: "z", type: "int", required: false },
    ],
  },
  remove_waypoint: {
    desc: "remove a waypoint by name",
    params: [{ name: "name", type: "string", required: true }],
  },
  save_now: { desc: "flush persistence to disk", params: [] },
  plan_start: {
    desc: "load + start a registered plan (the orchestrator chains its mission steps)",
    params: [{ name: "name", type: "string", required: true }],
  },
  proceed: { desc: "approve the pending plan step (alias: continue)", params: [] },
  continue: { desc: "approve the pending plan step (alias: proceed)", params: [] },
  run: {
    desc: "flip the plan to auto and drain to completion (or until a guard blocks)",
    params: [],
  },
  step: { desc: "advance exactly one plan step, then wait for approval again", params: [] },
  select: {
    desc: "jump to a plan step, or run a single mission ad-hoc",
    params: [
      { name: "step", type: "string", required: false, desc: "step index or id (jump)" },
      { name: "mission", type: "string", required: false, desc: "run this mission ad-hoc" },
      { name: "params", type: "object", required: false },
    ],
  },
  plan_abort: { desc: "abort the plan + active mission → IDLE", params: [] },
  plan_status: { desc: "log the plan, cursor, status, blocked reason, active mission", params: [] },
  plans: { desc: "log the available plan names", params: [] },
};

function resolveBase(): string {
  // reliability-ok: FFI probe at the entry seam — `java` only exists inside jsMacros, so
  // the catch distinguishes the real runtime from vitest (where "." is the right base),
  // mirroring jsmacros.ts's `attempt`. Not a swallowed logic error.
  try {
    return java.lang.System.getProperty("user.dir");
  } catch {
    return ".";
  }
}

/** Resolve the active JourneyMap waypoints dir (<base>/journeymap/data/sp/<newest save>/
 *  waypoints) so the kernel can mirror bot waypoints onto the human's map. Returns null if
 *  JourneyMap isn't present, which leaves the mirror disabled. Mirrors ext.js's jmDir(). */
function resolveJourneyMapDir(base: string): string | null {
  // reliability-ok: FFI probe at the entry seam (java only exists in jsMacros); a missing
  // JourneyMap dir just disables the cosmetic mirror (null), never throws into the bundle.
  try {
    const Files = java.nio.file.Files;
    const Paths = java.nio.file.Paths;
    const sp = Paths.get(base, "journeymap", "data", "sp");
    if (!Files.exists(sp)) return null;
    let best: { resolve(s: string): { toString(): string } } | null = null;
    let bestT = -1;
    const it = Files.list(sp).iterator();
    while (it.hasNext()) {
      const d = it.next();
      if (!Files.isDirectory(d)) continue;
      const t = Files.getLastModifiedTime(d).toMillis();
      if (t > bestT) {
        bestT = t;
        best = d;
      }
    }
    return best ? best.resolve("waypoints").toString() : null;
  } catch {
    return null;
  }
}

function makeSink(rt: Runtime, base: string): LogSink {
  const path = `${base}${MACROS_REL}/miner.ndjson`;
  return {
    emit: (line) => rt.fs.appendLine(path, line),
    alert: (line) => rt.chat.log(line),
  };
}

function makeModule() {
  const base = resolveBase();
  // Pin the world-model store next to the journal so it lands deterministically; enable the
  // JourneyMap waypoint mirror when JM is installed (so bot waypoints show on the human's
  // map — appears on the next map (re)open, JM doesn't hot-reload the dir).
  const jmDir = resolveJourneyMapDir(base);
  const cfg = makeGerdaConfig({
    ...BUILD_OVERRIDES,
    worldModelPath: `${base}${MACROS_REL}/mc_world.json`,
    ...(jmDir ? { journeyMapExport: true, journeyMapDir: jmDir } : {}),
  });
  // Facade side-effect failures are reported into the NDJSON log (loud, never swallowed).
  // The reporter reads `log` lazily through a holder (it only fires after construction),
  // so `log` itself stays const — the holder is the single mutable cell.
  const ref: { log: Logger | null } = { log: null };
  // Dedupe identical facade failures so a persistent fault (e.g. an unreadable slot) logs
  // ~once per window instead of every tick — keeps both the journal and the chat alert
  // readable. A genuinely new (op,error) still surfaces immediately.
  const fxSeen = new Map<string, number>();
  const rt = createJsMacrosRuntime(
    (op, error) => {
      const now = rt.tick();
      const key = `${op}:${error}`;
      const last = fxSeen.get(key);
      if (last !== undefined && now - last < cfg.fxDedupeTicks) return;
      fxSeen.set(key, now);
      ref.log?.warn(now, "FX_FAIL", { op, error });
    },
    { containerKinds: cfg.containerKinds },
  );
  const log = new Logger(makeSink(rt, base), cfg.logLevel);
  ref.log = log;
  const bus = new Bus();
  const kernel = new Kernel(rt, log, bus, cfg, GERDA_PHASES);
  // The worker drains this each tick into the GlobalVars event ring (poll_events).
  const events = new EventBuffer();

  // ALWAYS-ON layer: lifecycle (core), the mission-agnostic safety reflexes
  // (vitals/air/tool/stuck/hazard/human), the RECOVER landing, durable waypoints
  // (persistence), the HUD, and the mission-control commands. Mining behaviour is a
  // MISSION (mineMission) — loaded into the registry, activated on demand.
  kernel.register(core);
  for (const r of reflexes) kernel.register(r);
  kernel
    .register(maintenance) // after reflexes: a safety divert preempts a maintenance interrupt
    .register(recover)
    .register(persistence)
    .register(hud)
    .register(telemetry)
    .register(diagnostics)
    .register(navProbe)
    .register(navEngine)
    .register(sensors)
    .register(makeEventExport(events))
    .register(makeMissionControl(kernel))
    .register(makeChatCommand(kernel))
    .registerMission(mineMission)
    .registerMission(fetchMission)
    .registerMission(chopMission)
    .registerMission(craftMission)
    .registerMission(drillMission)
    .registerMission(smeltMission)
    .registerMission(gotoMission)
    .registerMission(stashMission)
    .registerMission(storageMission)
    .registerMission(huntMission)
    .registerMission(followMission)
    .registerMission(lootRunMission)
    .registerMission(searchMission)
    .registerMission(interactMission)
    .registerMission(prospectMission);

  // META layer: the orchestrator chains missions into plans (autonomous or AI-stepped).
  // It is an always-on capability AND installs the kernel's mission sequencer. The sustain
  // loop is built from THIS cfg (base/ore/fuel/batch) — the dynamic-shaft prospect leg.
  const orch = makeOrchestrator(kernel, [gatherAndMine, sustainMineSmelt, makeSustainCycle(cfg)]);
  kernel.register(orch.cap).setSequencer(orch.sequencer);

  return {
    name: "gerda_bot",
    init(): BotState {
      const st = makeInitialState();
      kernel.init(st);
      // Boot straight into the configured mission for deploy parity (the bot was a
      // mining bot); null leaves it IDLE awaiting an explicit mission_start.
      if (cfg.autoStartMission) kernel.startMission(st, cfg.autoStartMission);
      log.info(0, "BOOT", { rev: BUILD.rev, time: BUILD.time, mission: kernel.activeMission() });
      return st;
    },
    tick: (st: BotState): BotState => kernel.tick(st),
    command: (st: BotState, cmd: { type: string; [k: string]: unknown }): BotState =>
      kernel.command(st, cmd),
    // jsMacros impurity boundary for chat: worker.js hands us the raw RecvMessage event, whose
    // `text` is a TextHelper (and which also fires for system/server lines). chatTextOf flattens
    // it — stripping § colour codes — HERE, so no capability, and no pure parser, ever sees a
    // Java object or a formatting escape.
    onChat: (
      st: BotState,
      ev: { text?: { getStringStripFormatting(): string } | null },
    ): BotState => kernel.dispatchChat(st, { text: chatTextOf(ev) }),
    // Outcome of the last command() — worker.js writes it to the worker.resp GlobalVar
    // keyed by the command id, so the bridge returns a REAL ack (not "dispatched").
    lastResult: (): CommandOutcome | null => kernel.lastCommandOutcome(),
    // Drained by worker.js after each tick → IPC.ringAppend into the GlobalVars event
    // ring (the bundle stays facade-only; the Service owns the cross-process write).
    drainEvents: (): RingEvent[] => events.drain(),
    // Build provenance (git rev + ISO time) — worker.js publishes this to the build
    // GlobalVar so `get_state` can report exactly which bundle is loaded.
    build: (): { rev: string; time: string } => BUILD,
    // The container calls this after load to learn the bundle's live command set,
    // so the `describe` manifest (and mc://api) reflects the running bundle without
    // editing main.js. Keyed by command name, shape matches main's COMMANDS.
    describe(): Record<string, { where: string; desc: string; params: unknown[] }> {
      const out: Record<string, { where: string; desc: string; params: unknown[] }> = {};
      for (const name of kernel.commandNames()) {
        const doc = WORKER_COMMAND_DOCS[name];
        out[name] = { where: "worker", desc: doc?.desc ?? "", params: doc?.params ?? [] };
      }
      return out;
    },
    stop: (st: BotState): void => {
      st.running = false;
      // Declarative teardown: drains every ctx.onStop disposer (core releases keys, stops
      // Baritone, clears the HUD). New context-pinning resources register their own.
      kernel.dispose();
    },
  };
}

// Expose on the global scope so the worker.js eval contract (`typeof Module`)
// resolves it as a bare identifier.
// reliability-ok: the eval-load contract publishes Module on globalThis — this is the
// one bundle↔Service handoff point, typed as broadly as the global it writes.
(globalThis as { Module?: unknown }).Module = makeModule();
