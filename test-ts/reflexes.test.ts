// Reflex layer — mission-agnostic safety guards. Replaces safety.test.ts: the old
// safety→HOME emergency is now vitals/tool→RECOVER, plus the NEW air (drowning),
// stuck and hazard reflexes the legacy bot lacked. Each runs against a synthetic
// no-handler mission so phases don't drift under us — we're testing the GUARDS, and
// movementPhases (for stuck/human) come from the active mission.
import { core } from "@/bot/capabilities/core";
import { PERSIST_SLICE } from "@/bot/capabilities/persistence";
import { recover } from "@/bot/capabilities/recover";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { encodePos } from "@/core/prim/pos";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import type { ConfigOverrides } from "@/shared/config/schema";
import { makeWaypoint } from "@/shared/domain/waypoints";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type Level, type LogSink, Logger } from "@/shared/kernel/logger";
import type { Mission } from "@/shared/kernel/mission";
import { reflexes } from "@/shared/reflexes";
import { beforeEach, describe, expect, it } from "vitest";

const sink: LogSink = { emit: () => {} };

// A mission with NO handlers: phases change only via the reflexes under test.
// movementPhases mirror the mine mission so stuck/human behave realistically.
const testMission: Mission = {
  name: "test",
  edges: {
    SCAN: ["GOTO", "MINE", "HOME"],
    GOTO: ["SCAN", "MINE"],
    MINE: ["SCAN"],
    HOME: ["SCAN", "DUMP"],
    DUMP: ["RETURN"],
    RETURN: ["SCAN"],
  },
  initialPhase: "SCAN",
  movementPhases: new Set(["GOTO", "HOME", "RETURN"]),
  handlers: {},
};

// A second, STATIONARY mission (no movementPhases) — the other side of a cross-mission handoff
// (the live shape: goto's GOTO → smelt's SMELT, MISSION_DONE + MISSION_START on one tick).
const stillMission: Mission = {
  name: "still",
  edges: { SMELT: ["IDLE"] },
  initialPhase: "SMELT",
  handlers: {},
};

function setup(
  over: ConfigOverrides = {},
  logSink: LogSink = sink,
  level: Level = "ERR",
): {
  rt: MockRuntime;
  kernel: Kernel;
  st: BotState;
  bus: Bus;
} {
  const rt = createMockRuntime();
  const bus = new Bus();
  const kernel = new Kernel(
    rt,
    new Logger(logSink, level),
    bus,
    makeGerdaConfig(over),
    GERDA_PHASES,
  );
  kernel.register(core);
  for (const r of reflexes) kernel.register(r);
  kernel.register(recover).registerMission(testMission).registerMission(stillMission);
  const st = makeInitialState();
  kernel.init(st);
  kernel.startMission(st, "test"); // → SCAN, running
  return { rt, kernel, st, bus };
}

describe("vitals reflex", () => {
  it("low health → RECOVER and releases keys", () => {
    const { rt, kernel, st } = setup();
    rt.state.health = 2;
    kernel.tick(st);
    expect(st.phase).toBe("RECOVER");
    expect(rt.state.keys["key.attack"]).toBe(false);
  });

  it("healthy + idle hands → no emergency divert", () => {
    const { kernel, st } = setup();
    kernel.tick(st);
    expect(["RECOVER", "ERROR", "PAUSED"]).not.toContain(st.phase);
  });
});

describe("tool reflex", () => {
  it("tool at/below hard-stop% → ERROR", () => {
    const { rt, kernel, st } = setup();
    rt.state.slots.set(36, { id: "gtceu:mining_hammer", count: 1, durabilityPct: 4 });
    kernel.tick(st);
    expect(st.phase).toBe("ERROR");
  });

  it("tool at swap% with no backup → RECOVER for restock", () => {
    const { rt, kernel, st } = setup();
    rt.state.slots.set(36, { id: "gtceu:mining_hammer", count: 1, durabilityPct: 9 });
    kernel.tick(st);
    expect(st.phase).toBe("RECOVER");
  });

  it("tool at swap% with a backup → hot-swaps, no RECOVER", () => {
    const { rt, kernel, st } = setup();
    rt.state.slots.set(36, { id: "gtceu:mining_hammer", count: 1, durabilityPct: 9 });
    rt.state.slots.set(20, { id: "gtceu:mining_hammer", count: 1, durabilityPct: 100 });
    kernel.tick(st);
    expect(["RECOVER", "ERROR"]).not.toContain(st.phase);
    expect(rt.state.slots.get(36)?.durabilityPct).toBe(100);
  });

  it("near-dead tool but a backup exists → swaps instead of ERROR", () => {
    const { rt, kernel, st } = setup();
    rt.state.slots.set(36, { id: "gtceu:mining_hammer", count: 1, durabilityPct: 3 });
    rt.state.slots.set(20, { id: "gtceu:mining_hammer", count: 1, durabilityPct: 100 });
    kernel.tick(st);
    expect(st.phase).not.toBe("ERROR");
    expect(rt.state.slots.get(36)?.durabilityPct).toBe(100);
  });
});

describe("air reflex (drowning fix)", () => {
  it("breath meter at/under the fraction → RECOVER before HP damage", () => {
    const { rt, kernel, st } = setup({ safety: { airRecoverPct: 0.3 } });
    rt.state.health = 20; // full health — the point is it fires WITHOUT HP loss
    rt.state.air = 90; // 90/300 = 0.30 ≤ threshold
    kernel.tick(st);
    expect(st.phase).toBe("RECOVER");
  });

  it("breath above the fraction → no air divert", () => {
    const { rt, kernel, st } = setup({ safety: { airRecoverPct: 0.3 } });
    rt.state.air = 120; // 0.40 > threshold
    kernel.tick(st);
    expect(st.phase).toBe("SCAN");
  });

  it("water-breathing → never trips even at zero air", () => {
    const { rt, kernel, st } = setup({ safety: { airRecoverPct: 0.3 } });
    rt.state.air = 0;
    rt.state.canBreatheWater = true;
    kernel.tick(st);
    expect(st.phase).toBe("SCAN");
  });

  // A bot parked in water (errored after a water-clutch, paused by a human while submerged) must
  // still bail before it drowns — air is a TERMINAL threat, so it fires even in settled phases.
  it("low air while PAUSED → still bails to RECOVER (drowning while parked)", () => {
    const { rt, kernel, st } = setup({ safety: { airRecoverPct: 0.3 } });
    st.phase = "PAUSED";
    rt.state.air = 30; // 0.10 ≤ threshold
    kernel.tick(st);
    expect(st.phase).toBe("RECOVER");
  });

  it("low air while ERROR → still bails to RECOVER", () => {
    const { rt, kernel, st } = setup({ safety: { airRecoverPct: 0.3 } });
    st.phase = "ERROR";
    rt.state.air = 30;
    kernel.tick(st);
    expect(st.phase).toBe("RECOVER");
  });

  it("low air while already in RECOVER → does NOT re-divert (recovery owns the escape)", () => {
    const { rt, kernel, st } = setup({ safety: { airRecoverPct: 0.3 } });
    st.phase = "RECOVER";
    rt.state.air = 30;
    kernel.tick(st);
    expect(st.phase).toBe("RECOVER"); // unchanged — RECOVER's teleport escapes the water
  });
});

describe("hunger reflex (food awareness)", () => {
  it("emits lowFood once on the downward crossing, never preempts", () => {
    const { rt, kernel, st, bus } = setup({ safety: { lowFoodLevel: 6 } });
    const events: number[] = [];
    bus.on("lowFood", (p) => events.push(p.food));
    rt.state.food = 5; // ≤ threshold
    kernel.tick(st);
    kernel.tick(st); // still low — must NOT re-emit
    expect(st.phase).toBe("SCAN"); // sensor-only: no divert
    expect(events).toEqual([5]);
  });

  it("re-arms after food recovers", () => {
    const { rt, kernel, st, bus } = setup({ safety: { lowFoodLevel: 6 } });
    const events: number[] = [];
    bus.on("lowFood", (p) => events.push(p.food));
    rt.state.food = 5;
    kernel.tick(st);
    rt.state.food = 20; // ate
    kernel.tick(st);
    rt.state.food = 4; // hungry again
    kernel.tick(st);
    expect(events).toEqual([5, 4]);
  });
});

describe("death reflex", () => {
  it("not alive → RECOVER", () => {
    const { rt, kernel, st } = setup();
    rt.state.alive = false;
    kernel.tick(st);
    expect(st.phase).toBe("RECOVER");
  });

  it("died while ERROR → still reaches RECOVER to respawn (not gated out by the settled phase)", () => {
    const { rt, kernel, st } = setup();
    st.phase = "ERROR";
    rt.state.alive = false;
    kernel.tick(st);
    expect(st.phase).toBe("RECOVER");
  });
});

describe("hazard reflex", () => {
  it("falling below cfg.safety.voidY → RECOVER", () => {
    const { rt, kernel, st } = setup();
    rt.setPos({ x: 0, y: -100, z: 0 });
    kernel.tick(st);
    expect(st.phase).toBe("RECOVER");
  });

  it("standing on/in lava → RECOVER", () => {
    const { rt, kernel, st } = setup();
    rt.state.blocks.set(encodePos(0, 64, 0), "minecraft:lava");
    kernel.tick(st);
    expect(st.phase).toBe("RECOVER");
  });
});

describe("stuck reflex", () => {
  it("driving with no progress in a movement phase → RECOVER", () => {
    const { rt, kernel, st } = setup({ safety: { stuckTicksThreshold: 3 } });
    st.phase = "GOTO"; // a mission movement phase; pos never changes on the mock
    rt.keys.set("key.forward", true); // actively trying to walk → a real wedge
    for (let i = 0; i < 4; i++) kernel.tick(st);
    expect(st.phase).toBe("RECOVER");
  });

  it("HOLDING (keys released) in a movement phase does NOT trip stuck", () => {
    const { rt, kernel, st } = setup({ safety: { stuckTicksThreshold: 3 } });
    st.phase = "GOTO"; // movement phase, but not driving — e.g. a follower holding the gap
    rt.keys.releaseAll();
    for (let i = 0; i < 10; i++) kernel.tick(st);
    expect(st.phase).toBe("GOTO"); // standing still on purpose is not stuck
  });

  it("stationary in a non-movement phase does NOT trip stuck", () => {
    const { kernel, st } = setup({ safety: { stuckTicksThreshold: 3 } });
    // stays in SCAN (not a movement phase)
    for (let i = 0; i < 10; i++) kernel.tick(st);
    expect(st.phase).toBe("SCAN");
  });
});

describe("human reflex", () => {
  const HOLD = 3; // small debounce so the tests stay short
  const SETTLE = 4; // small post-bot-drive settle window, ditto
  const LATCH = 25; // small driveHeldMaxTicks — comfortably above SETTLE + HOLD so both sides show
  const MOVING = { forward: 1, strafe: 0, jumping: false, sprinting: false } as const;
  const IDLE = { forward: 0, strafe: 0, jumping: false, sprinting: false } as const;
  const JUMPING = { forward: 0, strafe: 0, jumping: true, sprinting: false } as const;
  let rt: MockRuntime;
  let kernel: Kernel;
  let st: BotState;
  beforeEach(() => {
    ({ rt, kernel, st } = setup({
      safety: { inputHoldTicks: HOLD, inputSettleTicks: SETTLE, driveHeldMaxTicks: LATCH },
    }));
  });

  it("sustained human input in a non-movement phase → PAUSED after the debounce", () => {
    rt.state.input = { ...MOVING };
    for (let i = 0; i < HOLD - 1; i++) {
      kernel.tick(st);
      expect(st.phase).toBe("SCAN"); // not yet — still debouncing
    }
    kernel.tick(st); // HOLD-th tick of sustained input
    expect(st.phase).toBe("PAUSED");
  });

  it("a 1-2 tick input blip (lingering greedy key release) does NOT pause", () => {
    rt.state.input = { ...MOVING };
    kernel.tick(st); // one tick of input...
    rt.state.input = { ...IDLE }; // ...then it's gone (the lingering release decays)
    for (let i = 0; i < 10; i++) kernel.tick(st);
    expect(st.phase).toBe("SCAN");
  });

  it("intermittent input that never holds for the full window does NOT pause", () => {
    for (let i = 0; i < 12; i++) {
      rt.state.input = i % 2 === 0 ? { ...MOVING } : { ...IDLE }; // every other tick
      kernel.tick(st);
    }
    expect(st.phase).toBe("SCAN"); // the counter keeps resetting on the idle ticks
  });

  it("does NOT pause on movement during a bot-driven phase", () => {
    st.phase = "GOTO";
    rt.state.input = { ...MOVING };
    for (let i = 0; i < HOLD + 2; i++) kernel.tick(st);
    expect(st.phase).toBe("GOTO");
  });

  it("does NOT pause during the settle window after arriving from GOTO", () => {
    // Drive a real movement phase first, so the reflex records the bot-drive tick.
    st.phase = "GOTO";
    rt.state.input = { ...MOVING };
    for (let i = 0; i < 3; i++) kernel.tick(st);
    st.phase = "SCAN"; // arrived; the nav's residual input is still being read
    for (let i = 0; i < SETTLE; i++) kernel.tick(st);
    expect(st.phase).toBe("SCAN"); // debounced away inside the settle window
  });

  it("pauses on sustained movement once the settle window has elapsed", () => {
    st.phase = "GOTO";
    rt.state.input = { ...MOVING };
    kernel.tick(st);
    st.phase = "SCAN";
    for (let i = 0; i < SETTLE + HOLD; i++) kernel.tick(st);
    expect(st.phase).toBe("PAUSED");
  });

  // — the sustain-loop bug (live journal, 3/3 laps): mine → goto → smelt. The GOTO
  //   belonged to the goto MISSION; on handoff the stationary mission does not own GOTO, so the
  //   old settle gate (keyed on the ACTIVE mission's movementPhases) evaporated and the nav's
  //   residual input read as a takeover exactly cfg.safety.inputHoldTicks later → PAUSED (terminal).
  it("cross-mission handoff GOTO→stationary: residual nav input does NOT pause", () => {
    st.phase = "GOTO"; // mission "test" is driving
    rt.state.input = { ...MOVING };
    rt.keys.set("key.forward", true);
    rt.keys.set("key.sprint", true);
    for (let i = 0; i < 6; i++) kernel.tick(st); // a LONG leg
    expect(st.phase).toBe("GOTO");

    // Handoff: the leg releases its keys, the stationary mission starts the same tick.
    rt.keys.releaseAll();
    kernel.startMission(st, "still"); // MISSION_ABORT test + MISSION_START still
    expect(st.phase).toBe("SMELT");

    // The game's input state does not collapse with the keys: it keeps reading active.
    for (let i = 0; i < SETTLE; i++) kernel.tick(st);
    rt.state.input = { ...IDLE }; // residual decays
    for (let i = 0; i < 20; i++) kernel.tick(st);
    expect(st.phase).toBe("SMELT"); // mission continues — nobody is at the keyboard
  });

  // NEG-CONTROL for the fix above: the settle window must not DISARM the reflex — a human who
  // keeps holding the key past settle+hold still takes control.
  it("cross-mission handoff GOTO→stationary: input past the settle window still pauses", () => {
    st.phase = "GOTO";
    rt.state.input = { ...MOVING };
    rt.keys.set("key.forward", true);
    for (let i = 0; i < 6; i++) kernel.tick(st);
    rt.keys.releaseAll();
    kernel.startMission(st, "still");

    for (let i = 0; i < SETTLE; i++) kernel.tick(st);
    expect(st.phase).toBe("SMELT"); // still inside the window
    for (let i = 0; i < HOLD; i++) kernel.tick(st); // ...and the human keeps holding
    expect(st.phase).toBe("PAUSED");
  });

  // The jump/sprint hole: the bot's OWN held keys re-arm the window every tick, so a stationary
  // phase that is nevertheless holding a drive key does not read its own input as a human —
  // but only WHILE the hold is still plausibly work (see the bound below).
  // NEG-CONTROL for the bound: a hold shorter than driveHeldMaxTicks stays suppressed.
  it("a bot-held drive key (jump/sprint) suppresses the verdict while the hold is under driveHeldMaxTicks", () => {
    kernel.startMission(st, "still"); // stationary; movementHeld() is false — only jump is held
    rt.keys.set("key.jump", true);
    rt.state.input = { ...JUMPING };
    for (let i = 0; i < SETTLE + HOLD + 10; i++) kernel.tick(st); // 17 ticks < LATCH
    expect(st.phase).toBe("SMELT");
  });

  // The LEAK the bound closes (recover.ts capped-pocket fall-through left key.jump latched and
  // exited RECOVER by a plain transition, which releases nothing): driveHeld() then reads true
  // forever, so the settle window re-armed every tick and the human could never take control.
  // movementHeld() is horizontal-only, so nothing else would have caught it.
  it("a drive key latched past driveHeldMaxTicks outside a movement phase stops suppressing → PAUSED", () => {
    const lines: string[] = [];
    ({ rt, kernel, st } = setup(
      { safety: { inputHoldTicks: HOLD, inputSettleTicks: SETTLE, driveHeldMaxTicks: LATCH } },
      { emit: (l) => lines.push(l) },
      "WARN",
    ));
    kernel.startMission(st, "still"); // stationary phase — the nav owns nothing here
    rt.keys.set("key.jump", true); // …and yet a drive key is held: the latch
    rt.state.input = { ...JUMPING }; // sustained human-like input the whole time
    for (let i = 0; i < LATCH; i++) kernel.tick(st);
    expect(st.phase).toBe("SMELT"); // still inside the bound
    for (let i = 0; i < SETTLE + HOLD + 1; i++) kernel.tick(st);
    expect(st.phase).toBe("PAUSED"); // the latch no longer disarms the reflex

    const latch = lines
      .map((l) => JSON.parse(l) as { event?: string; fields?: { keys?: string[] } })
      .filter((l) => l.event === "HUMAN_REFLEX_DRIVE_LATCH");
    expect(latch).toHaveLength(1); // ONCE, not once per tick
    expect(latch[0]?.fields?.keys).toEqual(["key.jump"]); // names the offending key
  });

  // NEG-CONTROL for the bot-held gate: once the bot lets go, the same input is a human again.
  it("after the bot releases its drive key, sustained input pauses", () => {
    kernel.startMission(st, "still");
    rt.keys.set("key.jump", true);
    rt.state.input = { forward: 0, strafe: 0, jumping: true, sprinting: false };
    for (let i = 0; i < 5; i++) kernel.tick(st);
    rt.keys.releaseAll(); // the bot is done driving; the input persists = a human
    for (let i = 0; i < SETTLE + HOLD; i++) kernel.tick(st);
    expect(st.phase).toBe("PAUSED");
  });
});

describe("recover handler", () => {
  it("teleports home, then re-enters the mission's initial phase", () => {
    const { rt, kernel, st } = setup({ teleportWaitTicks: 3 });
    st.phase = "RECOVER";
    st.phaseTicks = 0;
    kernel.tick(st); // phaseTicks 1 → #stop + /home base
    expect(rt.state.chat).toContain("/home base");
    expect(st.phase).toBe("RECOVER");
    kernel.tick(st); // 2
    kernel.tick(st); // 3 ≥ wait → re-enter SCAN
    expect(st.phase).toBe("SCAN");
  });

  // No home set: the server answers "Unknown destination!", the bot does not move, and every
  // recovery used to send /home again — the server kicked the bot for spam within a minute.
  // Each episode is one RECOVER; `moves[e]` says whether its /home lands. `home` seeds the
  // persisted home waypoint (null = none recorded); the bot starts every episode at START.
  const START = { x: 0.5, y: 64, z: 0.5 };
  const FAR_HOME = { x: 1000, y: 64, z: 1000 };
  function recoverEpisodes(
    moves: readonly boolean[],
    home: { x: number; y: number; z: number } | null = FAR_HOME,
    over: ConfigOverrides = {},
    between: (st: BotState, e: number) => void = () => {},
  ) {
    const lines: string[] = [];
    const { rt, kernel, st } = setup(
      { teleportWaitTicks: 3, ...over, safety: { recoverMaxAttempts: 100, ...over.safety } },
      { emit: (l) => lines.push(l) },
      "INFO",
    );
    if (home !== null) {
      const persist = PERSIST_SLICE.init();
      persist.waypoints = [makeWaypoint("home", home, "home")];
      st.bb[PERSIST_SLICE.name] = persist;
    }
    const homesPer: number[] = [];
    for (const [e, move] of moves.entries()) {
      between(st, e);
      rt.setPos(START);
      const before = rt.state.chat.filter((c) => c === "/home base").length;
      st.phase = "RECOVER";
      st.phaseTicks = 0;
      kernel.tick(st); // sends /home (or not)
      if (move) rt.setPos({ x: 500.5, y: 64, z: 0.5 });
      for (let i = 0; i < 4 && st.phase === "RECOVER"; i++) kernel.tick(st);
      expect(st.phase).toBe("SCAN");
      homesPer.push(rt.state.chat.filter((c) => c === "/home base").length - before);
    }
    const homes = homesPer.reduce((a, b) => a + b, 0);
    const events = lines.map((l) => (JSON.parse(l) as { event: string }).event);
    return { homes, homesPer, events };
  }
  const LIMIT = makeGerdaConfig().safety.homeNoEffectLimit;
  const misses = (n: number): boolean[] => Array.from({ length: n }, () => false);

  it("a /home that never moves the bot is sent homeNoEffectLimit times, then disabled once", () => {
    const { homes, events } = recoverEpisodes(misses(LIMIT + 3));
    expect(homes).toBe(LIMIT);
    expect(events.filter((e) => e === "HOME_COMMAND_DISABLED")).toHaveLength(1);
  });

  it("NEG-CONTROL: a /home that does move the bot keeps being sent", () => {
    const { homes, events } = recoverEpisodes(Array.from({ length: LIMIT + 3 }, () => true));
    expect(homes).toBe(LIMIT + 3);
    expect(events).not.toContain("HOME_COMMAND_DISABLED");
  });

  // A bot already standing at its home cannot move by teleporting there: not a missing home.
  it("a no-move that starts at the recorded home does not count", () => {
    const { homes, events } = recoverEpisodes(misses(LIMIT + 3), START);
    expect(homes).toBe(LIMIT + 3);
    expect(events).toContain("TELEPORT_NO_MOVE");
    expect(events).not.toContain("HOME_COMMAND_DISABLED");
  });

  // A fresh bot on chop/goto/fetch/hunt has no recorded home (persistence records it only on the
  // mine HOME leg): its no-moves must count, or it sends /home without bound and gets kicked.
  it("a no-move with no recorded home counts like one far from home", () => {
    const { homes, events } = recoverEpisodes(misses(LIMIT + 3), null);
    expect(homes).toBe(LIMIT);
    expect(events.filter((e) => e === "HOME_COMMAND_DISABLED")).toHaveLength(1);
  });

  // A /home on cooldown (FTB Essentials, default 10 s) misses once, then the next one lands:
  // the landing resets the streak, so one more miss later does not disable.
  it("a landed /home between misses resets the streak", () => {
    const pattern = [...misses(LIMIT - 1), true, ...misses(LIMIT - 1), true, false];
    const { homes, events } = recoverEpisodes(pattern);
    expect(homes).toBe(pattern.length);
    expect(events).not.toContain("HOME_COMMAND_DISABLED");
  });

  it("a disabled /home re-arms itself homeRearmTicks later", () => {
    const rearm = 500;
    const { homesPer, events } = recoverEpisodes(
      [...misses(LIMIT), false, true, true],
      FAR_HOME,
      { safety: { homeRearmTicks: rearm } },
      (st, e) => {
        if (e === LIMIT + 1) st.tickCount += rearm; // the window has passed before this episode
      },
    );
    expect(homesPer).toEqual([...Array.from({ length: LIMIT }, () => 1), 0, 1, 1]);
    expect(events.filter((e) => e === "HOME_COMMAND_DISABLED")).toHaveLength(1);
    expect(events.filter((e) => e === "HOME_COMMAND_REARMED")).toHaveLength(1);
  });

  // NEG-CONTROL for the re-arm: inside the window the disable holds.
  it("a disabled /home stays off inside the re-arm window", () => {
    const { homesPer, events } = recoverEpisodes(misses(LIMIT + 2), FAR_HOME, {
      safety: { homeRearmTicks: 100_000 },
    });
    expect(homesPer.slice(LIMIT)).toEqual([0, 0]);
    expect(events).not.toContain("HOME_COMMAND_REARMED");
  });

  it("dead in RECOVER → presses respawn until alive, holding off teleport, then resumes", () => {
    const { rt, kernel, st } = setup({ teleportWaitTicks: 3 });
    rt.state.alive = false;
    kernel.tick(st); // death reflex → RECOVER
    expect(st.phase).toBe("RECOVER");

    kernel.tick(st); // RECOVER sees dead → presses respawn (mock revives), NO teleport yet
    expect(rt.state.respawnCalls).toBeGreaterThanOrEqual(1);
    expect(rt.state.alive).toBe(true);
    expect(rt.state.chat).not.toContain("/home base"); // didn't teleport while dead

    // Now alive → begin (teleport) then wait out the window → back to the mission.
    for (let i = 0; i < 6 && st.phase !== "SCAN"; i++) kernel.tick(st);
    expect(rt.state.chat).toContain("/home base");
    expect(st.phase).toBe("SCAN");
  });

  // Respawn displacement (live: bot_2 died mid-EXCAVATE, respawned at the void
  // base 29 km away, and its mission blindly resumed there — chop ground a treeless scan
  // loop). A respawn that lands far from the death spot must PARK the mission, not resume.
  it("respawn far from the death spot → parks the mission PAUSED (respawn_displaced)", () => {
    const { rt, kernel, st } = setup({ teleportWaitTicks: 3 });
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    rt.state.alive = false;
    kernel.tick(st); // death reflex → RECOVER
    kernel.tick(st); // presses respawn (mock revives); deathPos captured
    rt.setPos({ x: 1000.5, y: 78, z: -2000.5 }); // spawn threw us far away
    kernel.tick(st); // RESPAWNED branch sees the displacement
    expect(st.phase).toBe("PAUSED");
    expect(rt.state.chat).not.toContain("/home base"); // no blind teleport-resume
  });

  it("respawn near the death spot → normal flow, mission resumes", () => {
    const { rt, kernel, st } = setup({ teleportWaitTicks: 3 });
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    rt.state.alive = false;
    kernel.tick(st);
    kernel.tick(st); // respawn; mock keeps the position → displacement ~0
    for (let i = 0; i < 6 && st.phase !== "SCAN"; i++) kernel.tick(st);
    expect(rt.state.chat).toContain("/home base");
    expect(st.phase).toBe("SCAN");
  });

  // The capped-pocket key latch: RECOVER holds key.jump to surface, and a pocket it cannot rise
  // out of falls through to the teleport/backoff — whose backoff escalation transitions straight
  // to ERROR, releasing nothing. A key.jump surviving that keeps rt.keys.driveHeld() true forever
  // and blinds the human-takeover reflex (src/shared/reflexes/human.ts).
  // Staged on the ONE fall-through path that releases nothing: the backoff escalation returns to
  // ERROR before the `phaseTicks <= 1` releaseAll(). Without the release in the capped branch the
  // bot reaches ERROR still holding key.jump.
  it("capped drown pocket escalating to ERROR → releases the surfacing jump (no latched key)", () => {
    const { rt, kernel, st } = setup({
      safety: { surfaceMaxTicks: 2, recoverMaxAttempts: 1, recoverBackoffWindow: 10000 },
    });
    st.phase = "RECOVER";
    st.phaseTicks = 0;
    kernel.tick(st); // dry first entry: attempt 1 of 1 (releaseAll + /home)

    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    rt.setBlock(0, 64, 0, "minecraft:water"); // feet
    rt.setBlock(0, 65, 0, "minecraft:water"); // head — submerged, with no way up
    rt.state.onGround = true;
    kernel.tick(st); // surfacing 1
    kernel.tick(st); // surfacing 2 = the cap
    expect(rt.state.keys["key.jump"]).toBe(true); // NEG-CONTROL: still rising, key legitimately held

    kernel.tick(st); // capped → fall through → attempt 2 > max → ERROR, releasing nothing
    expect(st.phase).toBe("ERROR");
    expect(rt.state.keys["key.jump"]).toBe(false);
    expect(rt.keys.driveHeld()).toBe(false);
  });

  it("displaced respawn with NO active mission → settles in IDLE, not PAUSED", () => {
    const { rt, kernel, st } = setup({ teleportWaitTicks: 3 });
    kernel.abortMission(st); // idle bot: reflexes still guard the body
    st.phase = "RECOVER";
    st.phaseTicks = 0;
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    rt.state.alive = false;
    kernel.tick(st); // dead → respawn pressed
    rt.setPos({ x: 1000.5, y: 78, z: -2000.5 });
    for (let i = 0; i < 8 && st.phase === "RECOVER"; i++) kernel.tick(st);
    expect(st.phase).toBe("IDLE"); // nothing to park — parked-at-base IS the idle state
  });
});

describe("water-clutch reflex (MLG fall-survival)", () => {
  const BUCKET = "minecraft:water_bucket";
  // Equal thresholds → arm + place in a single tick (drop=4 satisfies both ≥minFall and ≤reach),
  // so the place behaviour is testable without simulating mid-fall descent across ticks.
  const FAST = { safety: { waterClutchMinFall: 4, waterClutchReach: 4 } } as const;

  /** Stage a falling bot at y=64.5 over a stone floor `drop` blocks below the feet. */
  function falling(over: ConfigOverrides = {}, drop = 4) {
    const h = setup({ ...FAST, ...over });
    h.rt.setPos({ x: 0.5, y: 64, z: 0.5 }); // feet (0,64,0)
    h.rt.state.onGround = false;
    h.rt.state.velocity = { x: 0, y: -1, z: 0 };
    h.rt.setBlock(0, 64 - (drop + 1), 0, "minecraft:stone"); // surface y = feet.y-(drop+1)
    return h;
  }

  it("falling with a deep floor + a hotbar bucket → aims at the floor, uses, confirms on the emptied bucket", () => {
    const { rt, kernel, st, bus } = falling();
    rt.state.slots.set(36, { id: BUCKET, count: 1, durabilityPct: 100 }); // hotbar slot 0
    rt.state.hotbar = 0;
    const events: unknown[] = [];
    bus.on("waterClutch", (p) => events.push(p));

    kernel.tick(st); // bucket already in hand → attempt fires on the first armed tick

    expect(rt.state.lastUseItem).toBe(BUCKET); // used the water bucket
    // vertical-aware aim (break-cell aimAt): the exposed top face of the floor, not the raw centre
    expect(rt.state.lookTarget).toEqual({ x: 0.5, y: 59.5 + 0.45, z: 0.5 });
    expect(events).toEqual([]); // NOT announced yet — the place is unconfirmed until the bucket empties

    // game transition the mock can't infer: the server accepted the use → the held bucket emptied
    rt.state.slots.set(36, { id: "minecraft:bucket", count: 1, durabilityPct: 100 });
    kernel.tick(st); // confirm → placed + announced

    expect(events).toEqual([{ x: 0, y: 60, z: 0, drop: 4 }]); // source one above the surface
    expect(st.phase).toBe("SCAN"); // a reflex, not an FSM detour — mission phase untouched
  });

  it("a missed raycast retries every tick until the bucket-state confirms, then STOPS using", () => {
    const { rt, kernel, st, bus } = falling();
    rt.state.slots.set(36, { id: BUCKET, count: 1, durabilityPct: 100 });
    rt.state.hotbar = 0;
    const events: unknown[] = [];
    bus.on("waterClutch", (p) => events.push(p));

    // the bucket never empties (every use raycast missed) → one fresh attempt per tick
    for (let i = 0; i < 3; i++) kernel.tick(st);
    expect(rt.state.useItemCalls).toBe(3);
    expect(events).toEqual([]); // no lying "placed" while the water is not down

    rt.state.slots.set(36, { id: "minecraft:bucket", count: 1, durabilityPct: 100 }); // a use landed
    kernel.tick(st); // confirm tick
    expect(events).toHaveLength(1);
    const calls = rt.state.useItemCalls;
    kernel.tick(st); // placed → waiting to land: an EMPTY-bucket use would scoop the water back
    expect(rt.state.useItemCalls).toBe(calls); // no further use attempts after confirmation
  });

  it("drift lead: horizontal velocity → water goes under the PREDICTED landing column", () => {
    const { rt, kernel, st, bus } = falling();
    rt.state.velocity = { x: 0.5, y: -1, z: 0 }; // drifting +x at half a block per tick
    rt.setBlock(2, 59, 0, "minecraft:stone"); // floor under the predicted column (+2 in 4 ticks)
    rt.state.slots.set(36, { id: BUCKET, count: 1, durabilityPct: 100 });
    rt.state.hotbar = 0;
    const events: unknown[] = [];
    bus.on("waterClutch", (p) => events.push(p));

    kernel.tick(st); // aim + attempt at the led column, not the current one
    expect(rt.state.lookTarget).toEqual({ x: 2.5, y: 59.5 + 0.45, z: 0.5 });

    rt.state.slots.set(36, { id: "minecraft:bucket", count: 1, durabilityPct: 100 });
    kernel.tick(st);
    expect(events).toEqual([{ x: 2, y: 60, z: 0, drop: 4 }]); // source over the LANDING column
  });

  it("no water bucket in the hotbar → does not clutch (lets the fall play out)", () => {
    const { rt, kernel, st } = falling();
    kernel.tick(st);
    expect(rt.state.lastUseItem).toBeNull();
    expect(st.phase).toBe("SCAN");
  });

  it("bucketless fall → NO_BUCKET warns ONCE per fall episode, re-arms after landing", () => {
    const warns: string[] = [];
    const capture: LogSink = {
      emit: (line) => {
        if (line.includes("WATER_CLUTCH_NO_BUCKET")) warns.push(line);
      },
    };
    const { rt, kernel, st } = (() => {
      const h = setup(FAST, capture, "WARN");
      h.rt.setPos({ x: 0.5, y: 64, z: 0.5 });
      h.rt.state.onGround = false;
      h.rt.state.velocity = { x: 0, y: -1, z: 0 };
      h.rt.setBlock(0, 59, 0, "minecraft:stone"); // drop=4 ≥ minFall
      return h;
    })();

    for (let i = 0; i < 5; i++) kernel.tick(st); // a 5-tick bucketless fall
    expect(warns).toHaveLength(1); // latched — not one warn per falling tick

    rt.state.onGround = true; // land → the latch resets
    rt.state.velocity = { x: 0, y: 0, z: 0 };
    kernel.tick(st);

    rt.state.onGround = false; // a NEW fall episode warns once more
    rt.state.velocity = { x: 0, y: -1, z: 0 };
    for (let i = 0; i < 3; i++) kernel.tick(st);
    expect(warns).toHaveLength(2);
  });

  it("a harmless short drop (< minFall) → ignored", () => {
    const { rt, kernel, st } = falling({}, 2); // floor only 2 below
    rt.state.slots.set(36, { id: BUCKET, count: 1, durabilityPct: 100 });
    rt.state.hotbar = 0;
    kernel.tick(st);
    expect(rt.state.lastUseItem).toBeNull();
  });

  it("standing on the ground → never fires even with a deep drop beside it", () => {
    const { rt, kernel, st } = falling();
    rt.state.slots.set(36, { id: BUCKET, count: 1, durabilityPct: 100 });
    rt.state.hotbar = 0;
    rt.state.onGround = true; // not actually falling
    rt.state.velocity = { x: 0, y: 0, z: 0 };
    kernel.tick(st);
    expect(rt.state.lastUseItem).toBeNull();
  });

  it("after landing in the water it scoops the source back up and restores the held tool", () => {
    const { rt, kernel, st } = falling();
    rt.state.slots.set(36, { id: BUCKET, count: 1, durabilityPct: 100 }); // bucket in hotbar 0
    rt.state.slots.set(38, { id: "minecraft:diamond_pickaxe", count: 1, durabilityPct: 100 }); // tool in hotbar 2
    rt.state.hotbar = 2; // holding the tool when the fall starts

    kernel.tick(st); // arm: equips bucket (saves slot 2) — the equip settles this tick
    expect(rt.state.hotbar).toBe(0);
    expect(rt.state.lastUseItem).toBeNull(); // no use until the equipped bucket is the READ held item
    kernel.tick(st); // attempt: uses the now-held bucket, source pending at (0,60,0)
    expect(rt.state.lastUseItem).toBe(BUCKET);

    // Game transitions the mock can't infer: the bucket emptied, and the bot fell into the water.
    rt.state.slots.set(36, { id: "minecraft:bucket", count: 1, durabilityPct: 100 });
    rt.setPos({ x: 0.5, y: 60, z: 0.5 }); // landed in the water cell
    rt.setBlock(0, 60, 0, "minecraft:water");
    rt.state.onGround = true;
    rt.state.velocity = { x: 0, y: 0, z: 0 };

    kernel.tick(st); // landed with an emptied bucket → confirm the late place → retrieve
    kernel.tick(st); // retrieve → aims at the source, uses the empty bucket
    expect(rt.state.lookTarget).toEqual({ x: 0.5, y: 60.5, z: 0.5 });
    expect(rt.state.lastUseItem).toBe("minecraft:bucket");

    rt.state.slots.set(36, { id: BUCKET, count: 1, durabilityPct: 100 }); // scoop succeeded
    kernel.tick(st); // retrieve → bucket refilled → done, restore the tool
    expect(rt.state.hotbar).toBe(2); // back to holding the pickaxe
  });

  it("retrieve: shoved off the source by the current → walks back instead of abandoning the water", () => {
    const { rt, kernel, st } = falling();
    rt.state.slots.set(36, { id: BUCKET, count: 1, durabilityPct: 100 });
    rt.state.hotbar = 0;
    kernel.tick(st); // attempt at (0,60,0)
    rt.state.slots.set(36, { id: "minecraft:bucket", count: 1, durabilityPct: 100 }); // emptied
    rt.setPos({ x: 0.5, y: 60, z: 0.5 });
    rt.setBlock(0, 60, 0, "minecraft:water");
    rt.state.onGround = true;
    rt.state.velocity = { x: 0, y: 0, z: 0 };
    kernel.tick(st); // landed + emptied bucket → confirm → retrieve

    rt.setPos({ x: 6.5, y: 60, z: 0.5 }); // the current shoved us 6 blocks away (> reach 4)
    kernel.tick(st); // retrieve: out of reach → walk back, do NOT give up
    expect(rt.state.keys["key.forward"]).toBe(true); // walking toward the source
    expect(rt.state.lookTarget).toEqual({ x: 0.5, y: 60.5, z: 0.5 }); // facing it, not giving up
  });

  it("provisioning: a bucket buried in the main inventory is swapped into a free hotbar slot", () => {
    // minFall(5) > reach(4) → arm and place land on different ticks, so the swap applies first.
    const { rt, kernel, st } = falling(
      { safety: { waterClutchMinFall: 5, waterClutchReach: 4 } },
      6,
    );
    rt.state.slots.set(38, { id: "minecraft:diamond_pickaxe", count: 1, durabilityPct: 100 }); // hotbar 2
    rt.state.hotbar = 2; // holding the tool
    rt.state.slots.set(9, { id: BUCKET, count: 1, durabilityPct: 100 }); // main inventory, NOT hotbar

    kernel.tick(st); // detect (drop=6 ≥ minFall) → arm → swap the main-inv bucket into a free hotbar slot
    expect(rt.state.lastUseItem).toBeNull(); // drop 6 > reach 4 → armed only, not placed yet
    const heldId = rt.state.slots.get(36 + rt.state.hotbar)?.id;
    expect(heldId).toBe(BUCKET); // bucket now in hand (free slot 0/1 used; tool in slot 2 untouched)
    expect(rt.state.slots.get(38)?.id).toBe("minecraft:diamond_pickaxe");
  });

  it("provisioning: no free hotbar slot → displaces the held item, then restores it on retrieve", () => {
    const { rt, kernel, st } = falling(
      { safety: { waterClutchMinFall: 5, waterClutchReach: 4 } },
      6,
    );
    for (let i = 0; i < 9; i++) {
      rt.state.slots.set(36 + i, { id: "minecraft:cobblestone", count: 64, durabilityPct: 100 });
    }
    rt.state.hotbar = 0; // every hotbar slot full
    rt.state.slots.set(9, { id: BUCKET, count: 1, durabilityPct: 100 }); // bucket in main inv

    kernel.tick(st); // arm: no free hotbar → swap bucket into held slot 0, cobble → main slot 9
    expect(rt.state.slots.get(36)?.id).toBe(BUCKET);
    expect(rt.state.slots.get(9)?.id).toBe("minecraft:cobblestone");

    rt.setPos({ x: 0.5, y: 58, z: 0.5 }); // fall closer so drop ≤ reach, then place
    rt.setBlock(0, 57, 0, "minecraft:stone"); // floor 1 below → drop 0 ... ensure placement
    kernel.tick(st); // place
    rt.state.slots.set(36, { id: "minecraft:bucket", count: 1, durabilityPct: 100 }); // emptied
    rt.setBlock(0, 58, 0, "minecraft:water"); // landed in water
    kernel.tick(st); // placed → retrieve
    kernel.tick(st); // scoop attempt
    rt.state.slots.set(36, { id: BUCKET, count: 1, durabilityPct: 100 }); // refilled
    kernel.tick(st); // retrieve done → restore the bag

    expect(rt.state.slots.get(9)?.id).toBe(BUCKET); // bucket returned to its main-inv slot
    expect(rt.state.slots.get(36)?.id).toBe("minecraft:cobblestone"); // cobble back in the hand slot
  });
});

describe("swim-out reflex (drown-trap escape)", () => {
  /** Stage a bot standing in a head-deep water pocket (feet + head both water) at y=64. */
  function submerged(over: ConfigOverrides = {}) {
    const h = setup(over);
    h.rt.setPos({ x: 0.5, y: 64, z: 0.5 }); // feet (0,64,0)
    h.rt.setBlock(0, 64, 0, "minecraft:water"); // feet cell
    h.rt.setBlock(0, 65, 0, "minecraft:water"); // head cell
    h.rt.state.onGround = true; // resting on the pocket bottom, not falling
    return h;
  }

  it("submerged with breath to spare → holds jump to float up, mission phase untouched", () => {
    const { rt, kernel, st, bus } = submerged();
    const events: unknown[] = [];
    bus.on("submerged", (p) => events.push(p));

    kernel.tick(st);

    expect(rt.state.keys["key.jump"]).toBe(true); // swimming up
    expect(rt.state.keys["key.forward"]).toBe(false); // no horizontal drift into a wall
    expect(st.phase).toBe("SCAN"); // a reflex, not an FSM detour
    expect(events).toEqual([{ x: 0, y: 64, z: 0, air: 300 }]);
  });

  it("wading 1-deep (feet water, head air) → does NOT fire (only over-the-head water is a trap)", () => {
    const { rt, kernel, st } = submerged();
    rt.setBlock(0, 65, 0, "minecraft:air"); // head clear — shin-deep only
    kernel.tick(st);
    expect(rt.state.keys["key.jump"]).toBeFalsy();
  });

  it("surfaced (head clears water) → releases jump and hands control back", () => {
    const { rt, kernel, st } = submerged();
    kernel.tick(st); // submerged → holding jump
    expect(rt.state.keys["key.jump"]).toBe(true);

    rt.setBlock(0, 65, 0, "minecraft:air"); // rose so the head cell is now air
    kernel.tick(st); // surfaced → done
    expect(rt.state.keys["key.jump"]).toBe(false);
    expect(st.phase).toBe("SCAN");
  });

  it("water-breathing → never fires even head-deep (can't drown)", () => {
    const { rt, kernel, st } = submerged();
    rt.state.canBreatheWater = true;
    kernel.tick(st);
    expect(rt.state.keys["key.jump"]).toBeFalsy();
  });

  it("a covered pocket it can't surface from → gives up after cfg.safety.swimOutMaxTicks of NO progress", () => {
    const { rt, kernel, st } = submerged({ safety: { swimOutMaxTicks: 3 } });
    // Bot never moves (stuck under a ceiling) → every tick is a stall tick.
    for (let i = 0; i < 3; i++) {
      kernel.tick(st);
      expect(rt.state.keys["key.jump"]).toBe(true); // still trying to surface
    }
    kernel.tick(st); // stall (4) > cfg.safety.swimOutMaxTicks (3) → give up, let the air reflex own the escape
    expect(rt.state.keys["key.jump"]).toBe(false);
  });

  it("a steadily-rising swim NEVER gives up (stall budget, not a slow-rise budget)", () => {
    const { rt, kernel, st } = submerged({ safety: { swimOutMaxTicks: 2 } }); // tiny budget
    // Rise one block per tick through a deep column — each new high resets the stall counter, so
    // even far past cfg.safety.swimOutMaxTicks it keeps swimming (the deep-pool live case that used to give up).
    for (let i = 0; i < 6; i++) {
      const y = 64 + i;
      rt.setPos({ x: 0.5, y, z: 0.5 });
      rt.setBlock(0, y, 0, "minecraft:water"); // feet stays head-deep as we climb
      rt.setBlock(0, y + 1, 0, "minecraft:water"); // head
      kernel.tick(st);
      expect(rt.state.keys["key.jump"]).toBe(true); // progress resets the stall → keeps rising
    }
  });

  it("disabled via config → never fires", () => {
    const { rt, kernel, st } = submerged({ safety: { swimOutEnabled: false } });
    kernel.tick(st);
    expect(rt.state.keys["key.jump"]).toBeFalsy();
  });
});

describe("vitals proactive distress (sustained HP loss → escape early)", () => {
  it("SUSTAINED loss (repeated damage ticks) → RECOVER above cfg.safety.minHealth", () => {
    const { rt, kernel, st, bus } = setup(); // cfg.safety defaults: distressDrop 4, distressMinEvents 2, distressWindow 60, minHealth 6
    const events: { health: number; lost: number }[] = [];
    bus.on("distress", (p) => events.push({ health: p.health, lost: p.lost }));
    rt.state.health = 20;
    kernel.tick(st); // sample the peak
    expect(st.phase).toBe("SCAN");
    // repeated damage: three distinct drop ticks (18, 16, 14) — active harm, not one hit
    for (const hp of [18, 16, 14]) {
      rt.state.health = hp;
      kernel.tick(st);
    }
    expect(st.phase).toBe("RECOVER"); // lost 6 ≥ cfg.safety.distressDrop over ≥2 events, still above cfg.safety.minHealth
    expect(events).toHaveLength(1);
    expect(events[0]?.lost).toBeGreaterThanOrEqual(4);
  });

  it("a single big drop (survived fall) does NOT trip — the false positive we prevent", () => {
    const { rt, kernel, st } = setup();
    rt.state.health = 20;
    kernel.tick(st);
    rt.state.health = 12; // lost 8 ≥ cfg.safety.distressDrop but ONE event — a survived fall, keep working
    kernel.tick(st);
    expect(st.phase).toBe("SCAN");
    // …and it stays put on subsequent ticks while HP is stable (no second event → never trips)
    kernel.tick(st);
    kernel.tick(st);
    expect(st.phase).toBe("SCAN");
  });

  it("cfg.safety.distressEnabled:false disables the proactive check", () => {
    const { rt, kernel, st } = setup({ safety: { distressEnabled: false } });
    rt.state.health = 20;
    kernel.tick(st);
    for (const hp of [18, 16, 14]) {
      rt.state.health = hp; // sustained loss that WOULD trip if enabled
      kernel.tick(st);
    }
    expect(st.phase).toBe("SCAN");
  });
});

describe("idle survival (no mission active → life-preservation reflexes still run)", () => {
  // Like setup() but WITHOUT startMission: the bot is parked (IDLE, running=false). Only the
  // survival reflexes (death/air/swimOut/waterClutch/vitals) should run — proving a parked bot
  // isn't defenceless, while the mission-progress reflexes (tool/stuck/…) stay dormant.
  function idle(over: ConfigOverrides = {}): {
    rt: MockRuntime;
    kernel: Kernel;
    st: BotState;
  } {
    const rt = createMockRuntime();
    const kernel = new Kernel(
      rt,
      new Logger(sink, "ERR"),
      new Bus(),
      makeGerdaConfig(over),
      GERDA_PHASES,
    );
    kernel.register(core);
    for (const r of reflexes) kernel.register(r);
    kernel.register(recover).registerMission(testMission);
    const st = makeInitialState();
    kernel.init(st); // no startMission → IDLE, running=false
    return { rt, kernel, st };
  }

  it("parked bot at critical HP → survival vitals still diverts to RECOVER", () => {
    const { rt, kernel, st } = idle();
    expect(st.running).toBe(false);
    rt.state.health = 2;
    kernel.tick(st);
    expect(st.phase).toBe("RECOVER"); // idle but not defenceless
  });

  it("parked bot that dies → death reflex reaches RECOVER (so it can respawn)", () => {
    const { rt, kernel, st } = idle();
    rt.state.alive = false;
    kernel.tick(st);
    expect(st.phase).toBe("RECOVER");
  });

  it("parked bot submerged → swim-out holds jump in place (no mission needed)", () => {
    const { rt, kernel, st } = idle();
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    rt.setBlock(0, 64, 0, "minecraft:water"); // feet
    rt.setBlock(0, 65, 0, "minecraft:water"); // head → submerged
    kernel.tick(st);
    expect(rt.state.keys["key.jump"]).toBe(true);
  });

  it("parked bot in danger runs the FULL RECOVER incl. the teleport-home (idle isn't in-place-only)", () => {
    const { rt, kernel, st } = idle();
    rt.state.health = 2;
    kernel.tick(st); // divert to RECOVER (short-circuits this tick)
    expect(st.phase).toBe("RECOVER");
    kernel.tick(st); // RECOVER handler runs in the idle path → issues the teleport
    expect(rt.state.chat).toContain(makeGerdaConfig().homeCommand);
  });

  it("parked bot with a broken tool does NOT trip — tool is mission-progress, not survival", () => {
    const { rt, kernel, st } = idle();
    rt.state.slots.set(36, { id: "gtceu:mining_hammer", count: 1, durabilityPct: 4 });
    kernel.tick(st);
    expect(st.phase).toBe("IDLE"); // stays put: we didn't turn "everything" on when idle
  });
});

describe("RECOVER drowning-escape (surface before teleport)", () => {
  function submerge(rt: MockRuntime, x: number, y: number, z: number): void {
    rt.setPos({ x: x + 0.5, y, z: z + 0.5 });
    rt.setBlock(x, y, z, "minecraft:water"); // feet in water
    rt.setBlock(x, y + 1, z, "minecraft:water"); // head in water → submerged
  }

  it("submerged in RECOVER → holds jump to rise, does NOT teleport yet", () => {
    const { rt, kernel, st } = setup();
    submerge(rt, 0, 64, 0);
    st.phase = "RECOVER";
    st.phaseTicks = 0;
    kernel.tick(st);
    expect(st.phase).toBe("RECOVER");
    expect(rt.state.keys["key.jump"]).toBe(true); // physically rising
    expect(rt.state.chat).not.toContain(makeGerdaConfig().homeCommand); // teleport frozen while drowning
  });

  it("once the head clears water → releases jump and issues the teleport", () => {
    const { rt, kernel, st } = setup();
    submerge(rt, 0, 64, 0);
    st.phase = "RECOVER";
    st.phaseTicks = 0;
    kernel.tick(st); // surfacing (jump held, no teleport)
    rt.setBlock(0, 64, 0, "minecraft:air"); // rose out
    rt.setBlock(0, 65, 0, "minecraft:air");
    kernel.tick(st); // surfaced → teleport on stable footing
    expect(rt.state.keys["key.jump"]).toBe(false);
    expect(rt.state.chat).toContain(makeGerdaConfig().homeCommand);
  });

  it("a capped pocket (can't surface within cfg.safety.surfaceMaxTicks) gives up rising → best-effort teleport", () => {
    const { rt, kernel, st } = setup({ safety: { surfaceMaxTicks: 3 } });
    submerge(rt, 0, 64, 0); // stays submerged every tick (a sealed pocket)
    st.phase = "RECOVER";
    st.phaseTicks = 0;
    for (let i = 0; i < 4; i++) kernel.tick(st); // exceed cfg.safety.surfaceMaxTicks while still underwater
    // gave up rising → the teleport/backoff flow got to run despite being submerged
    expect(rt.state.chat).toContain(makeGerdaConfig().homeCommand);
  });
});
