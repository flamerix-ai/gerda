// The universality proof (pluggable missions / tiered architecture): a SECOND mission
// (fetch/restock) runs on the same kernel + reflexes as mining, and the bot switches mine ↔
// fetch at runtime with no reload. Covers the fetch goal-machine in isolation, the full switch sequence, and
// that reflexes stay active under a non-mining mission.
//
// fetch now OPENS the chest (useOnBlock) before withdrawing — `rt.inv.open()` reflects the
// CURRENTLY-open screen, it does not right-click a block. So the chest here is a spliced fake
// (like smelt's fake furnace): useOnBlock opens it, inv.open returns it while open, else the real
// player inventory (so mining/reflex code that calls inv.open still works under the full stack).
import { core } from "@/bot/capabilities/core";
import { makeMissionControl } from "@/bot/capabilities/mission-control";
import { recover } from "@/bot/capabilities/recover";
import { fetchMission } from "@/bot/missions/fetch";
import { mineMission } from "@/bot/missions/mine";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import type { Container } from "@/core/runtime/Runtime";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import { type Result, ok } from "@/core/runtime/types";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogRecord, type LogSink, Logger } from "@/shared/kernel/logger";
import { resetGreedyNav } from "@/shared/nav";
import { reflexes } from "@/shared/reflexes";
import { describe, expect, it } from "vitest";

interface Stack {
  id: string;
  count: number;
  durabilityPct: number;
}
const st = (id: string, count: number): Stack => ({ id, count, durabilityPct: 100 });

// A scriptable fake chest. Container slots are 300+. quick(containerSlot) withdraws that stack
// (removes it from the chest — the player-inventory side isn't modelled; tests assert the chest).
function makeChest(contents: Record<number, Stack>) {
  const chest = new Map<number, Stack>(Object.entries(contents).map(([k, v]) => [Number(k), v]));
  const state = { open: false };
  const container: Container = {
    regions: () => ["hotbar", "main", "container"],
    slots: (...regions) => (regions.includes("container") ? [...chest.keys()] : []),
    totalSlots: () => 46,
    slot: (i) => chest.get(i) ?? null,
    selectedHotbar: () => 0,
    selectHotbar: () => {},
    quick: (i) => {
      chest.delete(i); // withdraw out of the chest
    },
    swap: () => {},
    dropSlot: (i) => chest.delete(i),
  };
  return { chest, state, container };
}

// Full always-on stack (core + reflexes + recover + mission-control) with BOTH
// missions registered — the deployed shape, minus persistence/hud/telemetry.
function bot(
  chest: ReturnType<typeof makeChest> | null,
  over = {},
): { rt: MockRuntime; kernel: Kernel; st: BotState; logs: LogRecord[] } {
  const logs: LogRecord[] = [];
  const sink: LogSink = { emit: (line) => logs.push(JSON.parse(line) as LogRecord) };
  const rt = createMockRuntime();
  if (chest) {
    const realOpen = rt.inv.open;
    rt.inv.open = (): Result<Container> => (chest.state.open ? ok(chest.container) : realOpen()); // chest while open, else player inv
    rt.interact.useOnBlock = (): Result<void> => {
      chest.state.open = true;
      return ok(undefined);
    };
    rt.interact.closeScreen = (): Result<void> => {
      chest.state.open = false;
      return ok(undefined);
    };
  }
  const kernel = new Kernel(
    rt,
    new Logger(sink, "INFO"),
    new Bus(),
    makeGerdaConfig(over),
    GERDA_PHASES,
  );
  kernel.register(core);
  for (const r of reflexes) kernel.register(r);
  kernel
    .register(recover)
    .register(makeMissionControl(kernel))
    .registerMission(mineMission)
    .registerMission(fetchMission);
  const state = makeInitialState();
  kernel.init(state);
  return { rt, kernel, st: state, logs };
}

const ev = (logs: LogRecord[], name: string) => logs.find((l) => l.event === name);

describe("fetch mission (standalone)", () => {
  it("walks to the chest, OPENS it, withdraws its contents, then completes → IDLE", () => {
    resetGreedyNav(); // greedy planner cache is a module singleton
    const chest = makeChest({ 300: st("gtceu:steel_drill", 1), 301: st("minecraft:coal", 16) });
    const { rt, kernel, st: state, logs } = bot(chest);
    for (let x = 0; x <= 10; x++) rt.setBlock(x, 63, 0, "minecraft:stone"); // floor to the chest
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    kernel.startMission(state, "fetch", { x: 10, y: 64, z: 0 });
    expect(state.phase).toBe("GOTO");

    kernel.tick(state); // greedy walks toward the chest — still en route
    expect(rt.state.keys["key.forward"]).toBe(true);
    expect(state.phase).toBe("GOTO");

    rt.setPos({ x: 10, y: 64, z: 0 }); // simulate arrival → RESTOCK
    kernel.tick(state);
    expect(state.phase).toBe("RESTOCK");

    // RESTOCK: OPEN (useOnBlock) then WITHDRAW — drive a few ticks for the sub-steps.
    for (let i = 0; i < 6 && kernel.activeMission() !== null; i++) kernel.tick(state);
    expect(ev(logs, "FETCH_RESTOCK")?.fields).toMatchObject({ withdrew: 2 });
    expect(chest.chest.size).toBe(0); // both stacks withdrawn
    expect(kernel.activeMission()).toBeNull();
    expect(state.phase).toBe("IDLE");
  });

  it("withdraws only the whitelisted ids when items is given", () => {
    resetGreedyNav();
    const chest = makeChest({
      300: st("minecraft:coal", 16),
      301: st("minecraft:dirt", 5),
      302: st("minecraft:coal", 4),
    });
    const { rt, kernel, st: state, logs } = bot(chest);
    rt.setPos({ x: 0, y: 64, z: 0 });
    kernel.startMission(state, "fetch", { x: 0, y: 64, z: 0, items: ["minecraft:coal"] });
    for (let i = 0; i < 6 && kernel.activeMission() !== null; i++) kernel.tick(state);
    expect(ev(logs, "FETCH_RESTOCK")?.fields).toMatchObject({ withdrew: 2 }); // both coal stacks
    expect(chest.chest.has(301)).toBe(true); // dirt left behind
    expect(chest.chest.has(300)).toBe(false);
    expect(chest.chest.has(302)).toBe(false);
  });

  it("ERRORs (fail-loud) when the chest GUI never opens", () => {
    resetGreedyNav();
    const chest = makeChest({ 300: st("minecraft:coal", 1) });
    const { rt, kernel, st: state } = bot(chest);
    rt.interact.useOnBlock = (): Result<void> => ok(undefined); // does NOT open the GUI
    rt.setPos({ x: 0, y: 64, z: 0 });
    kernel.startMission(state, "fetch", { x: 0, y: 64, z: 0 });
    for (let i = 0; i < 80 && state.phase !== "ERROR"; i++) kernel.tick(state);
    expect(state.phase).toBe("ERROR");
  });

  it("with no target params, finishes immediately (→ IDLE)", () => {
    const { kernel, st: state } = bot(null);
    kernel.startMission(state, "fetch", {});
    kernel.tick(state); // GOTO sees no target → done → IDLE
    expect(kernel.activeMission()).toBeNull();
    expect(state.phase).toBe("IDLE");
  });
});

describe("mission switching (universality)", () => {
  it("mine → abort → fetch → back to mine, no reload, via the command path", () => {
    resetGreedyNav();
    const chest = makeChest({ 300: st("minecraft:coal", 8) });
    const { rt, kernel, st: state } = bot(chest);
    rt.setPos({ x: 0, y: 64, z: 0 });

    kernel.command(state, { type: "mission_start", name: "mine" });
    expect(kernel.activeMission()).toBe("mine");
    expect(state.phase).toBe("SCAN");

    kernel.command(state, { type: "mission_abort" });
    expect(kernel.activeMission()).toBeNull();
    expect(state.phase).toBe("IDLE");

    kernel.command(state, { type: "mission_start", name: "fetch", params: { x: 0, y: 64, z: 0 } });
    expect(kernel.activeMission()).toBe("fetch");
    expect(state.phase).toBe("GOTO");

    // fetch runs to completion (arrives same cell → RESTOCK → open → withdraw → IDLE)
    for (let i = 0; i < 8 && kernel.activeMission() !== null; i++) kernel.tick(state);
    expect(kernel.activeMission()).toBeNull();

    // back to mining, fresh
    kernel.command(state, { type: "mission_start", name: "mine" });
    expect(kernel.activeMission()).toBe("mine");
    expect(state.phase).toBe("SCAN");
  });

  it("starting fetch while mine is active aborts mine first", () => {
    const { kernel, st: state } = bot(null);
    kernel.startMission(state, "mine");
    expect(state.phase).toBe("SCAN");
    kernel.startMission(state, "fetch", { x: 1, y: 1, z: 1 });
    expect(kernel.activeMission()).toBe("fetch");
    expect(state.phase).toBe("GOTO");
  });

  it("reflexes stay active under the fetch mission (low health → RECOVER)", () => {
    const { rt, kernel, st: state } = bot(null);
    kernel.startMission(state, "fetch", { x: 100, y: 64, z: 0 });
    expect(state.phase).toBe("GOTO");
    rt.state.health = 2;
    kernel.tick(state);
    expect(state.phase).toBe("RECOVER");
  });
});
