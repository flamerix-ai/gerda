// Kernel-level tests for the universal progress contract. The contract is the ONE
// watchdog that kills the "silent wedge" bug class: a running phase whose progress signature is
// frozen past its budget is escalated LOUDLY (PHASE_STALLED log + phaseStalled event) and its
// per-phase disposition runs. These tests pin the detection timing, the exemption mechanism, and
// each disposition (pause/error/recover/{handle} skip) — plus the feet-position backstop that a
// phase declaring nothing (including a handler-less wedge) still gets.
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { createMockRuntime } from "@/core/runtime/mock";
import { type BotEvents, Bus } from "@/shared/kernel/bus";
import { type Capability, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogSink, Logger } from "@/shared/kernel/logger";
import type { Mission } from "@/shared/kernel/mission";
import {
  PROGRESS_PAUSE,
  type ProgressPause,
  type ProgressPolicy,
  type StallDisposition,
} from "@/shared/kernel/progress";
import { beforeEach, describe, expect, it } from "vitest";

// A collecting log sink so a test can assert the loud PHASE_STALLED line was written. The sink
// receives an already-formatted line string, so we match PHASE_STALLED as a substring.
function collector(): { sink: LogSink; lines: string[] } {
  const lines: string[] = [];
  return { sink: { emit: (line) => lines.push(line) }, lines };
}

// Build a single-phase MINE mission with a controllable progress signature. MINE is a movement
// (non-exempt) phase, and its edges reach PAUSED/ERROR/RECOVER via UNIVERSAL_TARGETS + a MINE→SCAN
// edge for the skip disposition. `signature` is called each tick; `onStall`/`monotonic` shape it.
function stallMission(opts: {
  signature: (tick: number) => number | string | ProgressPause | null;
  onStall?: StallDisposition;
  monotonic?: boolean;
  budgetTicks?: number;
}): Mission {
  const pol: ProgressPolicy = {
    name: "test",
    signature: (ctx) => opts.signature(ctx.st.tickCount),
    budgetTicks: () => opts.budgetTicks ?? 5,
    ...(opts.monotonic !== undefined ? { monotonic: opts.monotonic } : {}),
    ...(opts.onStall !== undefined ? { onStall: opts.onStall } : {}),
  };
  return {
    name: "stallTest",
    edges: { MINE: ["SCAN"] },
    initialPhase: "MINE",
    handlers: { MINE: () => {} }, // a no-op handler — the phase is HANDLED, not handler-less
    progress: { MINE: pol },
  };
}

describe("progress contract — detection timing", () => {
  let bus: Bus;
  let events: BotEvents["phaseStalled"][];
  let lines: string[];
  let k: Kernel;

  beforeEach(() => {
    bus = new Bus();
    events = [];
    bus.on("phaseStalled", (e) => events.push(e));
    const c = collector();
    lines = c.lines;
    k = new Kernel(
      createMockRuntime(),
      new Logger(c.sink, "WARN"),
      bus,
      makeGerdaConfig(),
      GERDA_PHASES,
    );
  });

  it("fires PHASE_STALLED after exactly the budget of frozen ticks — not before", () => {
    // Frozen signature (a constant). Seeded on tick 1 (since=1); the watchdog fires when
    // tickCount - since > budget, i.e. the first tick where tickCount = budget + 2.
    const budget = 5;
    k.registerMission(stallMission({ signature: () => 42, budgetTicks: budget }));
    const st = makeInitialState();
    k.startMission(st, "stallTest");

    for (let i = 0; i < budget + 1; i++) k.tick(st); // ticks 1..budget+1
    expect(events).toHaveLength(0); // still within budget — NOT yet stalled
    expect(st.phase).toBe("MINE");

    k.tick(st); // tick budget+2 → tickCount-since = budget+1 > budget → STALL
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ phase: "MINE", policy: "test", budget });
    expect(lines.some((l) => l.includes("PHASE_STALLED"))).toBe(true); // loud, never silent
    expect(st.phase).toBe("PAUSED"); // default disposition
  });

  it("never fires while the signature advances every tick", () => {
    // A signature that changes each tick is progress — the clock resets, the watchdog can't fire.
    k.registerMission(stallMission({ signature: (t) => t, budgetTicks: 5 }));
    const st = makeInitialState();
    k.startMission(st, "stallTest");
    for (let i = 0; i < 100; i++) k.tick(st);
    expect(events).toHaveLength(0);
    expect(st.phase).toBe("MINE");
  });

  it("a null signature EXEMPTS the tick — a legitimate hold never false-fires", () => {
    // The follow-HOLD / on-column-descend / peer-lost-wait pattern: standing still is correct, so
    // the policy returns null. The clock resets every tick; the watchdog can never fire.
    k.registerMission(stallMission({ signature: () => null, budgetTicks: 5 }));
    const st = makeInitialState();
    k.startMission(st, "stallTest");
    for (let i = 0; i < 100; i++) k.tick(st);
    expect(events).toHaveLength(0);
    expect(st.phase).toBe("MINE");
  });

  // PROGRESS_PAUSE interleaved with a FROZEN signature at several rates: the paused ticks are left out
  // of the count (never fire early) but never re-arm the clock (fire once the counted ticks add up).
  it.each([2, 3, 5])(
    "PROGRESS_PAUSE on 1 tick in %i: not counted, never a reset — fires after budget COUNTED ticks",
    (every) => {
      const budget = 5;
      k.registerMission(
        stallMission({
          signature: (t) => (t % every === 0 ? PROGRESS_PAUSE : 42),
          budgetTicks: budget,
        }),
      );
      const st = makeInitialState();
      k.startMission(st, "stallTest");
      let counted = 0;
      let firedOnPause = false;
      for (let i = 0; i < 200 && events.length === 0; i++) {
        k.tick(st);
        const paused = st.tickCount % every === 0;
        if (!paused) counted++;
        if (events.length > 0) firedOnPause = paused;
      }
      expect(events).toHaveLength(1);
      expect(firedOnPause).toBe(false);
      // Same count as the all-frozen case above (fires on tick budget+2), paused ticks excluded.
      expect(counted).toBe(budget + 2);
    },
  );

  it("null on the same interleave is a RESET — the frozen run never adds up (why PAUSE exists)", () => {
    k.registerMission(
      stallMission({ signature: (t) => (t % 3 === 0 ? null : 42), budgetTicks: 5 }),
    );
    const st = makeInitialState();
    k.startMission(st, "stallTest");
    for (let i = 0; i < 200; i++) k.tick(st);
    expect(events).toHaveLength(0);
    expect(st.phase).toBe("MINE");
  });

  it("a long PROGRESS_PAUSE stretch mid-run neither fires nor counts; the frozen run resumes after it", () => {
    // Tick 1 captures the signature (the clock starts), ticks 2..pauseEnd pause, then it stays frozen.
    const budget = 5;
    const pauseEnd = 101;
    k.registerMission(
      stallMission({
        signature: (t) => (t >= 2 && t <= pauseEnd ? PROGRESS_PAUSE : 42),
        budgetTicks: budget,
      }),
    );
    const st = makeInitialState();
    k.startMission(st, "stallTest");
    for (let i = 0; i < pauseEnd; i++) k.tick(st);
    expect(events).toHaveLength(0); // ~20× the budget of paused ticks never fires
    let after = 0;
    while (events.length === 0 && after < 50) {
      k.tick(st);
      after++;
    }
    expect(events).toHaveLength(1);
    // The clock stood still through the pause: the run fires on the same COUNTED tick as an
    // unpaused one (budget+2 counted ticks = tick 1 + budget+1 after the pause).
    expect(after).toBe(budget + 1);
  });

  it("monotonic: a non-improving numeric signature stalls; a strictly-improving one never does", () => {
    // The approach-toward-a-column case: greedy answers "moving" (signature keeps changing) while
    // the bot never gets CLOSER. A monotonic policy resets only on a strict gain, so a signature
    // that oscillates without improving is still a stall.
    let val = 10;
    k.registerMission(stallMission({ signature: () => val, monotonic: true, budgetTicks: 5 }));
    const st = makeInitialState();
    k.startMission(st, "stallTest");
    // Oscillate below the best-ever (10) — never a strict improvement.
    const seq = [8, 9, 7, 9, 8, 9, 7, 9, 8, 9];
    for (const v of seq) {
      val = v;
      k.tick(st);
    }
    expect(events).toHaveLength(1); // stalled — no strict gain in budget
    expect(events[0]?.phase).toBe("MINE");
  });

  it("monotonic: a strictly-increasing signature never stalls", () => {
    let val = 0;
    k.registerMission(stallMission({ signature: () => val, monotonic: true, budgetTicks: 5 }));
    const st = makeInitialState();
    k.startMission(st, "stallTest");
    for (let i = 0; i < 50; i++) {
      val += 1; // strict improvement every tick
      k.tick(st);
    }
    expect(events).toHaveLength(0);
    expect(st.phase).toBe("MINE");
  });
});

describe("progress contract — dispositions", () => {
  function run(
    onStall: StallDisposition,
    extra?: { handle?: () => void },
  ): {
    st: ReturnType<typeof makeInitialState>;
    k: Kernel;
    events: BotEvents["phaseStalled"][];
  } {
    const bus = new Bus();
    const events: BotEvents["phaseStalled"][] = [];
    bus.on("phaseStalled", (e) => events.push(e));
    const sink: LogSink = { emit: () => {} };
    const k = new Kernel(
      createMockRuntime(),
      new Logger(sink, "ERR"),
      bus,
      makeGerdaConfig(),
      GERDA_PHASES,
    );
    const disp: StallDisposition =
      typeof onStall === "object" ? { handle: () => extra?.handle?.() } : onStall;
    k.registerMission(stallMission({ signature: () => 1, onStall: disp, budgetTicks: 3 }));
    const st = makeInitialState();
    k.startMission(st, "stallTest");
    return { st, k, events };
  }

  it('"pause" (the default) → PAUSED, loud', () => {
    const { st, k, events } = run("pause");
    for (let i = 0; i < 5; i++) k.tick(st);
    expect(st.phase).toBe("PAUSED");
    expect(events).toHaveLength(1);
  });

  it('"error" → ERROR (opt-in hard fault)', () => {
    const { st, k, events } = run("error");
    for (let i = 0; i < 5; i++) k.tick(st);
    expect(st.phase).toBe("ERROR");
    expect(events).toHaveLength(1);
  });

  it('"recover" → RECOVER (teleport-out + backoff)', () => {
    const { st, k, events } = run("recover");
    for (let i = 0; i < 5; i++) k.tick(st);
    expect(st.phase).toBe("RECOVER");
    expect(events).toHaveLength(1);
  });

  it("{handle} skip → runs the mission's own recovery and re-arms in-phase", () => {
    // A skip-to-next-vein / offset→DIG_TO recovery: the handle advances the work unit and the phase
    // stays put (re-armed with a fresh budget), so a persistently-stuck phase skips repeatedly
    // rather than firing every tick or wedging.
    let skips = 0;
    const { st, k, events } = run({ handle: () => {} }, { handle: () => skips++ });
    for (let i = 0; i < 30; i++) k.tick(st);
    // budget 3 → first fire on tick 5, then re-armed every budget+1 ticks: multiple skips.
    expect(skips).toBeGreaterThan(1);
    expect(st.phase).toBe("MINE"); // stayed in-phase (the handle didn't transition)
    expect(events.length).toBeGreaterThan(1);
  });
});

describe("progress contract — feet backstop + exemption", () => {
  it("a handler-less non-exempt phase is caught by the feet backstop → PAUSED (never a silent tick)", () => {
    // The goto_waypoint wedge: a mission-scoped phase reached with no handler for it. It makes zero
    // progress; the universal feet-position DEFAULT policy escalates it within phaseStallTicks —
    // loud, recoverable, never an indefinite silent spin.
    const bus = new Bus();
    const events: BotEvents["phaseStalled"][] = [];
    bus.on("phaseStalled", (e) => events.push(e));
    const c = collector();
    // Small backstop budget so the test doesn't tick 1200 times; the mock's feet never move.
    const cfg = makeGerdaConfig({ safety: { phaseStallTicks: 4 } });
    const k = new Kernel(createMockRuntime(), new Logger(c.sink, "WARN"), bus, cfg, GERDA_PHASES);
    // Mission whose initial phase (MINE) has NO handler and NO progress policy.
    const mission: Mission = {
      name: "handlerless",
      edges: { MINE: ["SCAN"] },
      initialPhase: "MINE",
      handlers: {},
    };
    k.registerMission(mission);
    const st = makeInitialState();
    k.startMission(st, "handlerless");
    for (let i = 0; i < 10; i++) k.tick(st);
    expect(events).toHaveLength(1);
    expect(events[0]?.policy).toBe("feet"); // caught by the DEFAULT backstop
    expect(st.phase).toBe("PAUSED");
    expect(c.lines.some((l) => l.includes("PHASE_STALLED"))).toBe(true);
  });

  it("an exempt phase (SCAN) with a frozen position never false-fires", () => {
    // A legitimately-stationary phase (a spread-over-ticks scan, a container deposit) is in
    // STALL_EXEMPT — the feet backstop is suppressed even though its feet never move.
    const bus = new Bus();
    const events: BotEvents["phaseStalled"][] = [];
    bus.on("phaseStalled", (e) => events.push(e));
    const sink: LogSink = { emit: () => {} };
    const cap: Capability = { name: "scanner", handlers: { SCAN: () => {} } };
    const k = new Kernel(
      createMockRuntime(),
      new Logger(sink, "ERR"),
      bus,
      makeGerdaConfig({ safety: { phaseStallTicks: 4 } }),
      GERDA_PHASES,
    ).register(cap);
    const st = makeInitialState();
    st.running = true;
    st.phase = "SCAN";
    for (let i = 0; i < 50; i++) k.tick(st);
    expect(events).toHaveLength(0);
    expect(st.phase).toBe("SCAN");
  });
});
