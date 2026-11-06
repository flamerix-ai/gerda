import { core } from "@/bot/capabilities/core";
import { smeltMission } from "@/bot/missions/smelt";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import type { Container } from "@/core/runtime/Runtime";
import { createMockRuntime } from "@/core/runtime/mock";
import { type Result, err, ok } from "@/core/runtime/types";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogRecord, type LogSink, Logger } from "@/shared/kernel/logger";
import { describe, expect, it } from "vitest";

// A scriptable fake furnace. This tests the smelt MISSION LOGIC (phase machine, shift-click load
// orchestration, the verify-convention, output collection) against a controlled container — it does
// NOT assert real in-game furnace mechanics (region names, whether the pack honours shift-click
// routing, GTCEu smelt outputs); those need a live verification pass (see the mission header).
interface Stack {
  id: string;
  count: number;
  durabilityPct: number;
}
const IN = 200;
const FUEL = 201;
const OUT = 202;

function st(id: string, count: number): Stack {
  return { id, count, durabilityPct: 100 };
}
function merge(into: Stack | null, add: Stack): Stack {
  return into && into.id === add.id ? { ...into, count: into.count + add.count } : { ...add };
}

function makeFurnace(inputId: string, fuelId: string | null, outputId: string) {
  const carry = new Map<number, Stack>();
  const f = {
    input: null as Stack | null,
    fuel: null as Stack | null,
    output: null as Stack | null,
    open: false,
  };

  const container: Container = {
    regions: () => ["hotbar", "main", "furnace_in", "furnace_fuel", "furnace_out"],
    slots: (...regions) => {
      if (regions.length === 0) return [...carry.keys()]; // carry (main+hotbar)
      const out: number[] = [];
      if (regions.includes("hotbar") || regions.includes("main")) out.push(...carry.keys());
      if (regions.includes("furnace_in")) out.push(IN);
      if (regions.includes("furnace_fuel")) out.push(FUEL);
      if (regions.includes("furnace_out")) out.push(OUT);
      return out;
    },
    totalSlots: () => 46,
    slot: (i) =>
      i === IN ? f.input : i === FUEL ? f.fuel : i === OUT ? f.output : (carry.get(i) ?? null),
    selectedHotbar: () => 0,
    selectHotbar: () => {},
    quick: (i) => {
      if (i === OUT) {
        if (f.output) {
          // collect to a free carry slot
          let k = 0;
          while (carry.has(k)) k++;
          carry.set(k, merge(carry.get(k) ?? null, f.output));
          f.output = null;
        }
        return;
      }
      const s = carry.get(i);
      if (!s) return;
      if (s.id === inputId) {
        f.input = merge(f.input, s);
        carry.delete(i);
      } else if (fuelId && s.id === fuelId) {
        f.fuel = merge(f.fuel, s);
        carry.delete(i);
      }
    },
    swap: () => {},
    dropSlot: (i) => carry.delete(i),
  };

  return {
    f,
    carry,
    container,
    // Simulate the server smelting the loaded batch fully into the output slot.
    smeltAll: () => {
      if (f.input && f.input.count > 0) {
        f.output = merge(f.output, st(outputId, f.input.count));
        f.input = null;
      }
    },
    carryCount: (id: string) => {
      let n = 0;
      for (const s of carry.values()) if (s.id === id) n += s.count;
      return n;
    },
  };
}

function bot(furnace: ReturnType<typeof makeFurnace>): {
  rt: ReturnType<typeof createMockRuntime>;
  kernel: Kernel;
  st: BotState;
  logs: LogRecord[];
} {
  const logs: LogRecord[] = [];
  const sink: LogSink = { emit: (line) => logs.push(JSON.parse(line) as LogRecord) };
  const rt = createMockRuntime();
  // Splice in the fake furnace: inv.open reflects the GUI state, useOnBlock opens it.
  rt.inv.open = (): Result<Container> =>
    furnace.f.open ? ok(furnace.container) : err("no screen");
  rt.interact.useOnBlock = (): Result<void> => {
    furnace.f.open = true;
    return ok(undefined);
  };
  rt.interact.closeScreen = (): Result<void> => {
    furnace.f.open = false;
    return ok(undefined);
  };
  const kernel = new Kernel(
    rt,
    new Logger(sink, "INFO"),
    new Bus(),
    makeGerdaConfig(),
    GERDA_PHASES,
  );
  kernel.register(core);
  kernel.registerMission(smeltMission);
  const state = makeInitialState();
  kernel.init(state);
  return { rt, kernel, st: state, logs };
}

const ev = (logs: LogRecord[], name: string) => logs.find((l) => l.event === name);

describe("smelt mission", () => {
  it("opens a furnace, loads input+fuel, waits, collects the output", () => {
    const furnace = makeFurnace("gtceu:raw_iron", "minecraft:coal", "minecraft:iron_ingot");
    furnace.carry.set(0, st("gtceu:raw_iron", 4));
    furnace.carry.set(1, st("minecraft:coal", 2));
    const { kernel, st: state, logs } = bot(furnace);
    kernel.startMission(state, "smelt", {
      input: "gtceu:raw_iron",
      output: "minecraft:iron_ingot",
      fuel: "minecraft:coal",
      x: 10,
      y: 64,
      z: 10,
    });

    // Drive ticks; once the input lands in the furnace, simulate the smelt completing.
    for (let i = 0; i < 30 && kernel.activeMission() !== null; i++) {
      kernel.tick(state);
      if (furnace.f.input && furnace.f.input.count > 0) furnace.smeltAll();
    }

    expect(ev(logs, "SMELT_LOADED")?.fields).toMatchObject({ loaded: 4 });
    expect(ev(logs, "SMELT_COLLECTED")?.fields).toMatchObject({ outputId: "minecraft:iron_ingot" });
    expect(ev(logs, "SMELT_DONE")).toBeDefined();
    // The 4 raw iron came back as 4 iron ingots in the bag; the furnace input drained.
    expect(furnace.carryCount("minecraft:iron_ingot")).toBe(4);
    expect(furnace.carryCount("gtceu:raw_iron")).toBe(0);
    expect(furnace.f.input).toBeNull();
    expect(kernel.activeMission()).toBeNull(); // mission completed → IDLE
  });

  it("ERRORs (fail-loud) when the furnace GUI never opens", () => {
    const furnace = makeFurnace("gtceu:raw_iron", null, "minecraft:iron_ingot");
    furnace.carry.set(0, st("gtceu:raw_iron", 1));
    // useOnBlock is a no-op here: GUI stays closed.
    const { rt, kernel, st: state } = bot(furnace);
    rt.interact.useOnBlock = (): Result<void> => ok(undefined); // does NOT open the GUI

    kernel.startMission(state, "smelt", {
      input: "gtceu:raw_iron",
      output: "minecraft:iron_ingot",
      x: 1,
      y: 64,
      z: 1,
    });
    for (let i = 0; i < 60 && state.phase !== "ERROR"; i++) kernel.tick(state);
    expect(state.phase).toBe("ERROR");
  });

  it("ERRORs when the input never leaves the bag (furnace full / shift-click rejected)", () => {
    const furnace = makeFurnace("gtceu:raw_iron", null, "minecraft:iron_ingot");
    furnace.carry.set(0, st("gtceu:raw_iron", 1));
    // quick() that refuses to move anything → the load can't make progress.
    furnace.container.quick = () => {};
    const { kernel, st: state, logs } = bot(furnace);
    kernel.startMission(state, "smelt", {
      input: "gtceu:raw_iron",
      output: "minecraft:iron_ingot",
      x: 1,
      y: 64,
      z: 1,
    });
    for (let i = 0; i < 30 && state.phase !== "ERROR"; i++) kernel.tick(state);
    expect(ev(logs, "SMELT_LOAD_BLOCKED")).toBeDefined();
    expect(state.phase).toBe("ERROR");
  });

  it("mode:load (defer) loads and LEAVES — never waits for the smelt", () => {
    const furnace = makeFurnace("gtceu:raw_iron", "minecraft:coal", "minecraft:iron_ingot");
    furnace.carry.set(0, st("gtceu:raw_iron", 8));
    furnace.carry.set(1, st("minecraft:coal", 2));
    const { kernel, st: state, logs } = bot(furnace);
    kernel.startMission(state, "smelt", {
      mode: "load",
      input: "gtceu:raw_iron",
      output: "minecraft:iron_ingot",
      fuel: "minecraft:coal",
      x: 10,
      y: 64,
      z: 10,
    });
    // Deliberately NEVER call smeltAll() — the bot must finish without the smelt completing.
    for (let i = 0; i < 30 && kernel.activeMission() !== null; i++) kernel.tick(state);

    expect(ev(logs, "SMELT_LOADED")?.fields).toMatchObject({ loaded: 8, mode: "load" });
    expect(ev(logs, "SMELT_COLLECTED")).toBeUndefined(); // never waited / collected
    expect(ev(logs, "SMELT_DONE")?.fields).toMatchObject({ note: "loaded, left to smelt" });
    expect(furnace.f.input?.count).toBe(8); // ore sits in the furnace, still cooking
    expect(kernel.activeMission()).toBeNull(); // bot is free
  });

  it("mode:collect drains the ready output in one shot, without loading or waiting", () => {
    const furnace = makeFurnace("gtceu:raw_iron", null, "minecraft:iron_ingot");
    // The furnace already has finished output from an earlier `load` pass; the bag has no raw ore.
    furnace.f.output = st("minecraft:iron_ingot", 5);
    const { kernel, st: state, logs } = bot(furnace);
    kernel.startMission(state, "smelt", {
      mode: "collect",
      output: "minecraft:iron_ingot",
      x: 10,
      y: 64,
      z: 10,
    });
    for (let i = 0; i < 30 && kernel.activeMission() !== null; i++) kernel.tick(state);

    expect(ev(logs, "SMELT_LOADED")).toBeUndefined(); // collect never loads
    expect(ev(logs, "SMELT_COLLECTED")?.fields).toMatchObject({ got: 5 });
    expect(ev(logs, "SMELT_DONE")?.fields).toMatchObject({ note: "collected ready output" });
    expect(furnace.carryCount("minecraft:iron_ingot")).toBe(5);
    expect(furnace.f.output).toBeNull();
    expect(kernel.activeMission()).toBeNull();
  });
});
