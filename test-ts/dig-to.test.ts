import { drillMission } from "@/bot/missions/drill";
import type { MiningMem } from "@/bot/missions/mine/mining-mem";
// DIG_TO handler (drill 3D vein-chase) — the terminal transitions on the mock runtime: arriving
// at the stand pos hands off to MINE; an ore straight overhead drives the navigator's pillarUp
// move IN PLACE (no PILLAR_UP phase) — with filler it stays in DIG_TO climbing, with an
// empty bag greedy blocks → the ore is cached + SCANned. The multi-tick staircase dig itself
// (break → step → re-plan) and the live jump-place cycle are exercised live, not here.
import { encodePos } from "@/core/prim/pos";
import type { MockRuntime } from "@/core/runtime/mock";
import { resetGreedyNav } from "@/shared/nav";
import { beforeEach, describe, expect, it } from "vitest";
import { untilSearchEnds } from "./_greedy-step";
import { type BotHarness, makeBot } from "./harness";

const HOTBAR = 36;

function seedVeins(rt: MockRuntime, resources: { kind: string; x: number; z: number }[]): void {
  const sig = rt.state.worldSig;
  rt.fs.write(
    "./config/jsMacros/Macros/mc_world.json",
    JSON.stringify({
      version: 1,
      worlds: {
        [sig]: {
          waypoints: [],
          resources,
          stats: { dumps: 0, veinsFound: 0, boots: 0 },
          updatedAt: 0,
        },
      },
    }),
  );
}

function digging(): BotHarness {
  const bot = makeBot({
    missions: [drillMission],
    config: {},
    withReflexes: false,
  });
  seedVeins(bot.rt, [{ kind: "iron", x: 0, z: 0 }]);
  bot.kernel.startMission(bot.st, "drill");
  bot.rt.setPos({ x: 0.5, y: 64, z: 0.5 });
  bot.st.phase = "DIG_TO";
  bot.st.phaseTicks = 0;
  return bot;
}

describe("DIG_TO walk", () => {
  beforeEach(() => resetGreedyNav()); // the world-view cache is a module singleton

  // Each cell of the dig-walk is a new goal one cell on, and digToStallTicks blocked ticks skip the
  // ore: a goal that moved a cell must get its search on the tick the old route ran out.
  for (const axis of ["x", "z"] as const) {
    for (const speed of [0.216, 0.14, 0.1]) {
      it(`walks the whole way to the stand along ${axis} at ${speed} blocks a tick`, () => {
        const { rt, kernel, st } = digging();
        const mem = st.bb["mining"] as MiningMem;
        const at = (i: number) => (axis === "x" ? { x: i, z: 0 } : { x: 0, z: i });
        for (let i = -2; i <= 14; i++) rt.setBlock(at(i).x, 63, at(i).z, "minecraft:stone");
        mem.standPos = { ...at(10), y: 64 };
        mem.target = { ...at(11), y: 64, id: "minecraft:iron_ore" };
        mem.face = axis === "x" ? "WEST" : "NORTH";
        let along = 0.5;
        for (let t = 0; t < 200 && st.phase === "DIG_TO"; t++) {
          rt.state.tick = t;
          kernel.tick(st);
          if (!rt.state.keys["key.forward"]) continue;
          along += speed;
          rt.setPos(axis === "x" ? { x: along, y: 64, z: 0.5 } : { x: 0.5, y: 64, z: along });
        }
        expect(st.phase).toBe("MINE");
        expect(mem.cache.size).toBe(0); // the ore was not skipped on the way
      });
    }
  }
});

describe("DIG_TO handoff", () => {
  it("arrived (feet already at the stand pos) → MINE", () => {
    const { rt, kernel, st } = digging();
    const mem = st.bb["mining"] as MiningMem;
    mem.standPos = { x: 0, y: 64, z: 0 }; // == feet
    mem.target = { x: 1, y: 64, z: 0, id: "minecraft:iron_ore" };
    mem.face = "WEST";
    kernel.tick(st);
    expect(st.phase).toBe("MINE");
    void rt;
  });

  it("ore straight overhead WITH filler → drives the navigator pillar in place (stays DIG_TO)", () => {
    const { rt, kernel, st } = digging();
    const mem = st.bb["mining"] as MiningMem;
    mem.standPos = { x: 0, y: 68, z: 0 }; // 4 straight up, no horizontal → needPillar
    mem.target = { x: 0, y: 69, z: 0, id: "minecraft:iron_ore" };
    mem.face = "BOTTOM";
    for (let y = 64; y <= 72; y++) rt.setBlock(0, y, 0, "minecraft:air"); // a clear shaft to pillar
    rt.setBlock(0, 63, 0, "minecraft:stone");
    rt.state.slots.set(HOTBAR, { id: "minecraft:cobblestone", count: 64, durabilityPct: 100 });
    kernel.tick(st);
    expect(st.phase).toBe("DIG_TO"); // greedy owns the climb now — no PILLAR_UP phase to hand to
    expect(mem.cache.has(encodePos(0, 69, 0))).toBe(false); // not skipped — it's pillaring up
  });

  it("ore straight overhead but NO filler → greedy blocks → cache the ore + SCAN", () => {
    const { rt, kernel, st } = digging();
    const mem = st.bb["mining"] as MiningMem;
    mem.standPos = { x: 0, y: 68, z: 0 };
    mem.target = { x: 0, y: 69, z: 0, id: "minecraft:iron_ore" };
    mem.face = "BOTTOM";
    for (let y = 64; y <= 72; y++) rt.setBlock(0, y, 0, "minecraft:air");
    rt.setBlock(0, 63, 0, "minecraft:stone"); // empty bag → canPillar false → no route up
    untilSearchEnds(() => kernel.tick(st));
    expect(st.phase).toBe("SCAN"); // graceful — cache it, never ERROR
    expect(mem.cache.has(encodePos(0, 69, 0))).toBe(true);
  });
});
