import { core } from "@/bot/capabilities/core";
import { mineMission } from "@/bot/missions/mine";
import type { MiningMem } from "@/bot/missions/mine/mining-mem";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { encodePos } from "@/core/prim/pos";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import type { Vec3 } from "@/core/runtime/types";
import { isExposed, isOre } from "@/shared/domain/scan";
import { collectVeinCube, orderHorizonFirst } from "@/shared/domain/vein";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogSink, Logger } from "@/shared/kernel/logger";
import { reflexes } from "@/shared/reflexes";
import { describe, expect, it } from "vitest";

const sink: LogSink = { emit: () => {} };
const cfg = makeGerdaConfig();

describe("vein domain", () => {
  it("collectVeinCube gathers exposed ore, skipping center / non-ore / mined", () => {
    const blocks = new Map<string, string>([
      [encodePos(0, 0, 0), "gtceu:iron_ore"], // center — skipped
      [encodePos(1, 0, 0), "gtceu:iron_ore"],
      [encodePos(0, 1, 0), "gtceu:iron_ore"],
      [encodePos(2, 0, 0), "minecraft:stone"], // not ore
      [encodePos(-1, 0, 0), "gtceu:copper_ore"],
    ]);
    const blockId = (x: number, y: number, z: number) =>
      blocks.get(encodePos(x, y, z)) ?? "minecraft:air";

    const mined = new Set([encodePos(-1, 0, 0)]); // pretend we already broke this one
    const cells = collectVeinCube(
      blockId,
      (id) => isOre(id, cfg),
      (x, y, z) => isExposed(blockId, x, y, z),
      { x: 0, y: 0, z: 0 },
      2,
      50,
      (key) => mined.has(key),
    );

    const keys = cells.map((c) => encodePos(c.x, c.y, c.z)).sort();
    expect(keys).toEqual([encodePos(0, 1, 0), encodePos(1, 0, 0)].sort());
  });

  it("orderHorizonFirst finishes the current Y-layer before stepping off it", () => {
    const ref: Vec3 = { x: 0, y: 0, z: 0 };
    const cells = [
      { x: 0, y: 2, z: 0 },
      { x: 3, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    ];
    const ordered = orderHorizonFirst(cells, ref);
    expect(ordered.map((c) => c.y)).toEqual([0, 0, 2]); // same-layer first…
    expect(ordered[0]).toEqual({ x: 1, y: 0, z: 0 }); // …nearest within the layer
  });

  it("orderHorizonFirst holds the horizon: same level, then ABOVE, then BELOW last", () => {
    const ref: Vec3 = { x: 0, y: 0, z: 0 };
    // A close below-ore (y−1, adjacent) vs a far above-ore (y+1, distance 5): the OLD |Δy| order
    // put the closer below-ore first (|Δy|=1 both, below nearer) → the bot dropped. Horizon-first
    // takes the above-ore first so depth is never broken while at-or-above ore remains.
    const cells = [
      { x: 1, y: -1, z: 0 }, // just below, adjacent
      { x: 5, y: 1, z: 0 }, // above but far
      { x: 0, y: 0, z: 0 }, // same level
    ];
    const ordered = orderHorizonFirst(cells, ref);
    expect(ordered.map((c) => c.y)).toEqual([0, 1, -1]); // same → above → below, regardless of dist
  });
});

function fullBot(): { rt: MockRuntime; kernel: Kernel; st: BotState } {
  const rt = createMockRuntime();
  const kernel = new Kernel(rt, new Logger(sink, "ERR"), new Bus(), cfg, GERDA_PHASES);
  kernel.register(core);
  for (const r of reflexes) kernel.register(r);
  kernel.registerMission(mineMission);
  const st = makeInitialState();
  kernel.init(st);
  kernel.startMission(st, "mine");
  return { rt, kernel, st };
}

describe("vein continuation in MINE", () => {
  it("mines a connected vein without falling back to SCAN per block", () => {
    const { rt, kernel, st } = fullBot();
    // 3-block horizontal vein.
    rt.setBlock(2, 64, 0, "gtceu:iron_ore");
    rt.setBlock(3, 64, 0, "gtceu:iron_ore");
    rt.setBlock(4, 64, 0, "gtceu:iron_ore");

    for (let i = 0; i < 300; i++) {
      kernel.tick(st);
      const mem = st.bb["mining"] as MiningMem | undefined;
      if (st.phase === "GOTO" && mem?.standPos) rt.setPos(mem.standPos);
      if (st.phase === "MINE") rt.flushBreak();
      if (st.phase === "PAUSED") break;
    }

    expect(rt.state.blocks.get(encodePos(2, 64, 0))).toBe("minecraft:air");
    expect(rt.state.blocks.get(encodePos(3, 64, 0))).toBe("minecraft:air");
    expect(rt.state.blocks.get(encodePos(4, 64, 0))).toBe("minecraft:air");
    const mem = st.bb["mining"] as MiningMem;
    // All three were driven through the vein-mined set (the continuation path),
    // not rediscovered one-by-one by a fresh spiral scan.
    expect(mem.veinMined.size).toBeGreaterThanOrEqual(3);
  });
});
