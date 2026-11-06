// goto mission — the generic travel / return-to-base primitive. Walk to {x,y,z}, stop, done.
// Verifies arrival (GOTO_ARRIVED → IDLE), the no-target short-circuit, and the walk-timeout give-up.
import { core } from "@/bot/capabilities/core";
import { gotoMission } from "@/bot/missions/goto";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogRecord, type LogSink, Logger } from "@/shared/kernel/logger";
import { resetGreedyNav } from "@/shared/nav";
import { describe, expect, it } from "vitest";

function bot(over = {}): { rt: MockRuntime; kernel: Kernel; st: BotState; logs: LogRecord[] } {
  const logs: LogRecord[] = [];
  const sink: LogSink = { emit: (line) => logs.push(JSON.parse(line) as LogRecord) };
  const rt = createMockRuntime();
  const kernel = new Kernel(
    rt,
    new Logger(sink, "INFO"),
    new Bus(),
    makeGerdaConfig(over),
    GERDA_PHASES,
  );
  kernel.register(core).registerMission(gotoMission);
  const st = makeInitialState();
  kernel.init(st);
  return { rt, kernel, st, logs };
}

const ev = (logs: LogRecord[], name: string) => logs.find((l) => l.event === name);

describe("goto mission", () => {
  it("walks to the destination, then completes → IDLE (GOTO_ARRIVED)", () => {
    resetGreedyNav(); // greedy planner cache is a module singleton
    const { rt, kernel, st, logs } = bot();
    for (let x = 0; x <= 10; x++) rt.setBlock(x, 63, 0, "minecraft:stone"); // floor to the goal
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    kernel.startMission(st, "goto", { x: 10, y: 64, z: 0 });
    expect(st.phase).toBe("GOTO");

    kernel.tick(st); // greedy walks toward the goal — still en route
    expect(rt.state.keys["key.forward"]).toBe(true);
    expect(st.phase).toBe("GOTO");

    rt.setPos({ x: 10, y: 64, z: 0 }); // simulate arrival
    kernel.tick(st);
    expect(ev(logs, "GOTO_ARRIVED")).toBeDefined();
    expect(kernel.activeMission()).toBeNull();
    expect(st.phase).toBe("IDLE");
  });

  it("with no target params, finishes immediately (→ IDLE)", () => {
    const { kernel, st } = bot();
    kernel.startMission(st, "goto", {});
    kernel.tick(st); // GOTO sees no target → done → IDLE
    expect(kernel.activeMission()).toBeNull();
    expect(st.phase).toBe("IDLE");
  });

  it("gives up (GOTO_GAVE_UP) and finishes when the walk times out", () => {
    resetGreedyNav();
    const { rt, kernel, st, logs } = bot({ nav: { gotoTimeoutTicks: 3 } });
    rt.setPos({ x: 0, y: 64, z: 0 }); // no floor → never arrives at a far goal
    kernel.startMission(st, "goto", { x: 500, y: 64, z: 0 });
    for (let i = 0; i < 10 && kernel.activeMission() !== null; i++) kernel.tick(st);
    expect(ev(logs, "GOTO_GAVE_UP")).toBeDefined();
    expect(kernel.activeMission()).toBeNull();
    expect(st.phase).toBe("IDLE");
  });

  // walkTo hands ctx.log to the executor: a bridge laid on a goto/fetch/chop leg journals its
  // PLACE_CELL, and a place the server keeps refusing journals PLACE_CELL_TIMEOUT.
  it("a bridge place the server refuses reaches the journal (PLACE_CELL, PLACE_CELL_TIMEOUT)", () => {
    resetGreedyNav();
    const { rt, kernel, st, logs } = bot({ nav: { placeTimeoutTicks: 5 } });
    rt.setBlock(0, 63, 0, "minecraft:stone"); // the start, then a 4-wide void, then the far side
    for (let x = 5; x <= 12; x++) rt.setBlock(x, 63, 0, "minecraft:stone");
    rt.state.slots.set(36, { id: "minecraft:cobblestone", count: 64, durabilityPct: 100 });
    rt.interact.placeBlock = () => ({ ok: true, value: undefined }); // never lands
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    kernel.startMission(st, "goto", { x: 12, y: 64, z: 0 });
    for (let i = 0; i < 20 && !ev(logs, "PLACE_CELL_TIMEOUT"); i++) kernel.tick(st);
    expect(ev(logs, "PLACE_CELL")?.fields).toMatchObject({ at: { x: 1, y: 63, z: 0 } });
    expect(ev(logs, "PLACE_CELL_TIMEOUT")?.fields).toMatchObject({ at: { x: 1, y: 63, z: 0 } });
  });
});
