import { PERSIST_SLICE, persistence } from "@/bot/capabilities/persistence";
import { MINE_EDGES } from "@/bot/missions/mine";
import { homeReturn } from "@/bot/missions/mine/home-return";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { createMockRuntime } from "@/core/runtime/mock";
import { makeWaypoint } from "@/shared/domain/waypoints";
import { Bus } from "@/shared/kernel/bus";
import { Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogRecord, type LogSink, Logger } from "@/shared/kernel/logger";
import { describe, expect, it } from "vitest";

// Verify-convention for the teleport legs: a /home that doesn't move us (no home set,
// command on cooldown) must surface a WARN, not proceed silently at the wrong spot.
function bot(waitTicks = 3) {
  const logs: LogRecord[] = [];
  const sink: LogSink = { emit: (line) => logs.push(JSON.parse(line) as LogRecord) };
  const rt = createMockRuntime();
  const cfg = makeGerdaConfig({ teleportWaitTicks: waitTicks, teleportMinMoveBlocks: 3 });
  const kernel = new Kernel(rt, new Logger(sink, "INFO"), new Bus(), cfg, GERDA_PHASES, [
    MINE_EDGES,
  ]);
  kernel.register(homeReturn);
  const st = makeInitialState();
  st.running = true;
  st.phase = "HOME";
  return { rt, kernel, st, logs };
}

const ev = (logs: LogRecord[], event: string) => logs.find((l) => l.event === event);

describe("home-return teleport verify-convention", () => {
  it("WARNs TELEPORT_NO_MOVE when the player didn't move (failed /home)", () => {
    const { rt, kernel, st, logs } = bot();
    rt.state.pos = { x: 100, y: 64, z: 100 }; // stays put — teleport failed
    for (let i = 0; i < 5; i++) kernel.tick(st);
    const warn = ev(logs, "TELEPORT_NO_MOVE");
    expect(warn).toBeDefined();
    expect(warn?.level).toBe("WARN");
    expect((warn?.fields as { leg: string }).leg).toBe("home");
    expect(st.phase).toBe("SCAN"); // still proceeds — WARN-only, not a hard stop
  });

  it("logs TELEPORT_OK when the player actually moved", () => {
    const { rt, kernel, st, logs } = bot();
    rt.state.pos = { x: 0, y: 64, z: 0 };
    kernel.tick(st); // tick 1: snapshot {0,0} + say /home
    rt.state.pos = { x: 500, y: 70, z: -300 }; // teleport landed
    for (let i = 0; i < 5; i++) kernel.tick(st);
    expect(ev(logs, "TELEPORT_OK")).toBeDefined();
    expect(ev(logs, "TELEPORT_NO_MOVE")).toBeUndefined();
  });

  // The dump leg's HOME often starts at the base already (a full bag right by the chest), so its
  // no-moves are not evidence of a missing home: they never disable the RECOVER safety teleport.
  it("HOME-leg no-moves never disable the home command, even far from home", () => {
    const { rt, kernel, st, logs } = bot();
    const persist = PERSIST_SLICE.init();
    persist.waypoints = [makeWaypoint("home", { x: 1000, y: 64, z: 1000 }, "home")];
    st.bb[PERSIST_SLICE.name] = persist;
    const legs = makeGerdaConfig().safety.homeNoEffectLimit + 2;
    for (let leg = 0; leg < legs; leg++) {
      st.phase = "HOME";
      st.phaseTicks = 0;
      rt.state.pos = { x: 100, y: 64, z: 100 }; // stays put every time
      for (let i = 0; i < 5 && st.phase === "HOME"; i++) kernel.tick(st);
      expect(st.phase).toBe("SCAN");
    }
    const homeCommand = makeGerdaConfig().homeCommand;
    expect(rt.state.chat.filter((c) => c === homeCommand)).toHaveLength(legs);
    expect(logs.filter((l) => l.event === "TELEPORT_NO_MOVE")).toHaveLength(legs);
    expect(ev(logs, "HOME_COMMAND_DISABLED")).toBeUndefined();
  });
});

// The "home" waypoint is where a /home landed the bot. A /home that did nothing (no server home, a
// cooldown) leaves the bot in the field: recording that spot as home made a later RECOVER no-move
// there look like "already home", which the disable streak does not count.
describe("home-return records home only where /home moved the bot", () => {
  function homeLeg(landAt: { x: number; y: number; z: number } | null) {
    const b = bot();
    b.kernel.register(persistence);
    b.kernel.init(b.st);
    b.st.phase = "HOME";
    b.rt.state.pos = { x: 100, y: 64, z: 100 };
    b.kernel.tick(b.st); // tick 1: snapshot + say /home
    if (landAt) b.rt.state.pos = landAt;
    for (let i = 0; i < 5 && b.st.phase === "HOME"; i++) b.kernel.tick(b.st);
    expect(b.st.phase).toBe("SCAN");
    b.kernel.tick(b.st); // persistence's guard sees the HOME→SCAN edge one tick later
    const persist = b.st.bb[PERSIST_SLICE.name] as { waypoints: { name: string }[] };
    return persist.waypoints.find((w) => w.name === "home");
  }

  it("a /home that moved the bot records home where it landed", () => {
    expect(homeLeg({ x: -500, y: 70, z: 300 })).toMatchObject({ x: -500, y: 70, z: 300 });
  });

  it("a /home that did not move the bot records no home", () => {
    expect(homeLeg(null)).toBeUndefined();
  });
});
