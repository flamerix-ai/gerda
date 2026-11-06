// Mission machinery: activate, abort, switch, self-complete. Proves the kernel runs
// ONE pluggable mission at a time, swappable at runtime with no reload —
// the universality guarantee the mine refactor rests on. Uses tiny synthetic missions
// (built on existing states) plus the real mine mission to confirm it activates.
import { makeMissionControl } from "@/bot/capabilities/mission-control";
import { mineMission } from "@/bot/missions/mine";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { createMockRuntime } from "@/core/runtime/mock";
import { Bus } from "@/shared/kernel/bus";
import { Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogSink, Logger } from "@/shared/kernel/logger";
import type { Mission } from "@/shared/kernel/mission";
import { describe, expect, it } from "vitest";

const sink: LogSink = { emit: () => {} };
const mk = () =>
  new Kernel(
    createMockRuntime(),
    new Logger(sink, "ERR"),
    new Bus(),
    makeGerdaConfig(),
    GERDA_PHASES,
  );

// A synthetic mission whose SCAN handler stamps the blackboard, so we can tell which
// mission's handler ran after a switch.
function stampMission(name: string): Mission {
  return {
    name,
    edges: { SCAN: ["MINE"], MINE: ["SCAN"] },
    initialPhase: "SCAN",
    handlers: {
      SCAN(ctx): void {
        ctx.st.bb["stamp"] = name;
      },
    },
  };
}

describe("mission machinery", () => {
  it("startMission seeds the initial phase + running and reports active", () => {
    const k = mk().registerMission(stampMission("a"));
    const st = makeInitialState();
    k.startMission(st, "a");
    expect(st.running).toBe(true);
    expect(st.phase).toBe("SCAN");
    expect(k.activeMission()).toBe("a");
  });

  it("throws on an unknown mission", () => {
    const k = mk();
    expect(() => k.startMission(makeInitialState(), "nope")).toThrow(/unknown mission/);
  });

  it("abortMission collapses to IDLE, stops, and clears active", () => {
    const k = mk().registerMission(stampMission("a"));
    const st = makeInitialState();
    k.startMission(st, "a");
    k.abortMission(st);
    expect(st.phase).toBe("IDLE");
    expect(st.running).toBe(false);
    expect(k.activeMission()).toBeNull();
  });

  it("starting a second mission aborts the first; handlers swap", () => {
    const k = mk().registerMission(stampMission("a")).registerMission(stampMission("b"));
    const st = makeInitialState();
    k.startMission(st, "a");
    k.tick(st);
    expect(st.bb["stamp"]).toBe("a");
    k.startMission(st, "b"); // aborts a, activates b (also SCAN)
    expect(k.activeMission()).toBe("b");
    k.tick(st);
    expect(st.bb["stamp"]).toBe("b");
  });

  it("mission commands dispatch only while their mission is active", () => {
    const counter = { n: 0 };
    const cmdMission: Mission = {
      name: "c",
      edges: { SCAN: [] },
      initialPhase: "SCAN",
      handlers: {},
      commands: {
        bump(): void {
          counter.n++;
        },
      },
    };
    const k = mk().registerMission(cmdMission);
    const st = makeInitialState();

    k.command(st, { type: "bump" }); // not active → no handler
    expect(counter.n).toBe(0);

    k.startMission(st, "c");
    k.command(st, { type: "bump" });
    expect(counter.n).toBe(1);

    k.abortMission(st);
    k.command(st, { type: "bump" }); // mission gone → no handler
    expect(counter.n).toBe(1);
  });

  it("isDone collapses the mission to IDLE after the tick", () => {
    const doneMission: Mission = {
      name: "d",
      edges: { SCAN: [] },
      initialPhase: "SCAN",
      handlers: {
        SCAN(ctx): void {
          ctx.st.bb["ticks"] = ((ctx.st.bb["ticks"] as number) ?? 0) + 1;
        },
      },
      isDone: (ctx) => ((ctx.st.bb["ticks"] as number) ?? 0) >= 2,
    };
    const k = mk().registerMission(doneMission);
    const st = makeInitialState();
    k.startMission(st, "d");
    k.tick(st); // ticks=1, not done
    expect(k.activeMission()).toBe("d");
    k.tick(st); // ticks=2 → isDone → abort
    expect(k.activeMission()).toBeNull();
    expect(st.phase).toBe("IDLE");
    expect(st.running).toBe(false);
  });

  it("mission_start / mission_abort flow through the command dispatch path", () => {
    const k = mk(); // mission-control closes over the kernel, so build it first
    k.register(makeMissionControl(k)).registerMission(stampMission("a"));
    const st = makeInitialState();
    k.command(st, { type: "mission_start", name: "a" });
    expect(k.activeMission()).toBe("a");
    expect(st.phase).toBe("SCAN");
    k.command(st, { type: "mission_abort" });
    expect(k.activeMission()).toBeNull();
  });

  it("mission_status / missions reply with structured data on the command outcome", () => {
    const k = mk();
    k.register(makeMissionControl(k)).registerMission(stampMission("a"));
    const st = makeInitialState();

    k.command(st, { type: "mission_status" });
    expect(k.lastCommandOutcome()?.data).toEqual({
      active: null,
      phase: st.phase,
      running: false,
      drill: null, // no drill slice → no vein target exposed (fleet hub observation feed)
    });

    k.command(st, { type: "mission_start", name: "a" });
    k.command(st, { type: "mission_status" });
    expect(k.lastCommandOutcome()?.data).toMatchObject({ active: "a", running: true });

    k.command(st, { type: "missions" });
    expect(k.lastCommandOutcome()?.data).toEqual({ available: ["a"] });

    // A command that doesn't reply leaves data absent (reset per dispatch).
    k.command(st, { type: "mission_abort" });
    expect(k.lastCommandOutcome()?.data).toBeUndefined();
  });

  it("the real mine mission activates into SCAN", () => {
    const k = mk().registerMission(mineMission);
    const st = makeInitialState();
    k.startMission(st, "mine");
    expect(k.activeMission()).toBe("mine");
    expect(st.phase).toBe("SCAN");
    expect(st.running).toBe(true);
  });
});
