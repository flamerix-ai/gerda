// stash mission — the sustain-loop "unload" leg: walk to a chest, OPEN it (the step fetch is missing),
// deposit a whitelist of ids, close. Movement runs on the real mock (setPos arrival); the chest GUI is
// a spliced fake (like the smelt fake-furnace) so we test the open→deposit logic + verify-convention,
// NOT real in-game chest mechanics.
import { core } from "@/bot/capabilities/core";
import { stashMission } from "@/bot/missions/stash";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import type { Container } from "@/core/runtime/Runtime";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import { type Result, err, ok } from "@/core/runtime/types";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogRecord, type LogSink, Logger } from "@/shared/kernel/logger";
import { resetGreedyNav } from "@/shared/nav";
import { describe, expect, it } from "vitest";

interface Stack {
  id: string;
  count: number;
  durabilityPct: number;
}
const st = (id: string, count: number): Stack => ({ id, count, durabilityPct: 100 });

// A scriptable fake chest. Carry slots are low indices; the chest's own slots are 300+.
// quick(carrySlot) routes that stack INTO the chest (vanilla shift-click from the player inv).
function makeChest() {
  const carry = new Map<number, Stack>();
  const chest = new Map<number, Stack>();
  const state = { open: false };

  const container: Container = {
    regions: () => ["hotbar", "main", "container"],
    slots: (...regions) => {
      if (regions.length === 0) return [...carry.keys()]; // carry (main+hotbar)
      const out: number[] = [];
      if (regions.includes("hotbar") || regions.includes("main")) out.push(...carry.keys());
      if (regions.includes("container")) out.push(...chest.keys());
      return out;
    },
    totalSlots: () => 46,
    slot: (i) => carry.get(i) ?? chest.get(i) ?? null,
    selectedHotbar: () => 0,
    selectHotbar: () => {},
    quick: (i) => {
      const s = carry.get(i);
      if (!s) return; // only player→chest deposits are modelled
      let k = 300;
      while (chest.has(k)) k++;
      chest.set(k, s);
      carry.delete(i);
    },
    swap: () => {},
    dropSlot: (i) => carry.delete(i),
  };

  return {
    carry,
    chest,
    state,
    container,
    carryCount: (id: string) => {
      let n = 0;
      for (const s of carry.values()) if (s.id === id) n += s.count;
      return n;
    },
    chestCount: (id: string) => {
      let n = 0;
      for (const s of chest.values()) if (s.id === id) n += s.count;
      return n;
    },
  };
}

function bot(chest: ReturnType<typeof makeChest>): {
  rt: MockRuntime;
  kernel: Kernel;
  st: BotState;
  logs: LogRecord[];
} {
  const logs: LogRecord[] = [];
  const sink: LogSink = { emit: (line) => logs.push(JSON.parse(line) as LogRecord) };
  const rt = createMockRuntime();
  // Splice the fake chest: inv.open reflects the GUI state, useOnBlock opens it, closeScreen shuts it.
  rt.inv.open = (): Result<Container> =>
    chest.state.open ? ok(chest.container) : err("no screen");
  rt.interact.useOnBlock = (): Result<void> => {
    chest.state.open = true;
    return ok(undefined);
  };
  rt.interact.closeScreen = (): Result<void> => {
    chest.state.open = false;
    return ok(undefined);
  };
  const kernel = new Kernel(
    rt,
    new Logger(sink, "INFO"),
    new Bus(),
    makeGerdaConfig(),
    GERDA_PHASES,
  );
  kernel.register(core).registerMission(stashMission);
  const state = makeInitialState();
  kernel.init(state);
  return { rt, kernel, st: state, logs };
}

const ev = (logs: LogRecord[], name: string) => logs.find((l) => l.event === name);

describe("stash mission", () => {
  it("walks to the chest, opens it, deposits the whitelist, completes → IDLE", () => {
    resetGreedyNav();
    const chest = makeChest();
    chest.carry.set(0, st("minecraft:raw_iron", 12)); // deposit these
    chest.carry.set(1, st("minecraft:iron_ingot", 4)); // deposit these
    chest.carry.set(2, st("minecraft:diamond_pickaxe", 1)); // KEEP (not on the whitelist)
    const { rt, kernel, st: state, logs } = bot(chest);
    for (let x = 0; x <= 6; x++) rt.setBlock(x, 63, 0, "minecraft:stone"); // floor to the chest
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });

    kernel.startMission(state, "stash", {
      x: 6,
      y: 64,
      z: 0,
      items: ["minecraft:raw_iron", "minecraft:iron_ingot"],
    });
    expect(state.phase).toBe("GOTO");

    kernel.tick(state); // greedy walks toward the chest
    expect(rt.state.keys["key.forward"]).toBe(true);

    rt.setPos({ x: 6, y: 64, z: 0 }); // simulate arrival → STASH
    kernel.tick(state);
    expect(state.phase).toBe("STASH");

    // OPEN (useOnBlock) then DEPOSIT — drive a few ticks for the open→deposit sub-steps.
    for (let i = 0; i < 8 && kernel.activeMission() !== null; i++) kernel.tick(state);

    expect(ev(logs, "STASH_DEPOSITED")?.fields).toMatchObject({ deposited: 16 });
    expect(ev(logs, "STASH_DONE")).toBeDefined();
    // Whitelisted ids went into the chest; the pickaxe stayed in the bag.
    expect(chest.chestCount("minecraft:raw_iron")).toBe(12);
    expect(chest.chestCount("minecraft:iron_ingot")).toBe(4);
    expect(chest.carryCount("minecraft:raw_iron")).toBe(0);
    expect(chest.carryCount("minecraft:diamond_pickaxe")).toBe(1);
    expect(kernel.activeMission()).toBeNull();
    expect(state.phase).toBe("IDLE");
  });

  it("accepts a comma-separated items string", () => {
    resetGreedyNav();
    const chest = makeChest();
    chest.carry.set(0, st("minecraft:cobblestone", 30));
    const { rt, kernel, st: state, logs } = bot(chest);
    rt.setPos({ x: 0, y: 64, z: 0 });
    kernel.startMission(state, "stash", {
      x: 0,
      y: 64,
      z: 0,
      items: " minecraft:cobblestone , minecraft:dirt ",
    });
    for (let i = 0; i < 8 && kernel.activeMission() !== null; i++) kernel.tick(state);
    expect(chest.chestCount("minecraft:cobblestone")).toBe(30);
    expect(ev(logs, "STASH_DONE")).toBeDefined();
  });

  it("finishes 'nothing to stash' when the bag holds none of the whitelist", () => {
    resetGreedyNav();
    const chest = makeChest();
    chest.carry.set(0, st("minecraft:diamond_pickaxe", 1)); // not on the whitelist
    const { rt, kernel, st: state, logs } = bot(chest);
    rt.setPos({ x: 0, y: 64, z: 0 });
    kernel.startMission(state, "stash", { x: 0, y: 64, z: 0, items: ["minecraft:raw_iron"] });
    for (let i = 0; i < 8 && kernel.activeMission() !== null; i++) kernel.tick(state);
    expect(ev(logs, "STASH_DONE")?.fields).toMatchObject({ note: "nothing to stash" });
    expect(chest.carryCount("minecraft:diamond_pickaxe")).toBe(1); // untouched
    expect(kernel.activeMission()).toBeNull();
  });

  it("ERRORs (fail-loud) when the chest GUI never opens", () => {
    resetGreedyNav();
    const chest = makeChest();
    chest.carry.set(0, st("minecraft:raw_iron", 4));
    const { rt, kernel, st: state } = bot(chest);
    rt.interact.useOnBlock = (): Result<void> => ok(undefined); // does NOT open the GUI
    rt.setPos({ x: 0, y: 64, z: 0 });
    kernel.startMission(state, "stash", { x: 0, y: 64, z: 0, items: ["minecraft:raw_iron"] });
    for (let i = 0; i < 80 && state.phase !== "ERROR"; i++) kernel.tick(state);
    expect(state.phase).toBe("ERROR");
  });
});
