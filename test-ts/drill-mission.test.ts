import { drillMission } from "@/bot/missions/drill";
import type { MiningMem } from "@/bot/missions/mine/mining-mem";
// drill mission — prospect→drill-down→mine, end-to-end on the mock. Covers init (pick the
// nearest cached vein, aim navigation at its X/Z), the no-cached-vein fail-loud guard, and a
// full GOTO→DESCEND→handoff: the bot stands over the vein's X/Z, digs a 1-wide shaft down
// (real breaks), and hands off to MINE/GOTO once the shaft exposes the ore. Gravity (the
// 1-block drop after each floor break) is simulated, since the mock has no physics.
import { makeGerdaConfig } from "@/bot/profile/config";
import { encodePos } from "@/core/prim/pos";
import type { MockRuntime } from "@/core/runtime/mock";
import { resetGreedyNav } from "@/shared/nav";
import { describe, expect, it } from "vitest";
import { makeBot } from "./harness";

interface SeedMarker {
  kind: string;
  x: number;
  z: number;
}

function seedVeins(rt: MockRuntime, resources: SeedMarker[]): void {
  const sig = rt.state.worldSig;
  const model = {
    version: 1,
    worlds: {
      [sig]: {
        waypoints: [],
        resources,
        stats: { dumps: 0, veinsFound: 0, boots: 0 },
        updatedAt: 0,
      },
    },
  };
  rt.fs.write(makeGerdaConfig().worldModelPath, JSON.stringify(model));
}

const air = (rt: MockRuntime, x: number, y: number, z: number): boolean =>
  rt.state.blocks.get(encodePos(x, y, z)) === "minecraft:air";

// Run the bot until it leaves DESCEND (the vein handoff) or the budget runs out, simulating
// the mock's missing physics: resolve each issued floor break, then drop the bot one block
// when the cell under its feet has opened to air. Returns whether DESCEND was ever entered.
function driveDescent(bot: ReturnType<typeof makeBot>, maxTicks: number): boolean {
  const { rt, kernel, st } = bot;
  let entered = false;
  for (let i = 0; i < maxTicks; i++) {
    kernel.tick(st);
    if (st.phase === "DESCEND") entered = true;
    rt.flushBreak();
    if (st.phase === "DESCEND") {
      const p = rt.state.pos;
      const fy = Math.floor(p.y);
      if (air(rt, Math.floor(p.x), fy - 1, Math.floor(p.z))) {
        rt.setPos({ x: p.x, y: fy - 1, z: p.z });
      }
    }
    if (entered && st.phase !== "DESCEND") break;
  }
  return entered;
}

describe("drill init — vein selection", () => {
  it("aims navigation at the nearest cached vein's X/Z, arriving into DESCEND", () => {
    const bot = makeBot({ missions: [drillMission], config: {} });
    seedVeins(bot.rt, [
      { kind: "iron", x: 20, z: 0 },
      { kind: "iron", x: 5, z: 0 },
    ]);
    bot.kernel.startMission(bot.st, "drill");

    const mem = bot.st.bb["mining"] as MiningMem;
    expect(mem.standPos).toEqual({ x: 5, y: 64, z: 0 });
    expect(mem.arrivalPhase).toBe("DESCEND");
    // "xz" column-approach: the vein is a prospector X/Z with no known surface Y, so greedy
    // arrives on horizontal distance and DESCEND owns the dig-down (a "block" goal would float).
    expect(mem.navMode).toBe("xz");
    const drill = bot.st.bb["drill"] as { noTarget: boolean; vein: unknown };
    expect(drill.noTarget).toBe(false);
    expect(drill.vein).toEqual({ x: 5, y: 64, z: 0 });
  });

  it("honours the ore param when choosing among groups", () => {
    const bot = makeBot({ missions: [drillMission], config: {} });
    seedVeins(bot.rt, [
      { kind: "iron", x: 1, z: 0 }, // closer, but wrong group
      { kind: "gold", x: 9, z: 0 },
    ]);
    bot.kernel.startMission(bot.st, "drill", { ore: "gold" });
    const mem = bot.st.bb["mining"] as MiningMem;
    expect(mem.standPos).toEqual({ x: 9, y: 64, z: 0 });
  });

  it("no cached vein → graceful PAUSE + alert (not ERROR) on the first tick", () => {
    const bot = makeBot({ missions: [drillMission], config: {} });
    // No seedVeins → empty resources → init flags noTarget.
    bot.kernel.startMission(bot.st, "drill");
    expect((bot.st.bb["drill"] as { noTarget: boolean }).noTarget).toBe(true);
    bot.kernel.tick(bot.st);
    expect(bot.st.phase).toBe("PAUSED"); // a dead/empty prospector pauses, it does NOT error
  });

  it("re-targets when the vein cache is refreshed and the bot is resumed", () => {
    const bot = makeBot({ missions: [drillMission], config: {} });
    bot.kernel.startMission(bot.st, "drill", { ore: "gold" });
    bot.kernel.tick(bot.st);
    expect(bot.st.phase).toBe("PAUSED"); // empty cache → paused

    // Host runs `prospect` (refresh markers) + operator resumes → the descend guard re-picks.
    seedVeins(bot.rt, [{ kind: "gold", x: 9, z: 0 }]);
    bot.kernel.command(bot.st, { type: "resume" });
    bot.kernel.tick(bot.st);
    expect(bot.st.phase).not.toBe("PAUSED"); // re-targeted → back on the drill path
    expect((bot.st.bb["drill"] as { noTarget: boolean }).noTarget).toBe(false);
  });
});

describe("drill end-to-end — dig the shaft and reach the vein", () => {
  it("walks over the vein, digs straight down, and hands off the exposed ore", () => {
    const bot = makeBot({ missions: [drillMission], config: {} });
    // Vein directly under the bot (dist 0) → GOTO arrives immediately → DESCEND.
    seedVeins(bot.rt, [{ kind: "iron", x: 0, z: 0 }]);
    bot.kernel.startMission(bot.st, "drill");

    const { rt, st } = bot;
    // Block-centred (x.5, z.5) → a clean single-column footprint shaft at (0,_,0).
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    // A solid stone shaft to chew through (no void veto) with the ore in the shaft a few blocks
    // down; fill past it so the floor under each step reads solid (no void veto).
    for (let y = 63; y >= 55; y--) rt.setBlock(0, y, 0, "minecraft:stone");
    rt.setBlock(0, 58, 0, "minecraft:iron_ore");

    const enteredDescend = driveDescent(bot, 200);

    expect(enteredDescend).toBe(true);
    // The shaft got dug straight down.
    expect(air(rt, 0, 63, 0)).toBe(true);
    expect(air(rt, 0, 62, 0)).toBe(true);
    // Dug down to the ore band → set the mine target on the grazed ore and hand to EXCAVATE, which
    // strip-mines the vein VOLUME and feeds each exposed clump to MINE's vein-follow. The
    // excavation plan is installed and active at the handoff.
    expect(st.phase).toBe("EXCAVATE");
    const mem = st.bb["mining"] as MiningMem;
    expect(mem.target).toMatchObject({ x: 0, y: 58, z: 0, id: "minecraft:iron_ore" });
    const exc = st.bb["excavate"] as {
      active: boolean;
      cells: { x: number; y: number; z: number }[];
    };
    expect(exc.active).toBe(true);
    expect(exc.cells.length).toBeGreaterThan(0);
    // Regression (live drill-gap-vein): the corridor plane anchors at the ORE'S depth
    // (hit.y = 58), NOT the reach-feet Y (59, one ABOVE the ore the bot stood on). Anchoring at feet.y
    // put the top level one above the band, so the instant MINE landed the bot at the true ore level it
    // was stranded ONE BELOW the plane — every remaining corridor cell an up-step over the gap the
    // level-only bridge driver can't cross (PLACE_CELL never fired, whole band skipped). The top
    // corridor level must sit AT the band, never above it.
    expect(Math.max(...exc.cells.map((c) => c.y))).toBe(58);
  });
});

describe("drill EXCAVATE void guard — skip a corridor cell over a pit (the ravine 'jumping' fix)", () => {
  it("advances the cursor past a stand-cell hanging over a void in ONE tick, no path-thrash", () => {
    resetGreedyNav();
    const bot = makeBot({ missions: [drillMission], config: {} });
    seedVeins(bot.rt, [{ kind: "iron", x: 0, z: 0 }]);
    bot.kernel.startMission(bot.st, "drill");
    const { rt, kernel, st } = bot;
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    for (let y = 63; y >= 55; y--) rt.setBlock(0, y, 0, "minecraft:stone");
    rt.setBlock(0, 58, 0, "minecraft:iron_ore");
    expect(driveDescent(bot, 200)).toBe(true);
    expect(st.phase).toBe("EXCAVATE");

    // Stand the bot on solid ground with clear headroom (grounded → the handler runs past its settle
    // guard), feet at the shaft column, away from the void cell so the guard applies.
    rt.setBlock(0, 56, 0, "minecraft:stone");
    rt.setBlock(0, 57, 0, "minecraft:air");
    rt.setBlock(0, 58, 0, "minecraft:air");
    rt.setPos({ x: 0.5, y: 57, z: 0.5 });

    // Point the excavation cursor at a stand-cell 5 columns away hanging over open air (a ravine cut
    // through the vein box): nothing solid below it for cfg.excavate.voidProbe blocks. The next cell is the
    // solid shaft column. Pre-refactor the executor jittered greedy toward the void cell for
    // cfg.drill.digToStallTicks (and drifted the bot into the pit); now it must skip it outright.
    const exc = st.bb["excavate"] as { cells: { x: number; y: number; z: number }[]; idx: number };
    exc.cells = [
      { x: 5, y: 57, z: 0 }, // over the void
      { x: 0, y: 57, z: 0 }, // reachable
    ];
    exc.idx = 0;
    for (let y = 56; y >= 50; y--) rt.setBlock(5, y, 0, "minecraft:air"); // the pit under the void cell

    kernel.tick(st);

    // The void cell was skipped THIS tick (cursor advanced past it), still EXCAVATE, no ERROR — not a
    // cfg.drill.digToStallTicks-long jitter toward unreachable air. (The bag carries NO filler here, so the
    // bridge-across path is closed — this is the no-filler fallback of the void guard.)
    expect(exc.idx).toBe(1);
    expect(st.phase).toBe("EXCAVATE");
  });

  it("with filler in the bag, a void cell is BRIDGED across (kept), not skipped", () => {
    // Mine ACROSS the void (task: ravine-bisected vein): with cfg.nav.bridge + filler the void guard must
    // NOT prune the far-side cell — it falls through to the dig/step path so greedy plans a bridgePlace
    // into the band. The cursor therefore stays on the void cell (working it), instead of advancing.
    resetGreedyNav();
    const bot = makeBot({ missions: [drillMission], config: {} });
    seedVeins(bot.rt, [{ kind: "iron", x: 0, z: 0 }]);
    bot.kernel.startMission(bot.st, "drill");
    const { rt, kernel, st } = bot;
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    for (let y = 63; y >= 55; y--) rt.setBlock(0, y, 0, "minecraft:stone");
    rt.setBlock(0, 58, 0, "minecraft:iron_ore");
    expect(driveDescent(bot, 200)).toBe(true);
    expect(st.phase).toBe("EXCAVATE");

    rt.setBlock(0, 56, 0, "minecraft:stone");
    rt.setBlock(0, 57, 0, "minecraft:air");
    rt.setBlock(0, 58, 0, "minecraft:air");
    rt.setPos({ x: 0.5, y: 57, z: 0.5 });
    // A bag of filler → fillerStatus.enough → the bridge-across gate opens (cfg.nav.bridge is on by default).
    rt.state.slots.set(9, { id: "minecraft:cobblestone", count: 64, durabilityPct: 100 });

    const exc = st.bb["excavate"] as { cells: { x: number; y: number; z: number }[]; idx: number };
    exc.cells = [
      { x: 5, y: 57, z: 0 }, // over the void — but now bridgeable
      { x: 0, y: 57, z: 0 },
    ];
    exc.idx = 0;
    for (let y = 56; y >= 50; y--) rt.setBlock(5, y, 0, "minecraft:air"); // the pit under the void cell

    kernel.tick(st);

    // NOT skipped: the cursor still points at the void cell (the dig/step path is working it — greedy
    // will lay the bridge over the following ticks), and the mission stays healthy.
    expect(exc.idx).toBe(0);
    expect(st.phase).toBe("EXCAVATE");
    expect(st.running).toBe(true);
  });

  it("with filler but NO landfall in bridge range, a void cell is PRUNED in one tick (not thrashed)", () => {
    // The terrain-blind serpentine also emits whole ROWS hanging over open air with no rim in ANY
    // direction (live drill-gap-vein: the z=-4 rows). Filler can't help — greedy has nowhere to land a
    // bridge, so pre-fix it just walked-and-blocked every tick, burning cfg.drill.digToStallTicks apiece and never
    // reaching the reachable far rim. The guard must prune these outright so the cursor advances.
    resetGreedyNav();
    const bot = makeBot({ missions: [drillMission], config: {} });
    seedVeins(bot.rt, [{ kind: "iron", x: 0, z: 0 }]);
    bot.kernel.startMission(bot.st, "drill");
    const { rt, kernel, st } = bot;
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    for (let y = 63; y >= 55; y--) rt.setBlock(0, y, 0, "minecraft:stone");
    rt.setBlock(0, 58, 0, "minecraft:iron_ore");
    expect(driveDescent(bot, 200)).toBe(true);
    expect(st.phase).toBe("EXCAVATE");

    rt.setBlock(0, 56, 0, "minecraft:stone");
    rt.setBlock(0, 57, 0, "minecraft:air");
    rt.setBlock(0, 58, 0, "minecraft:air");
    rt.setPos({ x: 0.5, y: 57, z: 0.5 });
    // Filler IS carried (the bridge gate would open) — but there's no landing to bridge to.
    rt.state.slots.set(9, { id: "minecraft:cobblestone", count: 64, durabilityPct: 100 });

    // Void cell far out of bridgeMaxRun (=6) of the only solid (the shaft column at x=0): no landfall
    // anywhere in the box, so even with filler the guard must prune rather than thrash toward it.
    const exc = st.bb["excavate"] as { cells: { x: number; y: number; z: number }[]; idx: number };
    exc.cells = [
      { x: 15, y: 57, z: 0 }, // hanging over void, no rim within bridgeMaxRun
      { x: 0, y: 57, z: 0 },
    ];
    exc.idx = 0;

    kernel.tick(st);

    // Pruned THIS tick (cursor advanced) despite carrying filler — bridging is impossible with no
    // landing, so the guard skips rather than jitter for cfg.drill.digToStallTicks.
    expect(exc.idx).toBe(1);
    expect(st.phase).toBe("EXCAVATE");
    expect(st.running).toBe(true);
  });
});

describe("drill flooded-column watchdog — the not-fully-submerged 'flowing water' drown trap", () => {
  it("records a marker column bobbing in water as drowned + skips, never an infinite bob", () => {
    // The bug: a marker column sitting in a flooded cavern SURFACE — the bot bobs at the water line
    // (swim-out surfaces it each dip → DESCEND retries) and the horizontal approach counter is reset
    // by the bobbing so it never converges. submergesAt (full submersion) is owned by the reflexes;
    // this watchdog owns the partial/surface case. Simulated here by a not-grounded bot (bobbing/
    // floating) with water under its feet, so floorUnsafe's centred-dig check never runs.
    const bot = makeBot({ missions: [drillMission], config: { drill: { waterContactTicks: 5 } } });
    seedVeins(bot.rt, [{ kind: "iron", x: 0, z: 0 }]);
    bot.kernel.startMission(bot.st, "drill");

    const { rt, kernel, st } = bot;
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    for (let i = 0; i < 5 && st.phase !== "DESCEND"; i++) kernel.tick(st);
    expect(st.phase).toBe("DESCEND");

    // Flooded: water directly under the feet, and the bot bobbing (not grounded) at the surface.
    rt.setBlock(0, 63, 0, "minecraft:water");
    rt.state.onGround = false;

    let settled = false;
    for (let i = 0; i < 20; i++) {
      kernel.tick(st);
      if (st.phase !== "DESCEND") {
        settled = true;
        break;
      }
    }
    expect(settled).toBe(true);
    // Single vein → after the flooded column is skipped none remain → graceful PAUSE, not ERROR.
    expect(st.phase).toBe("PAUSED");
    // Persistent mark: the column is recorded drowned so future runs skip it ("don't come back").
    const raw = rt.fs.read(makeGerdaConfig().worldModelPath);
    const model = JSON.parse(raw.ok && raw.value ? raw.value : "{}");
    const hazards = model.worlds[rt.state.worldSig]?.hazards ?? [];
    expect(hazards).toContainEqual(expect.objectContaining({ kind: "drowned", x: 0, z: 0 }));
  });
});

describe("drill 3D vein-chase — a blocked GOTO digs to the ore, never ERRORs", () => {
  it("a blocked GOTO (greedy can't walk there) routes to DIG_TO, not ERROR", () => {
    resetGreedyNav(); // the greedy planner cache is a module singleton
    const bot = makeBot({ missions: [drillMission], config: {} });
    seedVeins(bot.rt, [{ kind: "iron", x: 0, z: 0 }]);
    bot.kernel.startMission(bot.st, "drill");

    const { rt, kernel, st } = bot;
    // Bot on a one-block island; the vein-follow has aimed at an ore off across open void — same
    // level (so the descend guard leaves it to nav), but no floor to walk on → greedy blocks.
    rt.setBlock(0, 63, 0, "minecraft:stone");
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    const mem = st.bb["mining"] as MiningMem;
    expect(mem.onBlocked).toBe("dig"); // the drill opts into 3D vein-chase at init
    mem.standPos = { x: 8, y: 64, z: 0 };
    mem.target = { x: 8, y: 64, z: 0, id: "minecraft:iron_ore" };
    mem.face = "TOP";
    mem.arrivalPhase = null;
    st.phase = "GOTO";
    st.phaseTicks = 0;

    kernel.tick(st);

    expect(st.phase).toBe("DIG_TO"); // mine a path to it, not ERROR (and not a silent skip)
  });
});

describe("drill EXCAVATE progress watchdog — the below-band jump-in-place wedge", () => {
  // Live: the bot fell 2 below the band through the void gap it was bridging; the corridor
  // step's per-tick key release cut every up-step jump one tick in, greedy kept answering "moving"
  // (the per-cell `stall` budget only counts BLOCKED verdicts) and it hopped in place 11+ minutes.
  // On the mock the bot can't move at all, which reproduces exactly that signature: grounded, feet
  // frozen, greedy "moving" — the tick-based watchdog must rescue once, then skip the cell.
  it("no observable progress → one rescue leg, then the cell is skipped (never a silent spin)", () => {
    resetGreedyNav();
    const bot = makeBot({
      missions: [drillMission],
      // Small budgets so the test drives ~50 ticks, not 400. Semantics identical to the defaults.
      config: { excavate: { stallTicks: 15, rescueTicks: 15 } },
    });
    seedVeins(bot.rt, [{ kind: "iron", x: 0, z: 0 }]);
    bot.kernel.startMission(bot.st, "drill");
    const { rt, kernel, st } = bot;
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    for (let y = 63; y >= 55; y--) rt.setBlock(0, y, 0, "minecraft:stone");
    rt.setBlock(0, 58, 0, "minecraft:iron_ore");
    expect(driveDescent(bot, 200)).toBe(true);
    expect(st.phase).toBe("EXCAVATE");

    // The wedge geometry: bot grounded at feet (0,57) — 2 BELOW the corridor cell (2,59), which is
    // legally reachable via step-ups (treads (1,57)/(2,58) solid, headroom clear), so greedy plans a
    // route and answers "moving" every tick; the mock never moves the player. The cell's own floor is
    // solid so the void guard does NOT prune it — only the new watchdog can end this.
    rt.setBlock(0, 56, 0, "minecraft:stone");
    rt.setBlock(0, 57, 0, "minecraft:air");
    rt.setBlock(0, 58, 0, "minecraft:air");
    rt.setBlock(0, 59, 0, "minecraft:air");
    rt.setBlock(1, 57, 0, "minecraft:stone"); // tread 1
    rt.setBlock(1, 58, 0, "minecraft:air");
    rt.setBlock(1, 59, 0, "minecraft:air");
    rt.setBlock(2, 58, 0, "minecraft:stone"); // tread 2 = the corridor cell's floor (not voided)
    rt.setBlock(2, 59, 0, "minecraft:air");
    rt.setBlock(2, 60, 0, "minecraft:air");
    rt.setPos({ x: 0.5, y: 57, z: 0.5 });

    const exc = st.bb["excavate"] as { cells: { x: number; y: number; z: number }[]; idx: number };
    exc.cells = [{ x: 2, y: 59, z: 0 }];
    exc.idx = 0;

    // stall (15) + rescue (15) + second stall trip (15) + slack — the watchdog must have skipped the
    // cell and completed the plan by then, with the mission still healthy (never ERROR).
    for (let i = 0; i < 80 && exc.idx === 0; i++) kernel.tick(st);
    expect(exc.idx).toBe(1);
    expect(st.phase).not.toBe("ERROR");
    expect(st.running).toBe(true);
  });
});

it("a grounded/airborne JUMP LOOP does not blind the watchdog (sig flip regression)", () => {
  // The first shipped signature encoded grounded-vs-air, so a hop loop (grounded 2 ticks, airborne
  // ~10) re-armed the timer on every flip and the watchdog went blind in exactly the wedge it was
  // built for. The sig must update from grounded ticks only.
  resetGreedyNav();
  const bot = makeBot({
    missions: [drillMission],
    config: { excavate: { stallTicks: 15, rescueTicks: 15 } },
  });
  seedVeins(bot.rt, [{ kind: "iron", x: 0, z: 0 }]);
  bot.kernel.startMission(bot.st, "drill");
  const { rt, kernel, st } = bot;
  rt.setPos({ x: 0.5, y: 64, z: 0.5 });
  for (let y = 63; y >= 55; y--) rt.setBlock(0, y, 0, "minecraft:stone");
  rt.setBlock(0, 58, 0, "minecraft:iron_ore");
  expect(driveDescent(bot, 200)).toBe(true);
  expect(st.phase).toBe("EXCAVATE");

  rt.setBlock(0, 56, 0, "minecraft:stone");
  rt.setBlock(0, 57, 0, "minecraft:air");
  rt.setBlock(0, 58, 0, "minecraft:air");
  rt.setBlock(0, 59, 0, "minecraft:air");
  rt.setBlock(1, 57, 0, "minecraft:stone");
  rt.setBlock(1, 58, 0, "minecraft:air");
  rt.setBlock(1, 59, 0, "minecraft:air");
  rt.setBlock(2, 58, 0, "minecraft:stone");
  rt.setBlock(2, 59, 0, "minecraft:air");
  rt.setBlock(2, 60, 0, "minecraft:air");

  const exc = st.bb["excavate"] as { cells: { x: number; y: number; z: number }[]; idx: number };
  exc.cells = [{ x: 2, y: 59, z: 0 }];
  exc.idx = 0;

  // Simulate the hop loop: 2 grounded ticks at the same cell, then ~10 airborne ticks 1 block up.
  for (let i = 0; i < 200 && exc.idx === 0; i++) {
    const hop = i % 12;
    if (hop < 2) {
      rt.state.onGround = true;
      rt.setPos({ x: 0.5, y: 57, z: 0.5 });
    } else {
      rt.state.onGround = false;
      rt.setPos({ x: 0.5, y: 58.2, z: 0.5 });
    }
    kernel.tick(st);
  }
  rt.state.onGround = true;
  expect(exc.idx).toBe(1); // the watchdog saw through the flips and skipped the cell
  expect(st.phase).not.toBe("ERROR");
});
