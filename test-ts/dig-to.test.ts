import { drillMission } from "@/bot/missions/drill";
import type { MiningMem } from "@/bot/missions/mine/mining-mem";
// DIG_TO handler (drill 3D vein-chase) — the terminal transitions on the mock runtime: arriving
// at the stand pos hands off to MINE; an ore straight overhead drives the navigator's pillarUp
// move IN PLACE (no PILLAR_UP phase) — with filler it stays in DIG_TO climbing, with an
// empty bag greedy blocks → the ore is cached + SCANned. The multi-tick staircase dig itself
// (break → step → re-plan) and the live jump-place cycle are exercised live, not here.
import { encodePos } from "@/core/prim/pos";
import type { MockRuntime } from "@/core/runtime/mock";
import { describe, expect, it } from "vitest";
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
    kernel.tick(st);
    expect(st.phase).toBe("SCAN"); // graceful — cache it, never ERROR
    expect(mem.cache.has(encodePos(0, 69, 0))).toBe(true);
  });
});
