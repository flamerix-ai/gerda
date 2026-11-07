// search mission — the discovery half of the loot pipeline. Two concerns are unit-locked here:
//  1. buildGrid — the serpentine (boustrophedon) coverage order + multi-bot lane striping (pure).
//  2. the scan→record path — a 1×1 grid at the bot's position so GOTO arrives immediately (the mock
//     has no physics to walk a multi-stop grid); seed container blocks in range, assert the cuboid
//     scan finds the right ones and merges them into mc_world.json `storages` (ender chest excluded,
//     existing looted memory preserved on a re-scan).
import { core } from "@/bot/capabilities/core";
import { buildGrid, searchMission } from "@/bot/missions/search";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import {
  type StorageMarker,
  emptyModel,
  mergeStorageMarkers,
  putSection,
  storageKindOf,
} from "@/shared/domain/world-model";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogRecord, type LogSink, Logger } from "@/shared/kernel/logger";
import { resetGreedyNav } from "@/shared/nav";
import { describe, expect, it } from "vitest";

const SIG = "local|minecraft:overworld";

function bot(rt: MockRuntime): { kernel: Kernel; st: BotState; logs: LogRecord[] } {
  const logs: LogRecord[] = [];
  const sink: LogSink = { emit: (line) => logs.push(JSON.parse(line) as LogRecord) };
  const kernel = new Kernel(
    rt,
    new Logger(sink, "INFO"),
    new Bus(),
    makeGerdaConfig(),
    GERDA_PHASES,
  );
  kernel.register(core).registerMission(searchMission);
  const state = makeInitialState();
  kernel.init(state);
  return { kernel, st: state, logs };
}

const ev = (logs: LogRecord[], name: string) => logs.find((l) => l.event === name);
function storages(rt: MockRuntime): StorageMarker[] {
  const raw = rt.fs.read(makeGerdaConfig().worldModelPath);
  const after = JSON.parse(raw.ok ? (raw.value ?? "{}") : "{}");
  return (after.worlds?.[SIG]?.storages ?? []) as StorageMarker[];
}

describe("search — coverage grid", () => {
  it("buildGrid snakes left→right then right→left, spaced by step", () => {
    const g = buildGrid({ x: 0, y: 64, z: 0 }, 3, 2, 10, 1, 0);
    expect(g.map((p) => [p.x, p.z])).toEqual([
      [0, 0],
      [10, 0],
      [20, 0], // row 0 →
      [20, 10],
      [10, 10],
      [0, 10], // row 1 ← (snake)
    ]);
    expect(g.every((p) => p.y === 64)).toBe(true);
  });

  it("lanes stripe the columns across bots (disjoint, union = full grid)", () => {
    const args = [{ x: 0, y: 64, z: 0 }, 4, 1, 8] as const;
    const lane0 = buildGrid(...args, 2, 0).map((p) => p.x);
    const lane1 = buildGrid(...args, 2, 1).map((p) => p.x);
    expect(lane0).toEqual([0, 16]); // even columns
    expect(lane1).toEqual([8, 24]); // odd columns
    expect([...lane0, ...lane1].sort((a, b) => a - b)).toEqual([0, 8, 16, 24]); // together = all
  });
});

describe("storage classification + merge (pure)", () => {
  it("storageKindOf picks chests/barrels, skips ender chests and other blocks", () => {
    expect(storageKindOf("minecraft:chest")).toBe("chest");
    expect(storageKindOf("gtceu:wooden_crate")).toBeNull();
    expect(storageKindOf("minecraft:barrel")).toBe("barrel");
    expect(storageKindOf("minecraft:ender_chest")).toBeNull();
    expect(storageKindOf("lootr:lootr_chest")).toBe("chest");
    expect(storageKindOf("minecraft:stone")).toBeNull();
  });

  it("mergeStorageMarkers dedups by position and preserves the existing looted flag", () => {
    const existing: StorageMarker[] = [{ kind: "chest", x: 1, y: 64, z: 1, looted: true }];
    const incoming: StorageMarker[] = [
      { kind: "chest", x: 1, y: 64, z: 1 }, // same spot, re-scanned — must NOT un-loot
      { kind: "barrel", x: 2, y: 64, z: 2 }, // genuinely new
    ];
    const merged = mergeStorageMarkers(existing, incoming);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ x: 1, z: 1, looted: true });
    expect(merged[1]).toMatchObject({ kind: "barrel", x: 2, z: 2 });
  });
});

describe("search — scan & record", () => {
  it("records chests/barrels found in the cuboid, excluding ender chests", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    rt.setPos({ x: 0, y: 64, z: 0 });
    rt.setBlock(3, 64, 0, "minecraft:chest");
    rt.setBlock(0, 67, 2, "minecraft:barrel"); // up 3 → exercises the vertical reach
    rt.setBlock(-2, 64, -2, "minecraft:ender_chest"); // excluded
    const { kernel, st, logs } = bot(rt);
    // 1×1 grid at the bot → GOTO arrives immediately, then the cuboid scan runs to completion.
    kernel.startMission(st, "search", { cols: 1, rows: 1, radius: 6, height: 6 });
    for (let i = 0; i < 60 && kernel.activeMission() !== null; i++) kernel.tick(st);

    expect(ev(logs, "SEARCH_SCAN")?.fields).toMatchObject({ here: 2, added: 2 });
    expect(ev(logs, "SEARCH_DONE")?.fields).toMatchObject({ found: 2 });
    const found = storages(rt);
    expect(found).toHaveLength(2);
    expect(found.map((s) => s.kind).sort()).toEqual(["barrel", "chest"]);
  });

  it("a re-scan over an already-looted chest leaves it looted (no un-loot)", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    rt.setPos({ x: 0, y: 64, z: 0 });
    rt.setBlock(2, 64, 0, "minecraft:chest");
    // Pre-seed the model with this chest already marked looted.
    const model = putSection(emptyModel(), SIG, {
      waypoints: [],
      resources: [],
      storages: [{ kind: "chest", x: 2, y: 64, z: 0, looted: true }],
      hazards: [],
      stats: { dumps: 0, veinsFound: 0, boots: 0 },
      updatedAt: 0,
    });
    rt.fs.write(makeGerdaConfig().worldModelPath, JSON.stringify(model));

    const { kernel, st } = bot(rt);
    kernel.startMission(st, "search", { cols: 1, rows: 1, radius: 6, height: 6 });
    for (let i = 0; i < 60 && kernel.activeMission() !== null; i++) kernel.tick(st);

    const found = storages(rt);
    expect(found).toHaveLength(1); // not duplicated
    expect(found[0]).toMatchObject({ x: 2, z: 0, looted: true }); // still looted
  });
});
