import { drillMission } from "@/bot/missions/drill";
import { floorVerdict } from "@/bot/missions/drill/floor-safety";
import type { MiningMem } from "@/bot/missions/mine/mining-mem";
import { makeGerdaConfig } from "@/bot/profile/config";
import type { MockRuntime } from "@/core/runtime/mock";
// DESCEND handler (drill mission) — drives the downward-shaft digger on the mock runtime.
// Covers the safety rails (hazard / void / water / depth floor → refuse-and-skip, never plunge), the
// GOTO-stall skip (unreachable vein → next / PAUSED), and the vein-reached handoff. The multi-step
// "dig a shaft then reach the vein" flow lives in drill-mission.test.ts (full GOTO→DESCEND→handoff).
import type { BlockReader } from "@/shared/domain/senses";
import { navSearchPending, resetGreedyNav } from "@/shared/nav";
import { describe, expect, it } from "vitest";
import { type BotHarness, makeBot } from "./harness";

interface SeedMarker {
  kind: string;
  x: number;
  z: number;
  bbox?: readonly [number, number, number, number];
}

interface HazardSeed {
  kind: "drowned";
  x: number;
  z: number;
}

// Seed mc_world.json with prospector veins for the mock's current world signature, so the
// drill init finds a cached vein (noTarget=false) and we can drive DESCEND directly. Optional
// `hazards` seeds recorded drowned columns (Layer 3 skip test).
function seedVeins(rt: MockRuntime, resources: SeedMarker[], hazards: HazardSeed[] = []): void {
  const sig = rt.state.worldSig;
  const model = {
    version: 1,
    worlds: {
      [sig]: {
        waypoints: [],
        resources,
        hazards,
        stats: { dumps: 0, veinsFound: 0, boots: 0 },
        updatedAt: 0,
      },
    },
  };
  rt.fs.write(makeGerdaConfig().worldModelPath, JSON.stringify(model));
}

/** The recorded drowned-column hazards in the mock's mc_world.json (for the Layer-3 record test). */
function readHazards(rt: MockRuntime): HazardSeed[] {
  const raw = rt.fs.read(makeGerdaConfig().worldModelPath);
  if (!raw.ok || !raw.value) return [];
  const model = JSON.parse(raw.value) as {
    worlds: Record<string, { hazards?: HazardSeed[] }>;
  };
  return model.worlds[rt.state.worldSig]?.hazards ?? [];
}

// Boot the drill mission with one vein directly under the bot, then force phase=DESCEND so
// the handler runs against whatever blocks the test seeds below it.
// Reflexes off: these exercise the DESCEND handler's OWN safety rails. The L2 hazard reflex
// would otherwise pre-empt adjacent lava into RECOVER before the handler's floorUnsafe veto
// (that precedence is covered by the reflex tests).
function descending(): BotHarness {
  const bot = makeBot({
    missions: [drillMission],
    config: {},
    withReflexes: false,
  });
  seedVeins(bot.rt, [{ kind: "iron", x: 0, z: 0 }]);
  bot.kernel.startMission(bot.st, "drill");
  // Block-centred (x.5, z.5) → the footprint is the single column (0,_,0), the clean case.
  bot.rt.setPos({ x: 0.5, y: 64, z: 0.5 });
  bot.st.phase = "DESCEND";
  bot.st.phaseTicks = 0;
  return bot;
}

describe("descend safety (refuse the hazard, skip to next vein — never plunge, never ERROR)", () => {
  // The bot still NEVER digs into the hazard (the floorVerdict veto holds); the only change from the old
  // fail-loud behaviour is the terminus — with a single seeded vein the drill skips it and, none left,
  // PAUSEs gracefully instead of ERRORing ("skip them without falling into ERROR"). The no-plunge
  // property is proven by the phase NOT being DESCEND (it did not break the hazard floor and
  // drop through).
  it("lava directly below → skip (never plunges, graceful PAUSED)", () => {
    const { rt, kernel, st } = descending();
    rt.setBlock(0, 63, 0, "minecraft:lava");
    kernel.tick(st);
    expect(st.phase).toBe("PAUSED");
  });

  it("a deep open fall below → skip (cave/void veto, graceful PAUSED)", () => {
    const { rt, kernel, st } = descending();
    // Breakable stone floor, but only air beneath it for further than cfg.drill.maxFall.
    rt.setBlock(0, 63, 0, "minecraft:stone");
    kernel.tick(st);
    expect(st.phase).toBe("PAUSED");
  });

  it("reaching the depth floor with no vein → skip the bad marker (graceful PAUSED)", () => {
    const { rt, kernel, st } = descending();
    rt.setPos({ x: 0.5, y: makeGerdaConfig().drill.minY, z: 0.5 });
    kernel.tick(st);
    expect(st.phase).toBe("PAUSED");
  });

  it("water directly below → skip (won't flood/drown the shaft, graceful PAUSED)", () => {
    const { rt, kernel, st } = descending();
    rt.setBlock(0, 63, 0, "minecraft:water");
    kernel.tick(st);
    expect(st.phase).toBe("PAUSED");
  });
});

describe("descend drown-column memory (mark it and don't come back — Layer 3)", () => {
  it("a water-abort records the vein column as a drowned hazard in mc_world.json", () => {
    const { rt, kernel, st } = descending(); // vein seeded at column (0,0)
    expect(readHazards(rt)).toEqual([]); // nothing recorded yet
    rt.setBlock(0, 63, 0, "minecraft:water"); // the shaft opens into an aquifer
    kernel.tick(st);
    expect(st.phase).toBe("PAUSED"); // skip the drown trap → no more veins → graceful PAUSED (was ERROR)
    expect(readHazards(rt)).toEqual([{ kind: "drowned", x: 0, z: 0, tick: expect.any(Number) }]);
  });

  it("selectDrillVein skips a vein sitting on a recorded drowned column (no target)", () => {
    const bot = makeBot({ missions: [drillMission], config: {}, withReflexes: false });
    // The only cached vein is at (0,0) — but that column is already marked drowned.
    seedVeins(bot.rt, [{ kind: "iron", x: 0, z: 0 }], [{ kind: "drowned", x: 0, z: 0 }]);
    bot.rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    bot.kernel.startMission(bot.st, "drill"); // init → selectDrillVein filters the drowned column out
    const drill = bot.st.bb["drill"] as { noTarget: boolean };
    expect(drill.noTarget).toBe(true); // no safe vein left → don't re-target the drown trap
  });

  it("a drowned CENTRE with a wide bbox re-aims at an alternate dig column (vein not written off)", () => {
    const bot = makeBot({ missions: [drillMission], config: {}, withReflexes: false });
    // Vein centroid (0,0) is drowned, but the vein spans a 40×40 bbox — quarter-grid
    // candidates escape cfg.drill.hazardRadius (3), nearest-to-centroid (10,10) wins.
    seedVeins(
      bot.rt,
      [{ kind: "iron", x: 0, z: 0, bbox: [0, 0, 40, 40] }],
      [{ kind: "drowned", x: 0, z: 0 }],
    );
    bot.rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    bot.kernel.startMission(bot.st, "drill");
    const drill = bot.st.bb["drill"] as {
      noTarget: boolean;
      vein: { x: number; z: number } | null;
    };
    expect(drill.noTarget).toBe(false);
    expect(drill.vein).toMatchObject({ x: 10, z: 10 });
  });

  it("a small bbox fully inside the hazard radius is still dropped (all candidates wet)", () => {
    const bot = makeBot({ missions: [drillMission], config: {}, withReflexes: false });
    // 2×2 bbox: every quarter-grid candidate floors to within 3 blocks of the drowned centre.
    seedVeins(
      bot.rt,
      [{ kind: "iron", x: 1, z: 1, bbox: [0, 0, 2, 2] }],
      [{ kind: "drowned", x: 1, z: 1 }],
    );
    bot.rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    bot.kernel.startMission(bot.st, "drill");
    const drill = bot.st.bb["drill"] as { noTarget: boolean };
    expect(drill.noTarget).toBe(true);
  });

  it("selectDrillVein still targets a vein FAR from a drowned column", () => {
    const bot = makeBot({ missions: [drillMission], config: {}, withReflexes: false });
    // Drowned column at (0,0); a good vein 20 blocks away (well beyond cfg.drill.hazardRadius).
    seedVeins(bot.rt, [{ kind: "iron", x: 20, z: 0 }], [{ kind: "drowned", x: 0, z: 0 }]);
    bot.rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    bot.kernel.startMission(bot.st, "drill");
    const drill = bot.st.bb["drill"] as {
      noTarget: boolean;
      vein: { x: number; z: number } | null;
    };
    expect(drill.noTarget).toBe(false);
    expect(drill.vein).toMatchObject({ x: 20, z: 0 });
  });
});

describe("descend beyond-the-horizon veto (cfg.drill.maxVeinDist)", () => {
  it("a vein beyond cfg.drill.maxVeinDist parks noTarget instead of hiking (live: a 10 km silver walk)", () => {
    const bot = makeBot({ missions: [drillMission], config: {}, withReflexes: false });
    // The only silver marker is a stale one from a PREVIOUS prospecting area, 10 km away.
    seedVeins(bot.rt, [{ kind: "iron", x: -10000, z: 8000 }]);
    bot.rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    bot.kernel.startMission(bot.st, "drill");
    const drill = bot.st.bb["drill"] as { noTarget: boolean };
    expect(drill.noTarget).toBe(true); // too far = same honest outcome as an empty cache
  });

  it("a vein just inside the limit is still targeted", () => {
    const bot = makeBot({
      missions: [drillMission],
      config: { drill: { maxVeinDist: 300 } },
      withReflexes: false,
    });
    seedVeins(bot.rt, [{ kind: "iron", x: 250, z: 0 }]);
    bot.rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    bot.kernel.startMission(bot.st, "drill");
    const drill = bot.st.bb["drill"] as {
      noTarget: boolean;
      vein: { x: number; z: number } | null;
    };
    expect(drill.noTarget).toBe(false);
    expect(drill.vein).toMatchObject({ x: 250, z: 0 });
  });
});

describe("descend vein handoff", () => {
  it("an exposed target ore in range hands off out of DESCEND with the target set", () => {
    const { rt, kernel, st } = descending();
    // The shaft has already descended past the surface-scatter skip (surfaceY well above feet),
    // so an exposed ore at feet level IS the buried band and engages.
    (st.bb["drillRun"] as { surfaceY: number }).surfaceY = 70; // started digging 6 blocks up
    // Ore one block to the side at feet level — exposed (air all around) and within
    // cfg.drill.scanRadius, so this DESCEND tick detects it.
    rt.setBlock(1, 64, 0, "minecraft:iron_ore");
    kernel.tick(st);
    expect(st.phase).not.toBe("DESCEND");
    // The shaft reached the vein's ore band → strip-mine the whole VOLUME: DESCEND sets
    // the mine target on the grazed ore and hands to EXCAVATE, which walks the corridor plan and
    // feeds each exposed clump (this one included) to MINE's vein-follow.
    expect(st.phase).toBe("EXCAVATE");
    const mem = st.bb["mining"] as MiningMem;
    expect(mem.target).toMatchObject({ x: 1, y: 64, z: 0, id: "minecraft:iron_ore" });
  });

  it("surface scatter is ignored — exposed ore within cfg.drill.surfaceSkip of the start keeps digging", () => {
    const { rt, kernel, st } = descending();
    // Fresh shaft: the first DESCEND tick records surfaceY = feet.y (64), so ore exposed AT the
    // surface is the prospector's surface scatter, not the buried band. The drill drills past it.
    rt.setBlock(1, 64, 0, "minecraft:iron_ore"); // scatter beside the arrival column
    rt.setBlock(0, 63, 0, "minecraft:stone"); // solid floor to chew (no void veto)
    rt.setBlock(0, 62, 0, "minecraft:stone");
    rt.setBlock(0, 61, 0, "minecraft:stone");
    kernel.tick(st);
    expect(st.phase).toBe("DESCEND"); // did NOT engage the surface scatter — still drilling down
    expect(rt.state.mineTarget).toEqual({ x: 0, y: 63, z: 0 }); // aiming straight at the floor
  });

  it("a non-target block in range is ignored (keeps digging)", () => {
    const { rt, kernel, st } = descending();
    rt.setBlock(1, 64, 0, "minecraft:stone"); // not ore
    rt.setBlock(0, 63, 0, "minecraft:stone"); // a real floor to chew (no void veto)
    rt.setBlock(0, 62, 0, "minecraft:stone");
    rt.setBlock(0, 61, 0, "minecraft:stone");
    kernel.tick(st);
    expect(st.phase).toBe("DESCEND"); // still descending — stone isn't a vein
    expect(rt.state.mineTarget).toEqual({ x: 0, y: 63, z: 0 }); // aiming at the floor
  });
});

describe("descend multi-band (dig every vein on the way down)", () => {
  it("finishing a band keeps digging: EXCAVATE done → DESCEND, bandsMined++", () => {
    const { st, kernel } = descending();
    // An active-but-complete plan (empty cells) → the EXCAVATE handler calls done() this tick.
    const exc = st.bb["excavate"] as { cells: unknown[]; idx: number; active: boolean };
    exc.active = true;
    exc.cells = [];
    exc.idx = 0;
    const drill = st.bb["drill"] as { bandsMined: number };
    drill.bandsMined = 0;
    st.phase = "EXCAVATE";
    st.phaseTicks = 0;
    kernel.tick(st);
    expect(st.phase).toBe("DESCEND"); // don't pass by ore — on to the next band, not SCAN/PAUSED
    expect(drill.bandsMined).toBe(1);
  });

  it("reaching the depth floor AFTER mining a band → graceful PAUSED (not the no-vein ERROR)", () => {
    const { rt, kernel, st } = descending();
    (st.bb["drill"] as { bandsMined: number }).bandsMined = 1; // a band already stripped this run
    rt.setPos({ x: 0.5, y: makeGerdaConfig().drill.minY, z: 0.5 });
    kernel.tick(st);
    expect(st.phase).toBe("PAUSED"); // exhausted the column of veins, ended cleanly
  });

  it("an unsafe floor below AFTER mining a band → graceful PAUSED (not the void ERROR)", () => {
    const { rt, kernel, st } = descending();
    (st.bb["drill"] as { bandsMined: number }).bandsMined = 1; // a band already stripped
    // Breakable stone floor, but only air below it past cfg.drill.maxFall — a void the shaft won't plunge
    // into. Fresh (bandsMined 0) this is the DRILL_VOID ERROR; with a band mined it's a clean stop.
    rt.setBlock(0, 63, 0, "minecraft:stone");
    kernel.tick(st);
    expect(st.phase).toBe("PAUSED");
  });

  it("with multi-band OFF, finishing a band falls to SCAN (old stop-after-one behaviour)", () => {
    const bot = makeBot({
      missions: [drillMission],
      config: { drill: { multiBand: false } },
      withReflexes: false,
    });
    seedVeins(bot.rt, [{ kind: "iron", x: 0, z: 0 }]);
    bot.kernel.startMission(bot.st, "drill");
    bot.rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    const exc = bot.st.bb["excavate"] as { cells: unknown[]; idx: number; active: boolean };
    exc.active = true;
    exc.cells = [];
    exc.idx = 0;
    bot.st.phase = "EXCAVATE";
    bot.st.phaseTicks = 0;
    bot.kernel.tick(bot.st);
    expect(bot.st.phase).toBe("SCAN");
  });
});

describe("descend precise-descend (marker-column anchor)", () => {
  it("arrives OFF the marker column → walks onto the marker before digging (not the arrival block)", () => {
    const { rt, kernel, st } = descending();
    // Vein marker is at x0; simulate GOTO's ~2.5-block arrival leaving the bot centred on block x2.
    rt.setPos({ x: 2.5, y: 64, z: 0.5 });
    // A walkable surface (stand y64) from the arrival column back to the marker, so the bot can walk
    // onto the marker. Solid under the arrival column too, so a mis-aimed dig there would be a valid
    // floor dig (not a void-ERROR) — the test proves we DON'T dig it, we walk to the marker instead.
    for (let x = 0; x <= 2; x++) rt.setBlock(x, 63, 0, "minecraft:stone");
    kernel.tick(st);
    expect(st.phase).toBe("DESCEND"); // centring, not erroring
    expect(rt.state.mineTarget).not.toEqual({ x: 2, y: 63, z: 0 }); // did NOT dig the arrival column
    expect(rt.state.keys["key.forward"]).toBe(true); // walking toward the marker column instead
  });

  it("arrives ON the marker column → digs immediately (no needless walk)", () => {
    const { rt, kernel, st } = descending();
    rt.setPos({ x: 0.5, y: 64, z: 0.5 }); // dead-on the marker (x0,z0)
    rt.setBlock(0, 63, 0, "minecraft:stone");
    rt.setBlock(0, 62, 0, "minecraft:stone");
    rt.setBlock(0, 61, 0, "minecraft:stone");
    kernel.tick(st);
    expect(st.phase).toBe("DESCEND");
    expect(rt.state.mineTarget).toEqual({ x: 0, y: 63, z: 0 }); // aims straight at the floor column
  });
});

describe("descend sub-floor vein-follow guard", () => {
  it("a MINE→GOTO toward an ore ≥2 below in the SAME column redirects to DESCEND (dig straight down)", () => {
    const { kernel, st } = descending();
    // Simulate the MINE vein-follow having aimed at an ore directly below us, in GOTO.
    const mem = st.bb["mining"] as MiningMem;
    mem.standPos = { x: 0, y: 60, z: 0 }; // 4 below feet (y64), SAME x/z column
    mem.target = { x: 0, y: 60, z: 0, id: "minecraft:iron_ore" };
    st.phase = "GOTO";
    st.phaseTicks = 0;
    kernel.tick(st);
    expect(st.phase).toBe("DESCEND"); // a straight-down shaft reaches it
  });

  it("a GOTO toward an ore ≥2 below AND laterally OFFSET routes to DIG_TO (the excavate-stall fix)", () => {
    const { kernel, st } = descending();
    const mem = st.bb["mining"] as MiningMem;
    // 4 below feet (y64) AND 5 blocks over — a straight-down shaft can NEVER reach it, so the old code
    // froze the shaft at the band level until the stall watchdog ERRORed. Now it staircases down instead.
    mem.standPos = { x: 5, y: 60, z: 0 };
    mem.target = { x: 5, y: 60, z: 0, id: "minecraft:iron_ore" };
    mem.face = "TOP";
    st.phase = "GOTO";
    st.phaseTicks = 0;
    kernel.tick(st);
    expect(st.phase).toBe("DIG_TO"); // dig a staircase DOWN toward the offset ore, not a dead vertical shaft
  });

  it("a GOTO toward an ore at/above our level is left to normal nav (no redirect)", () => {
    resetGreedyNav();
    const { rt, kernel, st } = descending();
    const mem = st.bb["mining"] as MiningMem;
    mem.standPos = { x: 5, y: 64, z: 0 }; // same level, off to the side
    mem.target = { x: 6, y: 64, z: 0, id: "minecraft:iron_ore" };
    for (let x = 0; x <= 6; x++) rt.setBlock(x, 63, 0, "minecraft:stone"); // walkable floor to the ore
    st.phase = "GOTO";
    st.phaseTicks = 0;
    kernel.tick(st);
    expect(st.phase).toBe("GOTO"); // greedy walks toward it (the descend guard does NOT redirect)
  });

  it("a GOTO toward an ore ≥2 ABOVE (can't climb the shaft) routes to DIG_TO (mine up to it)", () => {
    const { kernel, st } = descending();
    const mem = st.bb["mining"] as MiningMem;
    mem.standPos = { x: 2, y: 67, z: 0 }; // 3 above feet (y64) AND offset → a diggable staircase
    mem.target = { x: 2, y: 67, z: 0, id: "minecraft:iron_ore" };
    mem.face = "TOP";
    st.phase = "GOTO";
    st.phaseTicks = 0;
    kernel.tick(st);
    expect(st.phase).toBe("DIG_TO"); // 3D vein-chase: dig a staircase up, not a silent skip
  });
});

describe("descend GOTO-stall skip (reach scattered veins, or skip them)", () => {
  // A prospected vein whose marker column the drill can't PATH to (parked across a ravine/gap) is
  // unreachable, not fatal. The step-1 walk-onto-the-column stays blocked; past cfg.drill.approachBlockedTicks
  // the drill gives up on THAT vein (session skip-set) and re-targets the next-nearest — never DRILL_STALL.
  function islandOffMarker(bot: BotHarness): void {
    // Bot on a 1-block stone island at x5, a fatal air gap west toward the marker (0,0). Empty bag →
    // no filler → the planner can't bridge the gap → greedyStep returns blocked_no_path every tick.
    bot.rt.setBlock(5, 63, 0, "minecraft:stone");
    bot.rt.setPos({ x: 5.5, y: 64, z: 0.5 });
    bot.st.phase = "DESCEND";
    bot.st.phaseTicks = 0;
  }

  it("an unreachable vein column → skip to the next-nearest cached vein (not DRILL_STALL/ERROR)", () => {
    resetGreedyNav();
    const bot = makeBot({ missions: [drillMission], config: {}, withReflexes: false });
    // (0,0) is nearest but unreachable across the gap; (30,0) is farther but a fresh GOTO target.
    seedVeins(bot.rt, [
      { kind: "iron", x: 0, z: 0 },
      { kind: "iron", x: 30, z: 0 },
    ]);
    bot.kernel.startMission(bot.st, "drill"); // init → selectDrillVein picks the nearer (0,0)
    const drill = bot.st.bb["drill"] as {
      vein: { x: number; z: number } | null;
      skip: string[];
    };
    expect(drill.vein).toMatchObject({ x: 0, z: 0 });
    islandOffMarker(bot);
    const limit = makeGerdaConfig().drill.approachBlockedTicks + 3;
    for (let i = 0; i < limit && bot.st.phase === "DESCEND"; i++) bot.kernel.tick(bot.st);
    expect(drill.skip).toContain("0,0"); // gave up on the unreachable vein
    expect(drill.vein).toMatchObject({ x: 30, z: 0 }); // re-targeted the next-nearest
    expect(bot.st.phase).toBe("GOTO"); // walking to the new vein, never ERROR
  });

  it("no reachable vein left → graceful PAUSED (never ERROR)", () => {
    resetGreedyNav();
    const bot = makeBot({ missions: [drillMission], config: {}, withReflexes: false });
    seedVeins(bot.rt, [{ kind: "iron", x: 0, z: 0 }]); // the ONLY vein is unreachable
    bot.kernel.startMission(bot.st, "drill");
    islandOffMarker(bot);
    const limit = makeGerdaConfig().drill.approachBlockedTicks + 3;
    for (let i = 0; i < limit && bot.st.phase === "DESCEND"; i++) bot.kernel.tick(bot.st);
    expect(bot.st.phase).toBe("PAUSED"); // no vein to skip TO → graceful pause, never ERROR
  });

  it("a steadily-advancing approach is NOT skipped (progress resets the stall counter)", () => {
    resetGreedyNav();
    const bot = makeBot({ missions: [drillMission], config: {}, withReflexes: false });
    seedVeins(bot.rt, [{ kind: "iron", x: 0, z: 0 }]);
    bot.kernel.startMission(bot.st, "drill");
    for (let x = 0; x <= 6; x++) bot.rt.setBlock(x, 63, 0, "minecraft:stone"); // walkable floor to the marker
    bot.st.phase = "DESCEND";
    bot.st.phaseTicks = 0;
    const drill = bot.st.bb["drill"] as { skip: string[] };
    // The mock has no physics sim, so model a real walk-in: each tick the bot advances ~0.5 block toward
    // the marker column (well past cfg.drill.approachProgressEps). Progress must keep resetting the GOTO-stall
    // counter, so even far more ticks than the threshold never skip a vein the bot IS closing on.
    let x = 6.5;
    const limit = makeGerdaConfig().drill.approachBlockedTicks + 10;
    for (let i = 0; i < limit && bot.st.phase === "DESCEND" && Math.floor(x) !== 0; i++) {
      bot.rt.setPos({ x, y: 64, z: 0.5 });
      bot.kernel.tick(bot.st);
      x = Math.max(0.5, x - 0.5);
    }
    expect(drill.skip).toEqual([]); // never gave up on a vein it was steadily approaching
    expect(bot.st.phase).not.toBe("ERROR");
  });

  it("a route search that outlasts the approach budget does not skip the vein", () => {
    // The walk onto the column holds still while its route search runs across ticks; those ticks are
    // paused on the approach clock, not counted as a stalled approach. One read a tick makes a search
    // round a wall last a tick per expansion, longer than cfg.drill.approachBlockedTicks.
    resetGreedyNav();
    const bot = makeBot({
      missions: [drillMission],
      config: { nav: { planReadsPerTick: 1 } },
      withReflexes: false,
    });
    seedVeins(bot.rt, [{ kind: "iron", x: 0, z: 0 }]); // the only vein: a skip would PAUSE
    bot.kernel.startMission(bot.st, "drill");
    for (let x = -14; x <= 14; x++)
      for (let z = -14; z <= 14; z++) bot.rt.setBlock(x, 63, z, "minecraft:stone");
    for (let z = -9; z <= 9; z++)
      for (let y = 64; y <= 67; y++) bot.rt.setBlock(3, y, z, "minecraft:stone"); // a wall to go round
    bot.rt.setPos({ x: 6.5, y: 64, z: 0.5 });
    bot.st.phase = "DESCEND";
    bot.st.phaseTicks = 0;
    const drill = bot.st.bb["drill"] as { skip: string[] };
    const budget = makeGerdaConfig().drill.approachBlockedTicks;
    let pending = 0;
    bot.kernel.tick(bot.st);
    for (; navSearchPending() && pending < budget * 4; pending++) bot.kernel.tick(bot.st);
    expect(pending).toBeGreaterThan(budget); // the search really outlasted the budget
    expect(drill.skip).toEqual([]); // the vein was not given up on while the search ran
    expect(bot.st.phase).toBe("DESCEND");
  });
});

describe("floorVerdict — safe-digging rule (don't dig blind under yourself)", () => {
  // Honest reader: explicit `unknown` cells read as null (unloaded/unreadable), known cells from
  // `grid`, everything else air. floorVerdict refuses the unknown rather than assuming solid stone.
  function rdr(grid: Record<string, string>, unknown: string[] = []): BlockReader {
    const un = new Set(unknown);
    return (x, y, z) => {
      const k = `${x},${y},${z}`;
      if (un.has(k)) return null;
      return grid[k] ?? "minecraft:air";
    };
  }
  const b = { x: 0, y: 62, z: 0 }; // the floor cell we'd break (feet.y - 1)
  const MAX_FALL = 3;

  it("safe: known solid floor with a solid landing one below", () => {
    const r = rdr({ "0,62,0": "minecraft:stone", "0,61,0": "minecraft:stone" });
    expect(floorVerdict(r, b, MAX_FALL, 0)).toBe("safe");
  });

  it("hazard: lava directly below the broken floor", () => {
    const r = rdr({ "0,62,0": "minecraft:stone", "0,61,0": "minecraft:lava" });
    expect(floorVerdict(r, b, MAX_FALL, 0)).toBe("hazard");
  });

  it("void: an open fall deeper than maxFall (cave/void below)", () => {
    const r = rdr({ "0,62,0": "minecraft:stone" }); // 61,60,59,58 default to air
    expect(floorVerdict(r, b, MAX_FALL, 0)).toBe("void");
  });

  it("unknown: the block we'd break is unreadable → refuse (don't dig blind)", () => {
    const r = rdr({ "0,61,0": "minecraft:stone" }, ["0,62,0"]);
    expect(floorVerdict(r, b, MAX_FALL, 0)).toBe("unknown");
  });

  it("unknown: a known floor but the landing column is unreadable → refuse", () => {
    const r = rdr({ "0,62,0": "minecraft:stone" }, ["0,61,0"]);
    expect(floorVerdict(r, b, MAX_FALL, 0)).toBe("unknown");
  });

  it("water: the floor we'd break IS water → drown trap, refuse (a live drowning)", () => {
    const r = rdr({ "0,62,0": "minecraft:water", "0,61,0": "minecraft:stone" });
    expect(floorVerdict(r, b, MAX_FALL, 0)).toBe("water");
  });

  it("water: a solid floor but the fall column opens into water → flood/drown, refuse", () => {
    const r = rdr({ "0,62,0": "minecraft:stone", "0,60,0": "minecraft:water" }); // 61 air, 60 water
    expect(floorVerdict(r, b, MAX_FALL, 0)).toBe("water");
  });
});

describe("descend no-target guard vs emergency landings (drowned in the RECOVER<->PAUSED ping-pong)", () => {
  // Live: a drowning bot's reflex diverted to RECOVER, but the noTarget guard PAUSED
  // over it EVERY tick — the swim-out/respawn handler never ran and the bot died. The guard may
  // park from productive phases only; RECOVER/EAT own the FSM until they finish.
  function noVeinDrill(phase: "RECOVER" | "EAT" | "IDLE"): BotHarness {
    const bot = makeBot({ missions: [drillMission], config: {}, withReflexes: false });
    seedVeins(bot.rt, []); // empty cache → drill init sets noTarget=true
    bot.rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    bot.kernel.startMission(bot.st, "drill");
    bot.st.phase = phase;
    bot.st.phaseTicks = 0;
    return bot;
  }

  it("noTarget in RECOVER → the guard stays out (no PAUSED preempt; the recover handler runs)", () => {
    const { kernel, st } = noVeinDrill("RECOVER");
    kernel.tick(st);
    expect(st.phase).not.toBe("PAUSED");
  });

  it("noTarget in EAT → the guard stays out (the meal finishes, resume returns the exact phase)", () => {
    const { kernel, st } = noVeinDrill("EAT");
    kernel.tick(st);
    expect(st.phase).not.toBe("PAUSED");
  });

  it("noTarget in a productive phase still parks gracefully (the guard's job is unchanged)", () => {
    const { kernel, st } = noVeinDrill("IDLE");
    kernel.tick(st);
    expect(st.phase).toBe("PAUSED");
  });
});

describe("descend airborne-stall watchdog (the vine-hang wedge)", () => {
  // Live: /rtp parked a bot hanging in a jungle vine column — onGround false forever, so
  // the settle gate returned before every other watchdog and DESCEND wedged silently for 30+ minutes.
  it("never-grounded DESCEND skips the vein after cfg.drill.stallTicks instead of waiting forever", () => {
    const { rt, kernel, st } = descending();
    rt.state.onGround = false;
    const limit = makeGerdaConfig().drill.stallTicks;
    for (let i = 0; i <= limit + 2; i++) kernel.tick(st);
    // Single seeded vein → skipUnreachableVein exhausts the cache → graceful PAUSED, never ERROR.
    expect(st.phase).toBe("PAUSED");
  });

  it("a real shaft fall (re-grounds quickly) does NOT trip the watchdog", () => {
    const { rt, kernel, st } = descending();
    rt.setBlock(0, 63, 0, "minecraft:stone");
    rt.setBlock(0, 62, 0, "minecraft:iron_ore");
    // A handful of airborne ticks (a normal 1-block drop mid-shaft), then grounded again.
    rt.state.onGround = false;
    for (let i = 0; i < 10; i++) kernel.tick(st);
    rt.state.onGround = true;
    kernel.tick(st);
    expect(st.phase).toBe("DESCEND"); // still digging — the fall never escalated
    expect(st.running).toBe(true);
  });
});
