import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { CoreFatalError } from "@/core/prim/invariant";
import { createMockRuntime } from "@/core/runtime/mock";
import { Bus } from "@/shared/kernel/bus";
import { type Capability, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { Lifecycle } from "@/shared/kernel/lifecycle";
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

describe("Kernel", () => {
  it("routes a handler for the current phase", () => {
    const seen: string[] = [];
    const cap: Capability = {
      name: "t",
      handlers: { SCAN: (ctx) => seen.push(`scan@${ctx.st.tickCount}`) },
    };
    const k = mk().register(cap);
    const st = makeInitialState();
    st.running = true;
    st.phase = "SCAN";
    k.tick(st);
    expect(seen).toEqual(["scan@1"]);
  });

  it("a guard short-circuits phase dispatch", () => {
    let handlerRan = false;
    const cap: Capability = {
      name: "t",
      guard: () => true,
      handlers: {
        SCAN: () => {
          handlerRan = true;
        },
      },
    };
    const k = mk().register(cap);
    const st = makeInitialState();
    st.running = true;
    st.phase = "SCAN";
    k.tick(st);
    expect(handlerRan).toBe(false);
  });

  it("rejects two capabilities owning the same phase", () => {
    const a: Capability = { name: "a", handlers: { MINE: () => {} } };
    const b: Capability = { name: "b", handlers: { MINE: () => {} } };
    expect(() => mk().register(a).register(b)).toThrow(/already owned/);
  });

  it("a CORE handler that throws halts loudly (CoreFatalError), never limps on", () => {
    const cap: Capability = {
      name: "boom",
      handlers: {
        SCAN: () => {
          throw new Error("kaboom");
        },
      },
    };
    const k = mk().register(cap);
    const st = makeInitialState();
    st.running = true;
    st.phase = "SCAN";
    // A global/core owner throwing is an unrecoverable bug → the kernel rethrows so
    // worker.js can halt + publish the fatal status (it does NOT silently → ERROR).
    expect(() => k.tick(st)).toThrowError(CoreFatalError);
  });

  it("a MISSION handler that throws drops the mission to ERROR, core stays alive", () => {
    const mission: Mission = {
      name: "boomMission",
      edges: { SCAN: ["MINE"] },
      initialPhase: "SCAN",
      handlers: {
        SCAN: () => {
          throw new Error("mission kaboom");
        },
      },
    };
    const k = mk().registerMission(mission);
    const st = makeInitialState();
    k.startMission(st, "boomMission");
    expect(st.phase).toBe("SCAN");
    k.tick(st); // does NOT throw — mission isolation
    expect(st.phase).toBe("ERROR");
  });

  it("does not tick handlers while stopped", () => {
    let ran = false;
    const cap: Capability = {
      name: "t",
      handlers: {
        SCAN: () => {
          ran = true;
        },
      },
    };
    const k = mk().register(cap);
    const st = makeInitialState();
    st.phase = "SCAN"; // running stays false
    k.tick(st);
    expect(ran).toBe(false);
    expect(st.tickCount).toBe(1); // tick still counted
  });
});

describe("Lifecycle", () => {
  it("disposes all registered teardowns, LIFO, and survives throwers", () => {
    const order: number[] = [];
    const lc = new Lifecycle();
    lc.add(() => order.push(1));
    lc.add(() => {
      throw new Error("noisy teardown");
    });
    lc.add(() => order.push(3));
    expect(lc.size()).toBe(3);
    lc.disposeAll();
    expect(order).toEqual([3, 1]);
    expect(lc.size()).toBe(0);
  });
});

describe("Kernel mission completion", () => {
  // A goto that arrived logged MISSION_ABORT right after GOTO_ARRIVED, and telemetry counted
  // every completion in mission_aborted_total as well as mission_done_total.
  it("a mission that reaches its goal ends as DONE, not as an abort", () => {
    const lines: string[] = [];
    const bus = new Bus();
    const k = new Kernel(
      createMockRuntime(),
      new Logger({ emit: (l) => lines.push(l) }, "INFO"),
      bus,
      makeGerdaConfig(),
      GERDA_PHASES,
    );
    let cleanedUp = 0;
    const m: Mission = {
      name: "once",
      edges: {},
      initialPhase: "SCAN",
      handlers: {},
      isDone: () => true,
      onAbort: () => {
        cleanedUp++;
      },
    };
    k.registerMission(m);
    const seen: string[] = [];
    bus.on("missionDone", () => seen.push("done"));
    bus.on("missionAborted", () => seen.push("aborted"));
    const st = makeInitialState();
    k.init(st);
    k.startMission(st, "once");
    k.tick(st);
    const events = lines.map((l) => (JSON.parse(l) as { event: string }).event);
    expect(events).toContain("MISSION_DONE");
    expect(events).not.toContain("MISSION_ABORT");
    expect(seen).toEqual(["done"]);
    expect(cleanedUp).toBe(1); // the cleanup still runs
    expect(st.phase).toBe("IDLE");
  });

  it("NEG-CONTROL: an explicit abort is still MISSION_ABORT + missionAborted", () => {
    const lines: string[] = [];
    const bus = new Bus();
    const k = new Kernel(
      createMockRuntime(),
      new Logger({ emit: (l) => lines.push(l) }, "INFO"),
      bus,
      makeGerdaConfig(),
      GERDA_PHASES,
    );
    k.registerMission({ name: "long", edges: {}, initialPhase: "SCAN", handlers: {} });
    const seen: string[] = [];
    bus.on("missionAborted", () => seen.push("aborted"));
    const st = makeInitialState();
    k.init(st);
    k.startMission(st, "long");
    k.abortMission(st);
    expect(lines.map((l) => (JSON.parse(l) as { event: string }).event)).toContain("MISSION_ABORT");
    expect(seen).toEqual(["aborted"]);
  });
});
