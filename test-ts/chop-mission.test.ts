import { core } from "@/bot/capabilities/core";
import { recover } from "@/bot/capabilities/recover";
import { chopMission } from "@/bot/missions/chop";
import { MINING_SLICE, type MiningMem } from "@/bot/missions/mine/mining-mem";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
// chop-wood mission — fells a trunk on the mock runtime: SCAN finds the nearest log,
// GOTO/MINE break it, the continuation climbs the trunk, and the mission completes
// once `count` logs are gathered. Plus the wood/axe domain predicates.
import { strategyForTool, toolKind } from "@/shared/domain/tooling";
import { isLeaves, isLog, isSapling } from "@/shared/domain/wood";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogSink, Logger } from "@/shared/kernel/logger";
import { reflexes } from "@/shared/reflexes";
import { describe, expect, it } from "vitest";

const sink: LogSink = { emit: () => {} };

function bot(over = {}): { rt: MockRuntime; kernel: Kernel; st: BotState } {
  const rt = createMockRuntime();
  const kernel = new Kernel(
    rt,
    new Logger(sink, "ERR"),
    new Bus(),
    // navImpl=baritone: the chop mission walks to the tree via the #goto driver here; greedy (the
    // new default) key-walks and needs physics the mock lacks (covered by greedy-nav.test.ts).
    makeGerdaConfig({ ...over, nav: { mineAimTicks: 0 } }),
    GERDA_PHASES,
  );
  kernel.register(core);
  for (const r of reflexes) kernel.register(r);
  kernel.register(recover).registerMission(chopMission);
  const st = makeInitialState();
  kernel.init(st);
  return { rt, kernel, st };
}

// Drive the loop: when GOTO issues a #goto, teleport the bot there (the mock has no
// movement); flush any pending async break each tick. Stops when the mission ends.
function drive(rt: MockRuntime, kernel: Kernel, st: BotState, maxTicks = 200): void {
  for (let i = 0; i < maxTicks && kernel.activeMission() !== null; i++) {
    kernel.tick(st);
    if (st.phase === "GOTO") {
      const g = [...rt.state.chat].reverse().find((c) => c.startsWith("#goto "));
      const m = g?.split(" ");
      if (m && m.length === 4) rt.setPos({ x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) });
    }
    rt.flushBreak();
  }
}

describe("chop-wood mission", () => {
  it("fells a 3-block trunk and completes once the count is reached", () => {
    const { rt, kernel, st } = bot();
    rt.setPos({ x: 1, y: 64, z: 0 }); // adjacent to the trunk base
    rt.setBlock(2, 64, 0, "minecraft:oak_log");
    rt.setBlock(2, 65, 0, "minecraft:oak_log");
    rt.setBlock(2, 66, 0, "minecraft:oak_log");

    kernel.startMission(st, "chop", { count: 3 });
    expect(st.phase).toBe("SCAN");

    drive(rt, kernel, st);

    expect(rt.state.blocks.get("2,64,0")).toBe("minecraft:air");
    expect(rt.state.blocks.get("2,65,0")).toBe("minecraft:air");
    expect(rt.state.blocks.get("2,66,0")).toBe("minecraft:air");
    expect(kernel.activeMission()).toBeNull(); // count reached → done → IDLE
    expect(st.phase).toBe("IDLE");
  });

  it("with no trees in range, exhausts the scan → PAUSED", () => {
    // cfg.scan.maxBlocksPerTick large so one tick drains the whole spiral regardless of the
    // module-level offset cache built by an earlier test (radius is cached process-wide).
    const { rt, kernel, st } = bot({ scan: { maxCycles: 1, maxBlocksPerTick: 1_000_000 } });
    rt.setPos({ x: 0, y: 64, z: 0 });
    kernel.startMission(st, "chop", {});
    for (let i = 0; i < 50 && st.phase !== "PAUSED"; i++) kernel.tick(st);
    expect(st.phase).toBe("PAUSED");
  });

  it("scanCycle does not leak across runs — a fresh mission gets fresh dry-pass budget", () => {
    // Run 1 exhausts a treeless area (count>0 → isDone completes on `exhausted`).
    const { rt, kernel, st } = bot({ scan: { maxCycles: 2, maxBlocksPerTick: 1_000_000 } });
    rt.setPos({ x: 0, y: 64, z: 0 });
    kernel.startMission(st, "chop", { count: 8 });
    for (let i = 0; i < 60 && kernel.activeMission() !== null; i++) kernel.tick(st);
    expect(kernel.activeMission()).toBeNull();
    const afterRun1 = st.bb[MINING_SLICE.name] as MiningMem;
    expect(afterRun1.scanCycle).toBeGreaterThanOrEqual(2);

    // Run 2 must NOT inherit the counter (pre-fix: first dry pass latched exhausted → done
    // after one tree while 26 logs of the count remained).
    kernel.startMission(st, "chop", { count: 8 });
    const afterRun2 = st.bb[MINING_SLICE.name] as MiningMem;
    expect(afterRun2.scanCycle).toBe(0);
    expect(afterRun2.exhausted).toBe(false);
  });

  it("a find resets the dry-pass counter — exhaustion needs CONSECUTIVE dry passes", () => {
    const { rt, kernel, st } = bot();
    rt.setPos({ x: 1, y: 64, z: 0 });
    rt.setBlock(2, 64, 0, "minecraft:oak_log");
    kernel.startMission(st, "chop", { count: 1 });
    // Simulate accumulated dry passes from earlier spiral work in this run.
    (st.bb[MINING_SLICE.name] as MiningMem).scanCycle = 1;
    for (let i = 0; i < 20 && st.phase === "SCAN"; i++) kernel.tick(st);
    expect(st.phase).not.toBe("SCAN"); // the log was found and dispatched
    expect((st.bb[MINING_SLICE.name] as MiningMem).scanCycle).toBe(0);
  });

  it("diverts to LOOT for a felled-log drop instead of leaving it to despawn", () => {
    const { rt, kernel, st } = bot({ loot: { scanInterval: 1 }, scan: { maxBlocksPerTick: 1 } });
    rt.setPos({ x: 0, y: 64, z: 0 });
    // A log ITEM on the ground nearby (outside vanilla pickup range), no trees to chop.
    rt.state.items.push({ x: 3, y: 64, z: 0, id: "minecraft:acacia_log", count: 5 });
    kernel.startMission(st, "chop", { count: 4 });
    let sawLoot = false;
    for (let i = 0; i < 30 && !sawLoot; i++) {
      kernel.tick(st);
      if (st.phase === "LOOT") sawLoot = true;
    }
    expect(sawLoot).toBe(true);
  });

  it("LOOT completes only when the drop ENTITY is gone, not on proximity (verified pickup)", () => {
    const { rt, kernel, st } = bot({ loot: { scanInterval: 1 }, scan: { maxBlocksPerTick: 1 } });
    rt.setPos({ x: 1, y: 64, z: 0 });
    // The drop is INSIDE the old proximity radius — pre-fix this "picked up" in one tick
    // while the item stayed in the world.
    rt.state.items.push({ x: 1, y: 64, z: 1, id: "minecraft:acacia_log", count: 3 });
    kernel.startMission(st, "chop", { count: 4 });
    for (let i = 0; i < 10 && st.phase !== "LOOT"; i++) kernel.tick(st);
    expect(st.phase).toBe("LOOT");
    // Item still in the world → the phase must NOT declare victory.
    for (let i = 0; i < 10; i++) kernel.tick(st);
    expect(st.phase).toBe("LOOT");
    // The entity disappears (vanilla pickup happened) → NOW the divert completes.
    rt.state.items.length = 0;
    kernel.tick(st);
    expect(st.phase).not.toBe("LOOT");
  });

  it("a full bag ends the run gracefully (CHOP_BAG_FULL → exhausted completion)", () => {
    const { rt, kernel, st } = bot({ loot: { scanInterval: 1 }, scan: { maxBlocksPerTick: 1 } });
    rt.setPos({ x: 0, y: 64, z: 0 });
    // Fill every carry slot (mock carry = 9..44) — nothing can be picked up.
    for (let i = 9; i <= 44; i++) {
      rt.state.slots.set(i, { id: "minecraft:cobblestone", count: 64, durabilityPct: 100 });
    }
    rt.state.items.push({ x: 3, y: 64, z: 0, id: "minecraft:acacia_log", count: 5 });
    kernel.startMission(st, "chop", { count: 32 });
    let sawLoot = false;
    for (let i = 0; i < 40 && kernel.activeMission() !== null; i++) {
      kernel.tick(st);
      if (st.phase === "LOOT") sawLoot = true;
    }
    expect(sawLoot).toBe(false); // the divert is suppressed — walking to the drop is futile
    expect(kernel.activeMission()).toBeNull(); // bag-watch completed the run
    expect(st.phase).toBe("IDLE");
  });
});

describe("wood + axe domain", () => {
  const cfg = makeGerdaConfig();
  it("isLog matches configured + generic logs, not leaves/saplings", () => {
    expect(isLog("minecraft:oak_log", cfg)).toBe(true);
    expect(isLog("modpack:rubber_log", cfg)).toBe(true); // cfg.chop.allowAllLogs *_log
    expect(isLog("minecraft:oak_wood", cfg)).toBe(true);
    expect(isLog("minecraft:stone", cfg)).toBe(false);
    expect(isLeaves("minecraft:oak_leaves")).toBe(true);
    expect(isSapling("minecraft:birch_sapling")).toBe(true);
  });

  it("an axe is its own tool kind with a SIDE strategy (pickaxe still matches first)", () => {
    expect(toolKind("minecraft:diamond_axe")).toBe("axe");
    expect(toolKind("minecraft:diamond_pickaxe")).toBe("pickaxe");
    expect(strategyForTool("minecraft:iron_axe").breakTargetFace).toBe("SIDE");
  });
});
