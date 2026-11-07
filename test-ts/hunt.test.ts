// hunt mission + domain — lock the nearest huntable mob, chase it, melee it on a swing
// cooldown until it leaves the snapshot (killed), loop to a kill-count, then end. Movement is
// short-circuited by seeding the mob within melee reach (greedy nav is exercised in its own
// suite + live); here we lock the SEEK→CHASE→STRIKE→kill→loop logic on the mock. The mock's
// interact.attack() damages the mob nearest the lookAt aim and removes it at 0 health, so the
// strike loop converges exactly as the real crosshair attack does against world.mobs().
import { core } from "@/bot/capabilities/core";
import { huntMission } from "@/bot/missions/hunt";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import type { Mob } from "@/core/runtime/Runtime";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import { isHuntable, pickTarget } from "@/shared/domain/hunt";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogRecord, type LogSink, Logger } from "@/shared/kernel/logger";
import { resetGreedyNav } from "@/shared/nav";
import { describe, expect, it } from "vitest";

function mob(type: string, uuid: string, x: number, y: number, z: number, health = 8): Mob {
  return { type, uuid, x, y, z, health, distance: 0 };
}

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
  kernel.register(core).registerMission(huntMission);
  const state = makeInitialState();
  kernel.init(state);
  return { kernel, st: state, logs };
}

const ev = (logs: LogRecord[], name: string) => logs.find((l) => l.event === name);
const evs = (logs: LogRecord[], name: string) => logs.filter((l) => l.event === name);

describe("hunt domain", () => {
  const huntable = new Set(["minecraft:cow", "minecraft:pig"]);

  it("isHuntable is an exact whitelist match", () => {
    expect(isHuntable("minecraft:cow", huntable)).toBe(true);
    expect(isHuntable("minecraft:bat", huntable)).toBe(false);
  });

  it("pickTarget returns the nearest huntable, skipping non-huntable and dead", () => {
    const mobs: Mob[] = [
      { ...mob("minecraft:bat", "b", 1, 64, 0), distance: 1 }, // not huntable
      { ...mob("minecraft:cow", "far", 10, 64, 0), distance: 10 },
      { ...mob("minecraft:pig", "near", 3, 64, 0), distance: 3 },
      { ...mob("minecraft:cow", "dead", 2, 64, 0, 0), distance: 2 }, // dead
    ];
    expect(pickTarget(mobs, huntable)?.uuid).toBe("near");
    expect(pickTarget([], huntable)).toBeNull();
    expect(pickTarget([mobs[0] as Mob], huntable)).toBeNull(); // only a bat
  });
  // The generic pursuit primitives (byUuid / withinRange / approachCell) that hunt used to
  // own are now shared with follow — covered in pursuit.test.ts.
});

describe("hunt mission", () => {
  it("chases an in-reach mob, strikes it to death, counts the kill, and ends at the goal", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    rt.setPos({ x: 0, y: 64, z: 0 });
    rt.state.mobs = [mob("minecraft:cow", "cow-1", 2, 64, 0, 8)]; // in reach (dist 2 ≤ cfg.hunt.reach 3)
    const { kernel, st, logs } = bot(rt);

    kernel.startMission(st, "hunt", { count: 1 });
    for (let i = 0; i < 80 && kernel.activeMission() !== null; i++) kernel.tick(st);

    // It locked the target, struck it (multiple swings on the cooldown), and killed it.
    expect(ev(logs, "HUNT_TARGET")?.fields).toMatchObject({ type: "minecraft:cow" });
    expect(evs(logs, "HUNT_STRIKE").length).toBeGreaterThanOrEqual(1);
    expect(ev(logs, "HUNT_KILL")?.fields).toMatchObject({ kills: 1, goal: 1 });
    expect(rt.state.attackCalls).toBeGreaterThanOrEqual(2); // 8 hp / 4-per-hit = 2 swings
    expect(rt.state.mobs.length).toBe(0); // the mob was removed (killed)
    expect(kernel.activeMission()).toBeNull(); // goal met → mission ended
  });

  it("ends gracefully (no ERROR) when there is nothing huntable", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    rt.setPos({ x: 0, y: 64, z: 0 });
    rt.state.mobs = [mob("minecraft:bat", "bat-1", 2, 64, 0)]; // not in the huntable set
    const { kernel, st, logs } = bot(rt);

    // Must outlast cfg.hunt.seekGraceTicks (40) — a single empty read no longer aborts.
    kernel.startMission(st, "hunt", { count: 0 });
    for (let i = 0; i < 60 && kernel.activeMission() !== null; i++) kernel.tick(st);

    expect(ev(logs, "HUNT_NO_TARGETS")).toBeTruthy();
    expect(ev(logs, "HUNT_KILL")).toBeUndefined();
    expect(st.phase).not.toBe("ERROR");
    expect(kernel.activeMission()).toBeNull();
  });

  it("kills two mobs in sequence when the goal is 2", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    rt.setPos({ x: 0, y: 64, z: 0 });
    rt.state.mobs = [
      mob("minecraft:pig", "pig-1", 2, 64, 0, 4), // one hit each
      mob("minecraft:pig", "pig-2", 2, 64, 1, 4),
    ];
    const { kernel, st, logs } = bot(rt);

    kernel.startMission(st, "hunt", { count: 2 });
    for (let i = 0; i < 160 && kernel.activeMission() !== null; i++) kernel.tick(st);

    expect(evs(logs, "HUNT_KILL").length).toBe(2);
    expect(rt.state.mobs.length).toBe(0);
    expect(kernel.activeMission()).toBeNull();
  });
});
