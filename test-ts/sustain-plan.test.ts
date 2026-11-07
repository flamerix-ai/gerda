import { makeOrchestrator } from "@/bot/orchestrator";
import { sustainMineSmelt } from "@/bot/plans/sustain-mine-smelt";
// sustain-mine-smelt plan — verify the Stage 1 pipeline chains mine→smelt through the
// orchestrator with the right params. Uses instant-complete stub missions named "mine" and
// "smelt" (the real ones need a world); this locks the plan DATA, not the mission internals.
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { createMockRuntime } from "@/core/runtime/mock";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogSink, Logger } from "@/shared/kernel/logger";
import type { Mission } from "@/shared/kernel/mission";
import { describe, expect, it } from "vitest";

const sink: LogSink = { emit: () => {} };

function bot(): {
  kernel: Kernel;
  st: BotState;
  started: { name: string; params: Record<string, unknown> }[];
} {
  const started: { name: string; params: Record<string, unknown> }[] = [];
  const stub = (name: string): Mission => ({
    name,
    edges: {},
    initialPhase: "SCAN",
    handlers: {},
    init: (_ctx, params) => started.push({ name, params }),
    isDone: () => true, // complete on the first tick → one step per tick
  });
  const rt = createMockRuntime();
  const kernel = new Kernel(
    rt,
    new Logger(sink, "ERR"),
    new Bus(),
    makeGerdaConfig(),
    GERDA_PHASES,
  );
  kernel.registerMission(stub("mine"));
  kernel.registerMission(stub("smelt"));
  const orch = makeOrchestrator(kernel, [sustainMineSmelt]);
  kernel.register(orch.cap).setSequencer(orch.sequencer);
  const st = makeInitialState();
  kernel.init(st);
  return { kernel, st, started };
}

describe("sustain-mine-smelt plan", () => {
  it("chains mine(count) → smelt(full) and completes", () => {
    const { kernel, st, started } = bot();
    kernel.command(st, { type: "plan_start", name: "sustain-mine-smelt" });
    // Drain the plan: each stub completes per tick, the sequencer advances.
    for (let i = 0; i < 6 && kernel.activeMission() !== null; i++) kernel.tick(st);

    expect(started.map((s) => s.name)).toEqual(["mine", "smelt"]);
    expect(started[0]?.params).toMatchObject({ count: 3 });
    expect(started[1]?.params).toMatchObject({
      mode: "full",
      input: "minecraft:raw_iron",
      output: "minecraft:iron_ingot",
      fuel: "minecraft:coal",
      x: 5,
      y: 101,
      z: 1,
    });
    expect(kernel.activeMission()).toBeNull(); // plan done → IDLE
  });
});
