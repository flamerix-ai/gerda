import { core } from "@/bot/capabilities/core";
import { MINE_EDGES, mineMission } from "@/bot/missions/mine";
import { loot } from "@/bot/missions/mine/loot";
import { initMiningMem } from "@/bot/missions/mine/mining-mem";
import { navigation } from "@/bot/missions/mine/navigation";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { createMockRuntime } from "@/core/runtime/mock";
import type { Vec3 } from "@/core/runtime/types";
import type { ConfigOverrides } from "@/shared/config/schema";
import { Bus } from "@/shared/kernel/bus";
import { Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogSink, Logger } from "@/shared/kernel/logger";
import { resetGreedyNav } from "@/shared/nav";
import { describe, expect, it } from "vitest";

const sink: LogSink = { emit: () => {} };

// Single-capability harness for the mining-phase micro-tests below. They drive
// st.phase directly, so the FSM needs the mine edges loaded (mining transitions are
// no longer global) — pass MINE_EDGES as extra edges.
function bot(caps: Parameters<Kernel["register"]>[0][], over: ConfigOverrides = {}) {
  const rt = createMockRuntime();
  const kernel = new Kernel(
    rt,
    new Logger(sink, "ERR"),
    new Bus(),
    makeGerdaConfig(over),
    GERDA_PHASES,
    [MINE_EDGES],
  );
  for (const c of caps) kernel.register(c);
  const st = makeInitialState();
  kernel.init(st);
  return { rt, kernel, st };
}

// Lifecycle harness: core is global; the mine mission supplies the phases.
function lifeBot(over: ConfigOverrides = {}) {
  const rt = createMockRuntime();
  const kernel = new Kernel(
    rt,
    new Logger(sink, "ERR"),
    new Bus(),
    makeGerdaConfig(over),
    GERDA_PHASES,
  );
  kernel.register(core).registerMission(mineMission);
  const st = makeInitialState();
  kernel.init(st);
  return { rt, kernel, st };
}

describe("command outcome (worker-ack correlation)", () => {
  it("a recognized command reports ok + recognized", () => {
    const { kernel, st } = lifeBot();
    kernel.startMission(st, "mine");
    kernel.command(st, { type: "pause" });
    const out = kernel.lastCommandOutcome();
    expect(out).toEqual({ type: "pause", recognized: true, ok: true, phase: "PAUSED" });
  });

  it("an unknown command reports not-recognized + not-ok", () => {
    const { kernel, st } = lifeBot();
    kernel.command(st, { type: "nope-not-a-command" });
    const out = kernel.lastCommandOutcome();
    expect(out?.recognized).toBe(false);
    expect(out?.ok).toBe(false);
  });
});

describe("core lifecycle commands", () => {
  it("starting the mine mission seeds SCAN + running", () => {
    const { kernel, st } = lifeBot();
    kernel.startMission(st, "mine");
    expect(st.running).toBe(true);
    expect(st.phase).toBe("SCAN");
  });

  it("pause then resume returns to the mission's initial phase (SCAN)", () => {
    const { kernel, st } = lifeBot();
    kernel.startMission(st, "mine");
    kernel.command(st, { type: "pause" });
    expect(st.phase).toBe("PAUSED");
    kernel.command(st, { type: "resume" });
    expect(st.phase).toBe("SCAN");
  });

  it("halt stops and releases movement keys (Baritone removed)", () => {
    const { rt, kernel, st } = lifeBot();
    kernel.startMission(st, "mine");
    rt.state.keys["key.forward"] = true; // pretend the greedy navigator was mid-walk
    kernel.command(st, { type: "halt" });
    expect(st.running).toBe(false);
    expect(st.phase).toBe("PAUSED");
    expect(rt.state.keys["key.forward"]).toBe(false); // movement released, no path driver to stop
  });

  it("start is idempotent while running", () => {
    const { kernel, st } = lifeBot();
    kernel.startMission(st, "mine");
    const before = st.tickCount;
    kernel.command(st, { type: "start" });
    expect(st.running).toBe(true);
    expect(st.tickCount).toBe(before);
  });
});

function gotoBot(stand: Vec3 | null, over: ConfigOverrides = {}) {
  // GOTO is now greedy-only (Baritone removed). Greedy key-walks; arrival is detected by
  // the bot's position reaching the stand pos. The mock has no physics, so a test simulates progress
  // by moving the player (rt.setPos); a flat floor lets greedy emit "moving" instead of blocking.
  resetGreedyNav(); // the greedy planner cache is a module singleton
  const { rt, kernel, st } = bot([navigation], { ...over });
  st.running = true;
  st.phase = "GOTO";
  st.bb["mining"] = { ...initMiningMem(), standPos: stand };
  return { rt, kernel, st };
}

describe("navigation GOTO", () => {
  it("greedy-walks to the stand pos, then arrives → MINE", () => {
    const { rt, kernel, st } = gotoBot({ x: 5, y: 64, z: 0 });
    for (let x = 0; x <= 5; x++) rt.setBlock(x, 63, 0, "minecraft:stone"); // floor to walk
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    kernel.tick(st); // greedy drives toward the target — still en route
    expect(st.phase).toBe("GOTO");
    expect(rt.state.keys["key.forward"]).toBe(true); // walking, not idle
    rt.setPos({ x: 5, y: 64, z: 0 }); // simulate arrival at the stand pos
    kernel.tick(st);
    expect(st.phase).toBe("MINE");
  });

  it("no stand pos → back to SCAN", () => {
    const { kernel, st } = gotoBot(null);
    kernel.tick(st);
    expect(st.phase).toBe("SCAN");
  });

  it("times out to SCAN when never arriving", () => {
    const { rt, kernel, st } = gotoBot({ x: 8, y: 64, z: 0 }, { nav: { gotoTimeoutTicks: 5 } });
    for (let x = 0; x <= 10; x++) rt.setBlock(x, 63, 0, "minecraft:stone"); // floor → greedy keeps walking
    rt.setPos({ x: 0.5, y: 64, z: 0.5 }); // mock pos never advances → greedy walks but never arrives
    for (let i = 0; i < 7; i++) kernel.tick(st);
    expect(st.phase).toBe("SCAN");
  });
});

describe("loot diversion", () => {
  it("diverts to LOOT for a priority item, then returns to the prior phase", () => {
    const { rt, kernel, st } = bot([loot], { loot: { scanInterval: 1, scanRadius: 8 } });
    st.running = true;
    st.phase = "SCAN";
    rt.state.items = [{ x: 1, y: 64, z: 0, id: "gtceu:iron_ore", count: 1 }];
    kernel.tick(st); // guard sees the ore → LOOT
    expect(st.phase).toBe("LOOT");
    kernel.tick(st); // entity still in the world → verified pickup keeps the phase alive
    expect(st.phase).toBe("LOOT");
    rt.state.items = []; // the entity despawns into the bag → NOW the divert completes
    kernel.tick(st);
    expect(st.phase).toBe("SCAN");
  });

  it("ignores non-priority drops", () => {
    const { rt, kernel, st } = bot([loot], { loot: { scanInterval: 1, scanRadius: 8 } });
    st.running = true;
    st.phase = "SCAN";
    rt.state.items = [{ x: 1, y: 64, z: 0, id: "minecraft:cobblestone", count: 1 }];
    kernel.tick(st);
    expect(st.phase).toBe("SCAN");
  });
});
