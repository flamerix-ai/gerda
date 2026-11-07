import { makeOrchestrator } from "@/bot/orchestrator";
import { sustainCycle } from "@/bot/plans/sustain-cycle";
// sustain-cycle plan — verify the Stage 2 INFINITE autonomous loop chains
// mine → goto(base) → smelt(collect) → smelt(load) → prospect(next vein) → [loop to step 0] with the
// right params, and that the last step's `next: () => 0` actually re-enters step 0 (never finishes).
// The final leg is `prospect` (the dynamic shaft — walk to the nearest non-depleted vein), NOT a
// fixed goto. Uses instant-complete stub missions (the real ones need a world); locks plan DATA+loop.
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
  kernel.registerMission(stub("goto"));
  kernel.registerMission(stub("smelt"));
  kernel.registerMission(stub("craft"));
  kernel.registerMission(stub("storage"));
  kernel.registerMission(stub("prospect"));
  const orch = makeOrchestrator(kernel, [sustainCycle]);
  kernel.register(orch.cap).setSequencer(orch.sequencer);
  const st = makeInitialState();
  kernel.init(st);
  return { kernel, st, started };
}

describe("sustain-cycle plan (infinite autonomous loop)", () => {
  it("cycles mine→goto→smelt×2→craft(parts)→craft(tool)→storage→prospect and loops back to step 0", () => {
    const { kernel, st, started } = bot();
    kernel.command(st, { type: "plan_start", name: "sustain-cycle" });
    // The plan never completes (next → 0). Drive enough ticks for two full laps + a bit.
    for (let i = 0; i < 20; i++) kernel.tick(st);

    // One full lap is 8 steps; the 9th started mission is step 0 again (the loop fired).
    expect(started.slice(0, 9).map((s) => s.name)).toEqual([
      "mine",
      "goto",
      "smelt",
      "smelt",
      "craft", // ← parts restock (no-op when stocked, real craft when low)
      "craft", // ← tool replace (spare pickaxe for the tool reflex)
      "storage", // ← unload the surplus into the base storage network (smart-routed)
      "prospect", // ← the dynamic shaft: walk to the next non-depleted vein
      "mine", // ← next: () => 0 re-entered step 0
    ]);
    // Still running (an autonomous loop is never "done") — operator stops it with plan_abort/halt.
    expect(kernel.activeMission()).not.toBeNull();
  });

  it("passes the right params per step (collect-before-load, config base coords, prospect ore)", () => {
    const { kernel, st, started } = bot();
    kernel.command(st, { type: "plan_start", name: "sustain-cycle" });
    for (let i = 0; i < 9; i++) kernel.tick(st);

    // Coords/ids/count now come from cfg.sustain* (default = arena binding), not plan constants.
    expect(started[0]).toMatchObject({ name: "mine", params: { count: 3 } });
    expect(started[1]).toMatchObject({ name: "goto", params: { x: 5, y: 101, z: 1 } }); // base furnace
    expect(started[2]).toMatchObject({
      name: "smelt",
      params: { mode: "collect", output: "minecraft:iron_ingot", x: 5, y: 101, z: 1 },
    });
    expect(started[3]).toMatchObject({
      name: "smelt",
      params: {
        mode: "load",
        input: "minecraft:raw_iron",
        fuel: "minecraft:coal",
        x: 5,
        y: 101,
        z: 1,
      },
    });
    expect(started[4]).toMatchObject({
      name: "craft",
      params: { want: "minecraft:iron_nugget", min: 16, table: false },
    }); // parts restock
    expect(started[5]).toMatchObject({
      name: "craft",
      params: { want: "minecraft:iron_pickaxe", min: 1 },
    }); // tool replace
    expect(started[6]).toMatchObject({ name: "storage" }); // unload surplus into base storage
    expect(started[7]).toMatchObject({ name: "prospect", params: { ore: "iron" } }); // dynamic shaft
  });
});
