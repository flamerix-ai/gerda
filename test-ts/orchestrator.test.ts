import { makeOrchestrator } from "@/bot/orchestrator";
import type { Plan, StepGuardSpec } from "@/bot/orchestrator/plan";
// Orchestrator (meta-mission) — chains missions into a plan, autonomously or
// AI-stepped, gated by guards, feeding one step's outputs into the next's params.
// Uses tiny instant-complete test missions so completion is deterministic.
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { createMockRuntime } from "@/core/runtime/mock";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogSink, Logger } from "@/shared/kernel/logger";
import type { Mission } from "@/shared/kernel/mission";
import { describe, expect, it } from "vitest";

const sink: LogSink = { emit: () => {} };

// Records the order missions are started (and with what params). Each test mission
// completes on its first tick (isDone → true), so a plan drains one step per tick.
function recorder(): {
  started: { name: string; params: Record<string, unknown> }[];
  mission: (name: string, outputs?: Record<string, unknown>) => Mission;
  failMission: (name: string) => Mission;
} {
  const started: { name: string; params: Record<string, unknown> }[] = [];
  const mission = (name: string, outputs?: Record<string, unknown>): Mission => ({
    name,
    edges: {},
    initialPhase: "SCAN",
    handlers: {},
    init: (_ctx, params) => started.push({ name, params }),
    isDone: () => true,
    ...(outputs ? { outputs: () => outputs } : {}),
  });
  // A mission that terminally fails: its SCAN handler transitions to ERROR (never isDone).
  const failMission = (name: string): Mission => ({
    name,
    edges: {},
    initialPhase: "SCAN",
    handlers: { SCAN: (ctx) => ctx.transition("ERROR", "boom") },
    init: (_ctx, params) => started.push({ name, params }),
  });
  return { started, mission, failMission };
}

function bot(plans: Plan[], missions: Mission[]): { kernel: Kernel; st: BotState } {
  const rt = createMockRuntime();
  const kernel = new Kernel(
    rt,
    new Logger(sink, "ERR"),
    new Bus(),
    makeGerdaConfig(),
    GERDA_PHASES,
  );
  for (const m of missions) kernel.registerMission(m);
  const orch = makeOrchestrator(kernel, plans);
  kernel.register(orch.cap).setSequencer(orch.sequencer);
  const st = makeInitialState();
  kernel.init(st);
  return { kernel, st };
}

const FAIL_GUARD: StepGuardSpec = {
  name: "always-fail",
  check: () => ({ ok: false, reason: "nope" }),
};

describe("orchestrator — autonomous", () => {
  it("chains every step in order, then completes → IDLE", () => {
    const { started, mission } = recorder();
    const plan: Plan = {
      name: "p",
      defaultMode: "auto",
      steps: [{ mission: "a" }, { mission: "b" }, { mission: "c" }],
    };
    const { kernel, st } = bot([plan], [mission("a"), mission("b"), mission("c")]);

    kernel.command(st, { type: "plan_start", name: "p" });
    expect(started.map((s) => s.name)).toEqual(["a"]); // step 0 started

    kernel.tick(st); // a done → b
    kernel.tick(st); // b done → c
    kernel.tick(st); // c done → plan done → IDLE

    expect(started.map((s) => s.name)).toEqual(["a", "b", "c"]);
    expect(kernel.activeMission()).toBeNull();
    expect(st.phase).toBe("IDLE");
  });

  it("feeds a step's outputs into the next step's param binding", () => {
    const { started, mission } = recorder();
    const plan: Plan = {
      name: "p",
      defaultMode: "auto",
      steps: [{ mission: "a" }, { mission: "b", params: (prev) => ({ coord: prev["x"] }) }],
    };
    const { kernel, st } = bot([plan], [mission("a", { x: 5 }), mission("b")]);

    kernel.command(st, { type: "plan_start", name: "p" });
    kernel.tick(st); // a done → b started with bound params

    expect(started[1]?.name).toBe("b");
    expect(started[1]?.params).toEqual({ coord: 5 });
  });

  it("a failing guard blocks the chain (the mission never starts)", () => {
    const { started, mission } = recorder();
    const plan: Plan = {
      name: "p",
      defaultMode: "auto",
      steps: [{ mission: "a", guards: [FAIL_GUARD] }],
    };
    const { kernel, st } = bot([plan], [mission("a")]);

    kernel.command(st, { type: "plan_start", name: "p" });
    expect(started).toEqual([]);
    expect(kernel.activeMission()).toBeNull();
  });

  it("an unknown mission in a plan fails the plan, not the worker", () => {
    const { mission } = recorder();
    const plan: Plan = { name: "p", defaultMode: "auto", steps: [{ mission: "ghost" }] };
    const { kernel, st } = bot([plan], [mission("a")]);
    expect(() => kernel.command(st, { type: "plan_start", name: "p" })).not.toThrow();
    expect(kernel.activeMission()).toBeNull();
  });
});

describe("orchestrator — control flow (branch / loop / retry)", () => {
  it("repeat: re-runs a step N times before advancing", () => {
    const { started, mission } = recorder();
    const plan: Plan = {
      name: "p",
      defaultMode: "auto",
      steps: [{ mission: "a", repeat: 3 }, { mission: "b" }],
    };
    const { kernel, st } = bot([plan], [mission("a"), mission("b")]);

    kernel.command(st, { type: "plan_start", name: "p" });
    for (let i = 0; i < 6 && kernel.activeMission() !== null; i++) kernel.tick(st);

    expect(started.map((s) => s.name)).toEqual(["a", "a", "a", "b"]);
    expect(st.phase).toBe("IDLE");
  });

  it("repeatWhile: loops a step while its guard passes", () => {
    const { started, mission } = recorder();
    let runs = 0;
    const guard: StepGuardSpec = {
      name: "twice",
      check: () => (runs++ < 2 ? { ok: true } : { ok: false, reason: "done" }),
    };
    const plan: Plan = {
      name: "p",
      defaultMode: "auto",
      steps: [{ mission: "a", repeatWhile: guard }, { mission: "b" }],
    };
    const { kernel, st } = bot([plan], [mission("a"), mission("b")]);

    kernel.command(st, { type: "plan_start", name: "p" });
    for (let i = 0; i < 8 && kernel.activeMission() !== null; i++) kernel.tick(st);

    // a runs, then loops while guard ok (2 more), then b.
    expect(started.filter((s) => s.name === "a").length).toBe(3);
    expect(started[started.length - 1]?.name).toBe("b");
  });

  it("next: branches to a chosen step id from the outputs", () => {
    const { started, mission } = recorder();
    const plan: Plan = {
      name: "p",
      defaultMode: "auto",
      steps: [
        { mission: "a", next: (prev) => (prev["go"] === "skip" ? "target" : undefined) },
        { mission: "b" }, // should be skipped
        { mission: "c", id: "target" },
      ],
    };
    const { kernel, st } = bot([plan], [mission("a", { go: "skip" }), mission("b"), mission("c")]);

    kernel.command(st, { type: "plan_start", name: "p" });
    for (let i = 0; i < 6 && kernel.activeMission() !== null; i++) kernel.tick(st);

    expect(started.map((s) => s.name)).toEqual(["a", "c"]); // b skipped
  });

  it("next returning null finishes the plan early", () => {
    const { started, mission } = recorder();
    const plan: Plan = {
      name: "p",
      defaultMode: "auto",
      steps: [{ mission: "a", next: () => null }, { mission: "b" }],
    };
    const { kernel, st } = bot([plan], [mission("a"), mission("b")]);

    kernel.command(st, { type: "plan_start", name: "p" });
    for (let i = 0; i < 4 && kernel.activeMission() !== null; i++) kernel.tick(st);

    expect(started.map((s) => s.name)).toEqual(["a"]);
    expect(st.phase).toBe("IDLE");
  });

  it("retries: re-runs a failing step up to N times, then fails the plan", () => {
    const { started, failMission } = recorder();
    const plan: Plan = { name: "p", defaultMode: "auto", steps: [{ mission: "a", retries: 2 }] };
    const { kernel, st } = bot([plan], [failMission("a")]);

    kernel.command(st, { type: "plan_start", name: "p" });
    for (let i = 0; i < 12 && kernel.activeMission() !== null; i++) kernel.tick(st);

    expect(started.filter((s) => s.name === "a").length).toBe(3); // initial + 2 retries
    expect(kernel.activeMission()).toBeNull(); // plan failed → mission aborted
  });

  it("onFail: branches to a recovery step once retries are exhausted", () => {
    const { started, mission, failMission } = recorder();
    const plan: Plan = {
      name: "p",
      defaultMode: "auto",
      steps: [
        { mission: "a", retries: 1, onFail: "rescue" },
        { mission: "r", id: "rescue" },
      ],
    };
    const { kernel, st } = bot([plan], [failMission("a"), mission("r")]);

    kernel.command(st, { type: "plan_start", name: "p" });
    for (let i = 0; i < 12 && kernel.activeMission() !== null; i++) kernel.tick(st);

    expect(started.filter((s) => s.name === "a").length).toBe(2); // initial + 1 retry
    expect(started.some((s) => s.name === "r")).toBe(true); // jumped to rescue
  });
});

describe("orchestrator — AI-stepped (approve)", () => {
  it("parks between steps until proceed", () => {
    const { started, mission } = recorder();
    const plan: Plan = {
      name: "p",
      defaultMode: "approve",
      steps: [{ mission: "a" }, { mission: "b" }],
    };
    const { kernel, st } = bot([plan], [mission("a"), mission("b")]);

    kernel.command(st, { type: "plan_start", name: "p" });
    expect(started).toEqual([]); // parked before step 0

    kernel.command(st, { type: "proceed" });
    expect(started.map((s) => s.name)).toEqual(["a"]);

    kernel.tick(st); // a done → parks before b (does NOT auto-start)
    expect(started.map((s) => s.name)).toEqual(["a"]);
    expect(kernel.activeMission()).toBeNull();

    kernel.command(st, { type: "proceed" });
    expect(started.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("`run` flips an approve plan to drain autonomously", () => {
    const { started, mission } = recorder();
    const plan: Plan = {
      name: "p",
      defaultMode: "approve",
      steps: [{ mission: "a" }, { mission: "b" }],
    };
    const { kernel, st } = bot([plan], [mission("a"), mission("b")]);

    kernel.command(st, { type: "plan_start", name: "p" });
    kernel.command(st, { type: "run" }); // start a + auto from here
    expect(started.map((s) => s.name)).toEqual(["a"]);
    kernel.tick(st); // a done → b auto
    expect(started.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("`select {mission}` runs an ad-hoc mission, then hands back to approval", () => {
    const { started, mission } = recorder();
    const plan: Plan = { name: "p", defaultMode: "approve", steps: [{ mission: "a" }] };
    const { kernel, st } = bot([plan], [mission("a"), mission("z")]);

    kernel.command(st, { type: "plan_start", name: "p" });
    kernel.command(st, { type: "select", mission: "z", params: { foo: 1 } });
    expect(started.map((s) => s.name)).toEqual(["z"]);
    expect(started[0]?.params).toEqual({ foo: 1 });

    kernel.tick(st); // z done → back to awaiting-approval, plan cursor untouched
    expect(kernel.activeMission()).toBeNull();
    kernel.command(st, { type: "proceed" }); // now runs plan step 0
    expect(started.map((s) => s.name)).toEqual(["z", "a"]);
  });
});

describe("orchestrator — status replies", () => {
  it("plan_status replies with the cursor, status, blocked reason and active mission", () => {
    const { mission } = recorder();
    const plan: Plan = {
      name: "p",
      defaultMode: "auto",
      steps: [{ mission: "a" }, { mission: "b" }],
    };
    const { kernel, st } = bot([plan], [mission("a"), mission("b")]);
    kernel.command(st, { type: "plan_start", name: "p" });
    kernel.command(st, { type: "plan_status" });
    expect(kernel.lastCommandOutcome()?.data).toMatchObject({
      plan: "p",
      cursor: 0,
      currentStep: "a",
      activeMission: "a",
    });
    expect(kernel.lastCommandOutcome()?.data).toHaveProperty("status");
    expect(kernel.lastCommandOutcome()?.data).toHaveProperty("blockedReason");
  });

  it("plans replies with the plan names", () => {
    const plan: Plan = { name: "p", defaultMode: "auto", steps: [{ mission: "a" }] };
    const { kernel, st } = bot([plan], [recorder().mission("a")]);
    kernel.command(st, { type: "plans" });
    expect(kernel.lastCommandOutcome()?.data).toEqual({ available: ["p"] });
  });
});
