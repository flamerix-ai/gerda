// The navigator never walks blind: a failed steer / ground-contact read stops the drive and fails
// the mission loudly (RUNTIME_UNSUPPORTED), it is never dropped or read as "grounded".
//
// Why: on Fabric the Forge SRG members behind setYaw (m_146922_) and onGround (m_20096_) do not
// exist. The executor used to `void` the failed setYaw and press forward, and to read a failed
// onGround as `true` — measured on Fabric 1.20.1, `goto` walked straight along yaw 0 and
// fell 19 blocks (docs/PORTABILITY.md). Neg-control: every case below fails on that old code (it
// returned "moving" with key.forward held, and the mission stayed in GOTO).
import { core } from "@/bot/capabilities/core";
import { gotoMission } from "@/bot/missions/goto";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { RuntimeUnsupportedError } from "@/core/prim/invariant";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import { err } from "@/core/runtime/types";
import { Bus } from "@/shared/kernel/bus";
import { Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogRecord, type LogSink, Logger } from "@/shared/kernel/logger";
import { greedyStep, resetGreedyNav } from "@/shared/nav";
import { aimAt } from "@/shared/nav/break-cell";
import { ladderStep } from "@/shared/nav/ladder";
import { initParkourRun, parkourSnapshot, parkourStep, resetParkour } from "@/shared/nav/parkour";
import { pillarStep, resetPillar } from "@/shared/nav/pillar";
import { beforeEach, describe, expect, it } from "vitest";

const cfg = makeGerdaConfig({});
const MOVE_KEYS = ["key.forward", "key.jump", "key.sprint", "key.back", "key.left", "key.right"];

function corridor(rt: MockRuntime, len: number): void {
  for (let x = 0; x <= len; x++) rt.setBlock(x, 63, 0, "minecraft:stone");
  rt.setPos({ x: 0.5, y: 64, z: 0.5 });
}

function breakSetYaw(rt: MockRuntime): void {
  rt.interact.setYaw = () => err("TypeError: p.getRaw(...)[SRG.setYRot] is not a function");
}
function breakOnGround(rt: MockRuntime): void {
  rt.player.onGround = () => err("TypeError: p.getRaw(...)[SRG.onGround] is not a function");
}

function breakVelocity(rt: MockRuntime): void {
  rt.player.velocity = () =>
    err("TypeError: p.getRaw(...)[SRG.getDeltaMovement] is not a function");
}
function breakYaw(rt: MockRuntime): void {
  rt.player.yaw = () => err("TypeError: p.getRaw(...)[SRG.getYRot] is not a function");
}
function breakSetRotation(rt: MockRuntime): void {
  rt.interact.setRotation = () => err("TypeError: p.getRaw(...)[SRG.setXRot] is not a function");
}

function expectAllMovementReleased(rt: MockRuntime): void {
  for (const k of MOVE_KEYS) expect(rt.state.keys[k] ?? false, k).toBe(false);
}

describe("greedyStep on a runtime without steering / ground contact", () => {
  beforeEach(() => resetGreedyNav());

  it("a failed setYaw releases the keys and throws RUNTIME_UNSUPPORTED — forward is never held", () => {
    const rt = createMockRuntime();
    corridor(rt, 6);
    expect(greedyStep(rt, cfg, { x: 6, y: 64, z: 0 })).toBe("moving"); // healthy tick: walking
    expect(rt.state.keys["key.forward"]).toBe(true);

    breakSetYaw(rt);
    expect(() => greedyStep(rt, cfg, { x: 6, y: 64, z: 0 })).toThrow(RuntimeUnsupportedError);
    expectAllMovementReleased(rt);
  });

  it("a failed onGround read is not 'grounded': keys released, RUNTIME_UNSUPPORTED thrown", () => {
    const rt = createMockRuntime();
    corridor(rt, 6);
    expect(greedyStep(rt, cfg, { x: 6, y: 64, z: 0 })).toBe("moving");
    expect(rt.state.keys["key.forward"]).toBe(true);

    breakOnGround(rt);
    let thrown: unknown = null;
    expect(() => {
      try {
        greedyStep(rt, cfg, { x: 6, y: 64, z: 0 });
      } catch (e) {
        thrown = e;
        throw e;
      }
    }).toThrow(RuntimeUnsupportedError);
    expect(String(thrown)).toContain("player.onGround");
    expectAllMovementReleased(rt);
  });
});

describe("goto mission on a runtime without steering", () => {
  function bot(): {
    rt: MockRuntime;
    kernel: Kernel;
    st: ReturnType<typeof makeInitialState>;
    logs: LogRecord[];
  } {
    const logs: LogRecord[] = [];
    const sink: LogSink = { emit: (line) => logs.push(JSON.parse(line) as LogRecord) };
    const rt = createMockRuntime();
    const kernel = new Kernel(rt, new Logger(sink, "INFO"), new Bus(), cfg, GERDA_PHASES);
    kernel.register(core).registerMission(gotoMission);
    const st = makeInitialState();
    kernel.init(st);
    return { rt, kernel, st, logs };
  }

  for (const [what, breakIt] of [
    ["setYaw", breakSetYaw],
    ["onGround", breakOnGround],
  ] as const) {
    it(`a failed ${what} fails the mission loudly (ERROR, MISSION_FATAL RUNTIME_UNSUPPORTED), no walking`, () => {
      resetGreedyNav();
      const { rt, kernel, st, logs } = bot();
      corridor(rt, 10);
      breakIt(rt);
      kernel.startMission(st, "goto", { x: 10, y: 64, z: 0 });
      kernel.tick(st);

      expect(st.phase).toBe("ERROR");
      const fatal = logs.find((l) => l.event === "MISSION_FATAL");
      expect(fatal).toBeDefined();
      expect(JSON.stringify(fatal)).toContain("RUNTIME_UNSUPPORTED");
      expectAllMovementReleased(rt);
    });
  }
});

// The sub-machines own the tick while they run, so each one reads the facade itself. Every must*
// call site below has its own case: reverting any one of them to `void rt.interact.setYaw(…)` or
// to a fallback value (`onGround ?? true`, velocity 0, yaw 0) leaves the drive holding a key and
// returning "moving", which these cases refuse.
function expectUnsupported(rt: MockRuntime, op: string, drive: () => unknown): void {
  rt.keys.set("key.forward", true); // a drive in progress: the halt must let go of it
  let thrown: unknown = null;
  try {
    drive();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, `${op} failure must end the drive`).toBeInstanceOf(RuntimeUnsupportedError);
  expect(String(thrown)).toContain(op);
  expectAllMovementReleased(rt);
}

describe("parkour run-up on a runtime without steering / ground contact / velocity", () => {
  beforeEach(() => resetParkour());
  const LANDING = { x: 3, y: 64, z: 0 };
  const TAKEOFF = { x: 0, y: 64, z: 0 };

  /** A 3-wide gap from x=0 to x=3. `runway` adds solid floor behind the take-off (BACKUP first). */
  function gap(runway: boolean): MockRuntime {
    const rt = createMockRuntime();
    rt.setBlock(0, 63, 0, "minecraft:stone");
    rt.setBlock(3, 63, 0, "minecraft:stone");
    if (runway) for (let x = -3; x < 0; x++) rt.setBlock(x, 63, 0, "minecraft:stone");
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    expect(initParkourRun(rt, cfg, TAKEOFF, LANDING)).toBe(true);
    return rt;
  }

  it("healthy: BACKUP and CHARGE both steer and hold forward", () => {
    const backup = gap(true);
    expect(parkourStep(backup, cfg)).toBe("moving");
    expect(backup.state.keys["key.forward"]).toBe(true);
    resetParkour();
    const charge = gap(false);
    expect(parkourStep(charge, cfg)).toBe("moving");
    expect(charge.state.keys["key.forward"]).toBe(true);
  });

  it("onGround fails → RUNTIME_UNSUPPORTED", () => {
    const rt = gap(true);
    breakOnGround(rt);
    expectUnsupported(rt, "player.onGround", () => parkourStep(rt, cfg));
  });

  it("velocity fails → RUNTIME_UNSUPPORTED", () => {
    const rt = gap(true);
    breakVelocity(rt);
    expectUnsupported(rt, "player.velocity", () => parkourStep(rt, cfg));
  });

  it("setYaw fails in BACKUP → RUNTIME_UNSUPPORTED", () => {
    const rt = gap(true);
    breakSetYaw(rt);
    expectUnsupported(rt, "interact.setYaw", () => parkourStep(rt, cfg));
  });

  it("setYaw fails in CHARGE → RUNTIME_UNSUPPORTED", () => {
    const rt = gap(false); // no runway → straight to CHARGE
    breakSetYaw(rt);
    expectUnsupported(rt, "interact.setYaw", () => parkourStep(rt, cfg));
  });

  it("setYaw fails mid-air after the launch → RUNTIME_UNSUPPORTED", () => {
    const rt = gap(false);
    rt.setPos({ x: 0.9, y: 64, z: 0.5 }); // at the far lip: the walk-jump fires
    expect(parkourStep(rt, cfg)).toBe("moving");
    expect(parkourSnapshot().launched).toBe(true);
    breakSetYaw(rt);
    expectUnsupported(rt, "interact.setYaw", () => parkourStep(rt, cfg));
  });
});

describe("pillar ascent on a runtime without steering / ground contact / velocity", () => {
  beforeEach(() => resetPillar());
  const pcfg = makeGerdaConfig({ nav: { fillerBlocks: ["minecraft:cobblestone"] } });
  const UP = { x: 0, y: 65, z: 0 };

  /** Standing on stone at (0,63,0) with filler in the hotbar, `dx` off the column centre. */
  function column(dx: number): MockRuntime {
    const rt = createMockRuntime();
    rt.setBlock(0, 63, 0, "minecraft:stone");
    rt.state.slots.set(36, { id: "minecraft:cobblestone", count: 64, durabilityPct: 100 });
    rt.setPos({ x: 0.5 + dx, y: 64, z: 0.5 });
    return rt;
  }

  it("healthy: off-centre, CENTER steers and walks onto the column", () => {
    const rt = column(0.4);
    expect(pillarStep(rt, pcfg, UP)).toBe("moving");
    expect(rt.state.keys["key.forward"]).toBe(true);
  });

  it("velocity fails → RUNTIME_UNSUPPORTED", () => {
    const rt = column(0);
    breakVelocity(rt);
    expectUnsupported(rt, "player.velocity", () => pillarStep(rt, pcfg, UP));
  });

  it("onGround fails → RUNTIME_UNSUPPORTED", () => {
    const rt = column(0);
    breakOnGround(rt);
    expectUnsupported(rt, "player.onGround", () => pillarStep(rt, pcfg, UP));
  });

  it("setYaw fails while centring → RUNTIME_UNSUPPORTED", () => {
    const rt = column(0.4);
    breakSetYaw(rt);
    expectUnsupported(rt, "interact.setYaw", () => pillarStep(rt, pcfg, UP));
  });
});

describe("ladder climb on a runtime without steering", () => {
  it("healthy: faces the wall and holds forward; setYaw fails → RUNTIME_UNSUPPORTED", () => {
    const rt = createMockRuntime();
    for (const y of [64, 65]) {
      rt.setBlock(0, y, 0, "minecraft:ladder");
      rt.setBlock(1, y, 0, "minecraft:stone"); // the backing wall
    }
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    const feet = { x: 0, y: 64, z: 0 };
    const next = { x: 0, y: 65, z: 0 };
    expect(ladderStep(rt, feet, next)).toBe("moving");
    expect(rt.state.keys["key.forward"]).toBe(true);
    breakSetYaw(rt);
    expectUnsupported(rt, "interact.setYaw", () => ladderStep(rt, feet, next));
  });
});

describe("straight-up break aim on a runtime without rotation", () => {
  const OVERHEAD = { x: 0, y: 66, z: 0 };
  function standing(): MockRuntime {
    const rt = createMockRuntime();
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    rt.state.rotation = { yaw: 37, pitch: 0 };
    return rt;
  }

  it("healthy: keeps the real yaw, pitches straight up", () => {
    const rt = standing();
    aimAt(rt, cfg, OVERHEAD);
    expect(rt.state.rotation).toEqual({ yaw: 37, pitch: -90 });
  });

  it("setRotation fails → RUNTIME_UNSUPPORTED", () => {
    const rt = standing();
    breakSetRotation(rt);
    expectUnsupported(rt, "interact.setRotation", () => aimAt(rt, cfg, OVERHEAD));
  });

  it("yaw read fails → RUNTIME_UNSUPPORTED (never a fabricated yaw 0)", () => {
    const rt = standing();
    breakYaw(rt);
    expectUnsupported(rt, "player.yaw", () => aimAt(rt, cfg, OVERHEAD));
  });
});
