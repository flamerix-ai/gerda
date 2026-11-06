import { core } from "@/bot/capabilities/core";
import { mineMission } from "@/bot/missions/mine";
import { type MiningMem, setNavOverride } from "@/bot/missions/mine/mining-mem";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { encodePos, sameCell } from "@/core/prim/pos";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import type { Vec3 } from "@/core/runtime/types";
import type { ConfigOverrides } from "@/shared/config/schema";
import { isExposed, makeSpiralOffsets, makeVeinOffsets } from "@/shared/domain/scan";
import { Bus } from "@/shared/kernel/bus";
import {
  type BotState,
  type Capability,
  Kernel,
  makeInitialState,
} from "@/shared/kernel/capability";
import { type LogSink, Logger } from "@/shared/kernel/logger";
import {
  navGreedyCalledOn,
  navRouteSnapshot,
  navStepIsStationaryWork,
  resetGreedyNav,
} from "@/shared/nav";
import { beginGreedyCall, step } from "@/shared/nav/route";
import { reflexes } from "@/shared/reflexes";
import { describe, expect, it } from "vitest";
import { makeBot } from "./harness";

const sink: LogSink = { emit: () => {} };

// The mining loop is now a MISSION: register the global reflexes + lifecycle, load
// the mine mission, and activate it — startMission seeds SCAN + running.
function fullBot(): { rt: MockRuntime; kernel: Kernel; st: BotState } {
  const rt = createMockRuntime();
  const kernel = new Kernel(
    rt,
    new Logger(sink, "ERR"),
    new Bus(),
    makeGerdaConfig(),
    GERDA_PHASES,
  );
  kernel.register(core);
  for (const r of reflexes) kernel.register(r);
  kernel.registerMission(mineMission);
  const st = makeInitialState();
  kernel.init(st);
  kernel.startMission(st, "mine");
  return { rt, kernel, st };
}

describe("scan domain", () => {
  it("spiral starts at the origin and grows outward", () => {
    const o = makeSpiralOffsets(2, 0);
    // first cell is the origin (note: dz may be -0, which === 0)
    expect(o[0]?.dx === 0 && o[0]?.dy === 0 && o[0]?.dz === 0).toBe(true);
    expect(o.length).toBe(25); // (2*2+1)^2
  });
  it("vein cube has (2r+1)^3 cells", () => {
    expect(makeVeinOffsets(1).length).toBe(27);
  });
  it("exposure: ore surrounded by stone is NOT exposed", () => {
    const solid = () => "minecraft:stone";
    expect(isExposed(solid, 0, 0, 0)).toBe(false);
  });
  it("exposure: any air neighbour exposes it", () => {
    const oneAir = (x: number, y: number, z: number) =>
      x === 1 && y === 0 && z === 0 ? "minecraft:air" : "minecraft:stone";
    expect(isExposed(oneAir, 0, 0, 0)).toBe(true);
  });
});

describe("full mining loop on the mock", () => {
  it("scans → goes to → mines an ore, leaving it as air", () => {
    const { rt, kernel, st } = fullBot();
    // Ore at (2,64,0); unset cells read as air, so it is trivially exposed.
    rt.setBlock(2, 64, 0, "gtceu:iron_ore");

    const phases = new Set<string>();
    let movedToStand = false;
    for (let i = 0; i < 40; i++) {
      kernel.tick(st);
      phases.add(st.phase);
      const mem = st.bb["mining"] as MiningMem | undefined;
      if (st.phase === "GOTO" && mem?.standPos && !movedToStand) {
        rt.setPos(mem.standPos); // simulate Baritone walking us to the stand pos
        movedToStand = true;
      }
      if (st.phase === "MINE") rt.flushBreak(); // resolve the async break
    }

    expect(phases.has("SCAN")).toBe(true);
    expect(phases.has("GOTO")).toBe(true);
    expect(phases.has("MINE")).toBe(true);
    expect(rt.state.blocks.get(encodePos(2, 64, 0))).toBe("minecraft:air");
  });

  it("opts into the resilient 'skip' policy — a walled vein cell re-SCANs, never ERRORs the run", () => {
    // Regression: the mine mission used to inherit onBlocked='error', so when a dense ore patch
    // walled off the side-stand solveMiningTarget picks, greedy blocked_no_path → ERROR → the whole
    // plan failed (this killed the sustain loop on a solid ore patch). Surface mining now skips the
    // unreachable cell + re-SCANs for a reachable one. Lock the policy so it can't silently revert.
    const { st } = fullBot();
    const mem = st.bb["mining"] as MiningMem | undefined;
    expect(mem?.onBlocked).toBe("skip");
  });

  it("with no ore nearby, eventually pauses after max scan cycles", () => {
    const { kernel, st } = fullBot();
    for (let i = 0; i < 5000; i++) {
      kernel.tick(st);
      if (st.phase === "PAUSED") break;
    }
    expect(st.phase).toBe("PAUSED");
  });

  // A BATCH run (count>0, e.g. the sustain loop's `mine count:N`) must NOT park at PAUSED when the
  // area is mined out — it must SELF-COMPLETE so the orchestrator advances to prospect a new vein.
  // (PAUSED is a universal target the kernel won't collapse via isDone, so exhaustion stays in SCAN.)
  it("a batch run self-completes (not PAUSED) when the area is mined out, flagging exhausted", () => {
    const rt = createMockRuntime();
    // Tiny scan so exhaustion is a handful of ticks, not thousands.
    const kernel = new Kernel(
      rt,
      new Logger(sink, "ERR"),
      new Bus(),
      makeGerdaConfig({ scan: { radius: 1, maxCycles: 2 } }),
      GERDA_PHASES,
    );
    kernel.register(core);
    for (const r of reflexes) kernel.register(r);
    kernel.registerMission(mineMission);
    const st = makeInitialState();
    kernel.init(st);
    kernel.startMission(st, "mine", { count: 5 }); // batch goal, but no ore exists

    let exhaustedSeen = false;
    for (let i = 0; i < 500; i++) {
      kernel.tick(st);
      const mem = st.bb["mining"] as MiningMem | undefined;
      if (mem?.exhausted) exhaustedSeen = true;
      if (kernel.activeMission() === null) break; // mission collapsed (self-completed)
    }
    expect(exhaustedSeen).toBe(true);
    expect(kernel.activeMission()).toBeNull(); // completed, not parked
    expect(st.phase).not.toBe("PAUSED");
  });
});

// LE2 — the mine GOTO progress-watchdog (goto-approach, universal progress contract). Live: lap 1 sat 11.7 s in
// `SCAN→GOTO ore` — greedy kept answering "moving", the bot never got closer, no arrival, no error.
// The mock has no physics, so a frozen setPos IS the "moving but not advancing" wedge. Progress is
// measured ALONG the route greedy follows (navRouteProgress), not as distance to the stand pos.
describe("mine GOTO progress-watchdog (skip a stalled ore target)", () => {
  const ORE = { x: 8, y: 64, z: 0 };
  const budget = makeGerdaConfig().nav.gotoStallTicks;
  const stalled = (logs: string[]) => logs.some((l) => l.includes("NAV_GOTO_STALL"));
  // Both route engines measure route progress their own way: the default A* route cache, and D* Lite
  // (engaged only without mine moves).
  const ENGINES: readonly (readonly [string, ConfigOverrides])[] = [
    ["A* route cache", {}],
    ["D* Lite", { nav: { dStar: true, mine: false } }],
  ];
  // D* before convergence: a 1-pop budget per re-root holds the searcher in its anytime (one-step
  // reactive) mode — the fixture axis the default 256-pop budget never reaches (the default-budget
  // "D* Lite" shuffle row converges on its first tick and stays converged — asserted by
  // expectConvergedThroughout). Each fixture using it asserts it never converged.
  const DSTAR_ANYTIME: ConfigOverrides = { nav: { dStar: true, mine: false, dStarStepPops: 1 } };
  // Third column: the row claims the D* searcher stays pre-convergence for the whole leg (asserted).
  // Shuffling in place on the 1-wide lane, the 1-pop searcher converges after ~23 ticks (measured),
  // so that row shuffles on a floor PLANE instead, whose search space outlasts the budget.
  const ANYTIME_PLANE_DEPTH = 4;
  const SHUFFLE_ENGINES: readonly (readonly [string, ConfigOverrides, boolean])[] = [
    ...ENGINES.map(([name, cfg]) => [name, cfg, false] as const),
    ["D* anytime, pre-convergence", DSTAR_ANYTIME, true],
  ];
  // Per-tick D* convergence while the leg is still in GOTO (the stall tick itself may reset nav):
  // a pre-convergence fixture must have a searcher on every sampled tick and never report converged.
  function convergenceSamples(): { samples: (boolean | null)[]; take: () => void } {
    const samples: (boolean | null)[] = [];
    return { samples, take: () => samples.push(navRouteSnapshot().dstarConverged) };
  }
  function expectNeverConverged(samples: readonly (boolean | null)[]): void {
    expect(samples.length).toBeGreaterThan(budget); // sampled across the whole budget
    expect(samples).not.toContain(null); // a D* searcher was live on every sampled tick
    expect(samples).not.toContain(true); // …and it never converged: the anytime path was exercised
  }
  // The foil: without it `dstarConverged` could be stuck at false and expectNeverConverged would hold
  // vacuously. The default-budget searcher reports converged on EVERY sampled tick, the first included.
  function expectConvergedThroughout(samples: readonly (boolean | null)[]): void {
    expect(samples.length).toBeGreaterThan(budget);
    expect(samples.every((c) => c === true)).toBe(true);
  }
  // A slow walker: one cell per 80% of the budget — ~16× slower than a plain walk (~5 t/cell).
  const SLOW = Math.floor(budget * 0.8);
  function gotoOre(
    config: ConfigOverrides = {},
    wall = false,
    caps: readonly Capability[] = [],
    depth = 0, // floor rows z ∈ [-depth, 0]: 0 = the single z=0 lane, >0 = a plane to wander on
  ): { bot: ReturnType<typeof makeBot>; logs: string[] } {
    resetGreedyNav();
    const logs: string[] = [];
    const bot = makeBot({
      missions: [mineMission],
      withReflexes: false,
      caps,
      config,
      sink: { emit: (l) => logs.push(l) },
      logLevel: "WARN",
    });
    for (let x = -2; x <= 32; x++)
      for (let z = -depth; z <= 0; z++) bot.rt.setBlock(x, 63, z, "minecraft:stone"); // floor
    if (wall) for (const y of [64, 65]) bot.rt.setBlock(1, y, 0, "minecraft:stone"); // mine through
    bot.rt.setBlock(ORE.x, ORE.y, ORE.z, "gtceu:iron_ore");
    bot.rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    bot.kernel.startMission(bot.st, "mine");
    for (let i = 0; i < 20 && bot.st.phase !== "GOTO"; i++) bot.kernel.tick(bot.st);
    expect(bot.st.phase).toBe("GOTO");
    return { bot, logs };
  }

  it("a GOTO that never gets closer → NAV_GOTO_STALL, target cached, back to SCAN (never ERROR)", () => {
    const { bot, logs } = gotoOre();
    const phases: string[] = [];
    for (let i = 0; i < budget + 3 && bot.st.phase === "GOTO"; i++) {
      bot.kernel.tick(bot.st); // pos frozen: greedy says "moving", the route never advances
      phases.push(bot.st.phase);
    }
    expect(bot.st.phase).toBe("SCAN");
    expect(phases.length).toBeGreaterThan(budget); // held the full budget — not an early block-skip
    expect(phases).not.toContain("ERROR");
    expect(stalled(logs)).toBe(true);
    const mem = bot.st.bb["mining"] as MiningMem;
    expect(mem.veinMined.has(encodePos(ORE.x, ORE.y, ORE.z))).toBe(true); // skipped, never re-picked
    expect(bot.rt.state.keys["key.forward"]).toBe(false); // greedy's held keys released on the skip
  });

  it("drill-style onBlocked 'dig' is exempt — a frozen GOTO past the budget stays GOTO, no stall", () => {
    const { bot, logs } = gotoOre();
    (bot.st.bb["mining"] as MiningMem).onBlocked = "dig";
    for (let i = 0; i < budget * 2; i++) bot.kernel.tick(bot.st);
    expect(bot.st.phase).toBe("GOTO"); // budget*2 < cfg.nav.gotoTimeoutTicks
    expect(stalled(logs)).toBe(false);
  });

  it("the exempt 'dig' GOTO still carries the feet backstop → PAUSED past safety.phaseStallTicks", () => {
    const { bot, logs } = gotoOre({ nav: { gotoTimeoutTicks: 100_000 } });
    (bot.st.bb["mining"] as MiningMem).onBlocked = "dig";
    const feet = makeGerdaConfig().safety.phaseStallTicks;
    for (let i = 0; i < feet + 5 && bot.st.phase === "GOTO"; i++) bot.kernel.tick(bot.st);
    expect(bot.st.phase).toBe("PAUSED");
    expect(logs.some((l) => l.includes("PHASE_STALLED") && l.includes('"feet"'))).toBe(true);
    expect(stalled(logs)).toBe(false);
  });

  it("known-good: a slow column leg (Y-free goal far overhead) advancing its route never stalls", () => {
    resetGreedyNav();
    const logs: string[] = [];
    const bot = makeBot({
      missions: [mineMission],
      withReflexes: false,
      sink: { emit: (l) => logs.push(l) },
      logLevel: "WARN",
    });
    for (let x = -2; x <= 32; x++) bot.rt.setBlock(x, 63, 0, "minecraft:stone");
    bot.kernel.startMission(bot.st, "mine"); // onBlocked "skip"; no ore → the waypoint leg only
    setNavOverride(bot.st.bb["mining"] as MiningMem, { x: 30, y: 1000, z: 0 }, "SCAN", "xz");
    bot.st.phase = "GOTO"; // enter the column leg fresh (as goto_waypoint does)
    bot.st.phaseTicks = 0;
    let x = 0.5;
    for (let i = 0; i < budget * 3 && bot.st.phase === "GOTO"; i++) {
      if (i > 0 && i % SLOW === 0) x += 1; // one route cell per SLOW ticks
      bot.rt.setPos({ x, y: 64, z: 0.5 });
      bot.kernel.tick(bot.st);
    }
    expect(bot.st.phase).toBe("GOTO");
    expect(stalled(logs)).toBe(false);
  });

  it("an in-flight pillar ascent during GOTO is exempt on every tick, incl. the continuation ticks", () => {
    resetGreedyNav();
    const logs: string[] = [];
    const bot = makeBot({
      missions: [mineMission],
      withReflexes: false,
      // The pillar machine's OWN cycle timeout would give up on the frozen ascent first; park it so
      // this isolates the watchdog's exemption (the kernel drives the mock clock).
      config: { nav: { pillarCycleTimeoutTicks: 100_000 } },
      sink: { emit: (l) => logs.push(l) },
      logLevel: "WARN",
    });
    bot.rt.setBlock(0, 63, 0, "minecraft:stone");
    bot.rt.state.slots.set(36, { id: "minecraft:cobblestone", count: 64, durabilityPct: 100 });
    bot.rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    bot.kernel.startMission(bot.st, "mine");
    const mem = bot.st.bb["mining"] as MiningMem;
    mem.standPos = { x: 0, y: 68, z: 0 }; // straight up → greedy pillars in place
    mem.target = { x: 0, y: 69, z: 0, id: "gtceu:iron_ore" };
    mem.face = "BOTTOM";
    bot.st.phase = "GOTO";
    bot.st.phaseTicks = 0;
    let sawPillar = false;
    for (let i = 0; i < budget * 2 && bot.st.phase === "GOTO"; i++) {
      bot.kernel.tick(bot.st); // feet frozen: the ascent never completes
      if (navRouteSnapshot().lastStep.branch === "pillar") sawPillar = true;
    }
    expect(sawPillar).toBe(true);
    expect(bot.st.phase).toBe("GOTO"); // held the whole run — not an early pillar give-up
    expect(stalled(logs)).toBe(false);
  });

  it("stationary-work freshness: a branch left by an EARLIER greedy call never exempts a later one", () => {
    const cell = { x: 0, y: 64, z: 0 };
    beginGreedyCall(7);
    step("mine", cell, cell, "moving");
    expect(navStepIsStationaryWork(7)).toBe(true);
    expect(navStepIsStationaryWork(8)).toBe(false); // tick 8 ran no greedy call at all
    beginGreedyCall(7); // a second call the same tick returns via a no-step path (airborne hold)
    expect(navStepIsStationaryWork(7)).toBe(false);
  });

  it("a guard-owned GOTO stretch (greedy never ran) is paused; the clock resumes once greedy does", () => {
    // A guard that short-circuits GOTO without a divert (swim-out's hold-jump) runs no greedyStep, so
    // route progress cannot move: that stretch is the guard's to time (cfg.safety.swimOutMaxTicks, air reflex,
    // feet backstop, cfg.nav.gotoTimeoutTicks), not the watchdog's — a REACHABLE ore must not be skipped.
    let holding = false;
    const hold: Capability = { name: "hold-guard", guard: () => holding };
    const { bot, logs } = gotoOre({ nav: { mineBreakTimeoutTicks: budget * 3 } }, true, [hold]);
    for (let i = 0; i < 5; i++) bot.kernel.tick(bot.st);
    expect(navRouteSnapshot().lastStep.branch).toBe("mine"); // greedy is mid-break when the hold starts
    holding = true;
    let guardOwned = 0;
    for (let i = 0; i < budget * 2 && bot.st.phase === "GOTO"; i++) {
      bot.kernel.tick(bot.st);
      if (!navGreedyCalledOn(bot.rt.tick())) guardOwned++;
    }
    expect(guardOwned).toBe(budget * 2); // the guard really owned every tick
    expect(bot.st.phase).toBe("GOTO"); // held past the budget: no skip while the guard owns the leg
    expect(stalled(logs)).toBe(false);
    // The guard ends and the wall is gone (the interrupted break lands), so greedy now WALKS — not
    // in-place work — with the feet frozen. The stale "mine" branch from before the hold must not
    // exempt it: the clock — last reset by the in-place break, then paused through the hold — runs
    // out one budget after the release.
    holding = false;
    for (const y of [64, 65]) bot.rt.setBlock(1, y, 0, "minecraft:air");
    bot.rt.flushBreak();
    const released = bot.st.tickCount;
    let walked = false;
    for (let i = 0; i < budget + 3 && bot.st.phase === "GOTO"; i++) {
      bot.kernel.tick(bot.st);
      if (navRouteSnapshot().lastStep.branch === "walk") walked = true;
    }
    expect(walked).toBe(true);
    expect(stalled(logs)).toBe(true);
    expect(bot.st.phase).toBe("SCAN");
    expect(bot.st.tickCount - released).toBeGreaterThan(budget); // the clock restarted at the release
  });

  // How often a guard owns a GOTO tick varies live (swim-out bobbing, a flickering reflex): the rate,
  // a burst shape, and a phase offset are all axes the known-bad below sweeps.
  const GUARD_PATTERNS: readonly (readonly [string, (i: number) => boolean])[] = [
    ["every other tick", (i) => i % 2 === 1],
    ["1 tick in 3", (i) => i % 3 === 0],
    ["1 tick in 10", (i) => i % 10 === 0],
    ["bursts of 5 in every 25", (i) => i % 25 < 5],
    ["1 tick in 37, phase-shifted", (i) => (i + 11) % 37 === 0],
  ];

  it.each(GUARD_PATTERNS)(
    "known-bad: a guard owning %s between frozen greedy ticks → still stalls (a pause never re-arms)",
    (_pattern, owns) => {
      let holding = false;
      const hold: Capability = { name: "hold-guard", guard: () => holding };
      const { bot, logs } = gotoOre({}, false, [hold]);
      const timeout = makeGerdaConfig().nav.gotoTimeoutTicks;
      let guardTicks = 0;
      let greedyTicks = 0;
      let ticks = 0;
      let stallTickGuarded = false;
      for (; ticks < timeout && bot.st.phase === "GOTO"; ticks++) {
        holding = owns(ticks);
        bot.kernel.tick(bot.st); // feet frozen: greedy walks on its ticks, the route never advances
        const greedyRan = navGreedyCalledOn(bot.rt.tick());
        expect(greedyRan).toBe(!holding); // the pattern really decides who owns each tick
        if (greedyRan) greedyTicks++;
        else guardTicks++;
        if (bot.st.phase !== "GOTO") stallTickGuarded = holding;
      }
      expect(guardTicks).toBeGreaterThan(0);
      expect(stalled(logs)).toBe(true); // the watchdog skipped it — NOT the cfg.nav.gotoTimeoutTicks leg timeout
      expect(bot.st.phase).toBe("SCAN");
      expect(stallTickGuarded).toBe(false); // a paused tick never fires the stall
      expect(greedyTicks).toBeGreaterThan(budget); // not before a full budget of COUNTED ticks…
      expect(greedyTicks).toBeLessThanOrEqual(budget + 2); // …and promptly once they add up
      expect(ticks).toBeLessThanOrEqual(budget + guardTicks + 2);
    },
  );

  it("known-bad: greedy runs EVERY tick yet makes no route progress → still stalls", () => {
    const { bot, logs } = gotoOre();
    let ran = 0;
    let ticks = 0;
    for (; ticks < budget + 3 && bot.st.phase === "GOTO"; ticks++) {
      bot.kernel.tick(bot.st); // feet frozen
      if (navGreedyCalledOn(bot.rt.tick())) ran++;
    }
    expect(ran).toBeGreaterThanOrEqual(ticks - 1); // greedy ran on (all but at most the stall) tick
    expect(stalled(logs)).toBe(true);
    expect(bot.st.phase).toBe("SCAN");
  });

  it("a long in-place break during GOTO (greedy 'mine' step) is exempt — no stall while it digs", () => {
    // One break outlasting the whole stall budget (the live worst case is 3 cells × aim+break).
    const { bot, logs } = gotoOre({ nav: { mineBreakTimeoutTicks: budget * 3 } }, true);
    let sawMine = false;
    for (let i = 0; i < budget * 2 && bot.st.phase === "GOTO"; i++) {
      bot.kernel.tick(bot.st); // never flushBreak: the break stays in flight, feet frozen
      if (navRouteSnapshot().lastStep.branch === "mine") sawMine = true;
    }
    expect(sawMine).toBe(true); // the fixture really drives the in-place mine branch
    expect(bot.st.phase).toBe("GOTO");
    expect(stalled(logs)).toBe(false);
  });

  it.each(SHUFFLE_ENGINES)(
    "shuffling in place (%s) still stalls — only a NEW furthest route cell counts",
    (_e, config, anytime) => {
      const { bot, logs } = gotoOre(config, false, [], anytime ? ANYTIME_PLANE_DEPTH : 0);
      const conv = convergenceSamples();
      for (let i = 0; i < budget + 3 && bot.st.phase === "GOTO"; i++) {
        bot.rt.setPos({ x: i % 2 === 0 ? 0.5 : 1.0, y: 64, z: 0.5 }); // jitter between route cells 0 ↔ 1
        bot.kernel.tick(bot.st);
        if (bot.st.phase === "GOTO") conv.take();
      }
      expect(bot.st.phase).toBe("SCAN");
      expect(stalled(logs)).toBe(true);
      if (anytime) expectNeverConverged(conv.samples);
      else if (config.nav?.dStar) expectConvergedThroughout(conv.samples);
    },
  );

  // A physics stand-in for the mock: every `ticksPerCell` ticks, put the feet on the cell `move`
  // picks (null = stay). Returns the cells stepped onto.
  function drive(
    bot: ReturnType<typeof makeBot>,
    ticks: number,
    ticksPerCell: number,
    move: () => Vec3 | null,
  ): Vec3[] {
    const walked: Vec3[] = [];
    for (let i = 0; i < ticks && bot.st.phase === "GOTO"; i++) {
      bot.kernel.tick(bot.st);
      const cell = i % ticksPerCell === ticksPerCell - 1 ? move() : null;
      if (cell) {
        bot.rt.setPos({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 });
        walked.push(cell);
      }
    }
    return walked;
  }

  // Walk the plan: step onto the cell greedy drove toward THIS tick; once the route is consumed and
  // greedy micro-walks the last sub-cell (no fresh step), step onto `settle`.
  function walkRoute(
    bot: ReturnType<typeof makeBot>,
    ticks: number,
    ticksPerCell: number,
    settle: Vec3,
  ): Vec3[] {
    return drive(bot, ticks, ticksPerCell, () => {
      const { next, feet } = navRouteSnapshot().lastStep;
      const at = bot.rt.state.pos;
      const fresh = feet && feet.x === Math.floor(at.x) && feet.z === Math.floor(at.z);
      return fresh && next ? next : settle;
    });
  }

  // The stand pos sits across a floorless 5-wide ravine (no drop landing, too wide to parkour, no
  // filler to bridge), so the only route is a U around its east end: out +x, across, back −x. For
  // ~27 of its ~32 cells the bot is FARTHER from the stand than at the start — a straight-line
  // approach measure reads that as "never closer".
  function ravineBot(config: ConfigOverrides): { bot: ReturnType<typeof makeBot>; logs: string[] } {
    resetGreedyNav();
    const logs: string[] = [];
    const bot = makeBot({
      missions: [mineMission],
      withReflexes: false,
      config,
      sink: { emit: (l) => logs.push(l) },
      logLevel: "WARN",
    });
    for (let x = -1; x <= 13; x++) {
      bot.rt.setBlock(x, 63, 0, "minecraft:stone"); // near rim
      bot.rt.setBlock(x, 63, 6, "minecraft:stone"); // far rim
    }
    for (let z = 1; z <= 5; z++) bot.rt.setBlock(13, 63, z, "minecraft:stone"); // the way round
    bot.rt.setBlock(0, 63, 7, "minecraft:stone");
    bot.rt.setBlock(0, 64, 7, "gtceu:iron_ore");
    bot.rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    bot.kernel.startMission(bot.st, "mine");
    const mem = bot.st.bb["mining"] as MiningMem;
    mem.standPos = { x: 0, y: 64, z: 6 };
    mem.target = { x: 0, y: 64, z: 7, id: "gtceu:iron_ore" };
    mem.face = "NORTH";
    bot.st.phase = "GOTO";
    bot.st.phaseTicks = 0;
    return { bot, logs };
  }

  it.each(ENGINES)(
    "known-good (%s): a route that must lead AWAY first (U round a ravine) reaches the stand, no stall",
    (_engine, config) => {
      const { bot, logs } = ravineBot(config);
      const walked = walkRoute(bot, 400, 5, { x: 0, y: 64, z: 6 }); // 4 cells/s: a plain walk
      expect(Math.max(...walked.map((c) => c.x))).toBe(13); // the fixture really walks the way round
      expect(stalled(logs)).toBe(false);
      expect(bot.st.phase).toBe("MINE"); // arrived at the stand pos across the ravine
      const mem = bot.st.bb["mining"] as MiningMem;
      expect(mem.veinMined.has(encodePos(0, 64, 7))).toBe(false); // the reachable ore was never skipped
    },
  );

  it("known-bad: walking through NEW cells off the route (never along the plan) still stalls", () => {
    // Feet change every step and never revisit a cell, but each step leaves the route greedy planned
    // (sideways off the lane toward the ore): a "moved to a new cell" measure would never fire.
    const { bot, logs } = gotoOre({}, false, [], 60);
    let z = 0;
    const walked = drive(bot, budget * 3, 5, () => ({ x: 0, y: 64, z: --z }));
    expect(new Set(walked.map((c) => c.z)).size).toBe(walked.length); // every step a NEW cell
    expect(stalled(logs)).toBe(true);
    expect(walked.length).toBeLessThan(Math.ceil(budget / 5) + 3); // fired at the budget
  });

  it("known-good: a far column leg walked across horizon extend-replans never stalls", () => {
    // Past nav.horizonBlocks the route is planned in partial segments: each extend-replan starts a
    // FRESH route at the feet, whose progress must count from there (not from the old high-water).
    resetGreedyNav();
    const logs: string[] = [];
    const bot = makeBot({
      missions: [mineMission],
      withReflexes: false,
      sink: { emit: (l) => logs.push(l) },
      logLevel: "WARN",
    });
    for (let x = -2; x <= 62; x++) bot.rt.setBlock(x, 63, 0, "minecraft:stone");
    bot.rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    bot.kernel.startMission(bot.st, "mine"); // no ore → the waypoint leg only
    const far = { x: 55, y: 64, z: 0 };
    expect(far.x).toBeGreaterThan(2 * makeGerdaConfig().nav.horizonBlocks); // ≥ 2 segments
    setNavOverride(bot.st.bb["mining"] as MiningMem, far, "SCAN", "xz");
    bot.st.phase = "GOTO";
    bot.st.phaseTicks = 0;
    const plansBefore = navRouteSnapshot().plans;
    const walked = walkRoute(bot, 400, 5, far);
    expect(navRouteSnapshot().plans - plansBefore).toBeGreaterThan(1); // really replanned mid-leg
    expect(walked.length).toBeGreaterThan(50);
    expect(stalled(logs)).toBe(false);
    expect(bot.st.phase).toBe("SCAN"); // arrived: the column leg hands back to its arrival phase
  });

  it("known-good: a slow-but-progressing GOTO is NOT skipped", () => {
    const { bot, logs } = gotoOre();
    // One route cell every SLOW ticks: far slower than a walk, yet each is a new furthest route cell.
    let x = 0.5;
    for (let i = 0; i < budget * 3 && bot.st.phase === "GOTO"; i++) {
      if (i > 0 && i % SLOW === 0) x += 1;
      bot.rt.setPos({ x, y: 64, z: 0.5 });
      bot.kernel.tick(bot.st);
    }
    expect(bot.st.phase).toBe("GOTO"); // still walking: no skip, no timeout (budget*3 < gotoTimeout)
    expect(stalled(logs)).toBe(false);
    const mem = bot.st.bb["mining"] as MiningMem;
    expect(mem.veinMined.has(encodePos(ORE.x, ORE.y, ORE.z))).toBe(false);
  });

  it("known-good: a slow walk with D* still pre-convergence (anytime steps) is NOT skipped", () => {
    // Each re-root expands one vertex, so the searcher never converges on this leg and every step is
    // an anytime cell: each NEW one stood on must still count as progress (once).
    const { bot, logs } = gotoOre(DSTAR_ANYTIME);
    const conv = convergenceSamples();
    let x = 0.5;
    for (let i = 0; i < budget * 3 && bot.st.phase === "GOTO"; i++) {
      if (i > 0 && i % SLOW === 0) x += 1; // one cell toward the ore every SLOW ticks
      bot.rt.setPos({ x, y: 64, z: 0.5 });
      bot.kernel.tick(bot.st);
      if (bot.st.phase === "GOTO") conv.take();
    }
    expect(x).toBeGreaterThan(3); // the fixture really walked cells well past the budget
    expect(bot.st.phase).toBe("GOTO");
    expect(stalled(logs)).toBe(false);
    expectNeverConverged(conv.samples);
  });

  it("known-good: drifting one cell sideways every few cells (each drift a replan) never stalls", () => {
    // Real feet drift off the planned line; each drift forces a replan from the drifted cell, which
    // re-baselines the A* high-water. Progress along each fresh route must still count from there.
    resetGreedyNav();
    const logs: string[] = [];
    const bot = makeBot({
      missions: [mineMission],
      withReflexes: false,
      sink: { emit: (l) => logs.push(l) },
      logLevel: "WARN",
    });
    for (let x = -2; x <= 40; x++)
      for (let z = -8; z <= 0; z++) bot.rt.setBlock(x, 63, z, "minecraft:stone");
    bot.rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    bot.kernel.startMission(bot.st, "mine"); // no ore → the waypoint leg only
    const far = { x: 36, y: 64, z: 0 };
    setNavOverride(bot.st.bb["mining"] as MiningMem, far, "SCAN", "xz");
    bot.st.phase = "GOTO";
    bot.st.phaseTicks = 0;
    const EVERY = 4; // route cells between drifts
    const PACE = 25; // ticks per cell: (EVERY + 1) * PACE > budget, so a lost credit shows
    expect((EVERY + 1) * PACE).toBeGreaterThan(budget);
    let steps = 0;
    let drifts = 0;
    const plansBefore = navRouteSnapshot().plans;
    const walked = drive(bot, 380, PACE, () => {
      const at = bot.rt.state.pos;
      const feet = { x: Math.floor(at.x), y: 64, z: Math.floor(at.z) };
      if (++steps % (EVERY + 1) === 0) {
        drifts++;
        return { ...feet, z: feet.z - 1 }; // sideways, off the planned line
      }
      const { next, feet: from } = navRouteSnapshot().lastStep;
      return next && from && sameCell(from, feet) ? next : null;
    });
    expect(drifts).toBeGreaterThanOrEqual(2);
    expect(navRouteSnapshot().plans - plansBefore).toBeGreaterThan(drifts); // each drift replanned
    expect(Math.max(...walked.map((c) => c.x))).toBeGreaterThan(8); // still approaching
    expect(stalled(logs)).toBe(false);
    expect(bot.st.phase).toBe("GOTO"); // 380 < cfg.nav.gotoTimeoutTicks
  });
});
