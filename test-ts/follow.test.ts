// follow mission + domain — lock a peer (by name or nearest), trail it holding a follow-gap,
// hold when close, wait + re-acquire when it leaves the snapshot. Movement is the greedy
// navigator (its own suite covers pathing); here we seed a floor like the goto test and assert
// the walk/hold/wait decision branches on the mock peer feed.
import { core } from "@/bot/capabilities/core";
import { followMission } from "@/bot/missions/follow";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import type { Peer } from "@/core/runtime/Runtime";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import { pickPeer } from "@/shared/domain/follow";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogRecord, type LogSink, Logger } from "@/shared/kernel/logger";
import { resetGreedyNav } from "@/shared/nav";
import { describe, expect, it } from "vitest";

function peer(name: string, uuid: string, x: number, y: number, z: number, health = 20): Peer {
  return { name, uuid, x, y, z, health, distance: 0 };
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
  kernel.register(core).registerMission(followMission);
  const state = makeInitialState();
  kernel.init(state);
  return { kernel, st: state, logs };
}

const ev = (logs: LogRecord[], name: string) => logs.find((l) => l.event === name);

describe("follow domain", () => {
  it("pickPeer matches a name case-insensitively, nearest of duplicates", () => {
    const peers: Peer[] = [
      { ...peer("Steve", "tp-far", 10, 64, 0), distance: 10 },
      { ...peer("bot_1", "b1", 3, 64, 0), distance: 3 },
      { ...peer("STEVE", "tp-near", 2, 64, 0), distance: 2 },
    ];
    expect(pickPeer(peers, "Steve")?.uuid).toBe("tp-near");
    expect(pickPeer(peers, "missing")).toBeNull();
  });

  it("pickPeer with no name returns the nearest peer", () => {
    const peers: Peer[] = [
      { ...peer("a", "a", 9, 64, 0), distance: 9 },
      { ...peer("b", "b", 4, 64, 0), distance: 4 },
    ];
    expect(pickPeer(peers, null)?.uuid).toBe("b");
    expect(pickPeer([], null)).toBeNull();
  });
  // The generic pursuit primitives (byUuid / withinRange / approachCell) that follow used to
  // own are now shared with hunt — covered in pursuit.test.ts.
});

describe("follow mission", () => {
  it("walks toward a peer beyond the gap, then holds once it's close", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    for (let x = 0; x <= 10; x++) rt.setBlock(x, 63, 0, "minecraft:stone"); // floor to the peer
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    rt.setPeers([peer("Steve", "tp", 8, 64, 0)]); // dist ~7.5 ≫ gap+slack → walk
    const { kernel, st, logs } = bot(rt);

    kernel.startMission(st, "follow", { target: "Steve" });
    expect(ev(logs, "FOLLOW_START")?.fields).toMatchObject({ target: "Steve" });
    for (let i = 0; i < 5; i++) kernel.tick(st);
    expect(rt.state.keys["key.forward"]).toBe(true); // engaged the navigator toward the peer
    expect(st.phase).toBe("FOLLOW");

    // Peer is now right next to us (within the gap) → it must release the keys and hold.
    rt.setPeers([peer("Steve", "tp", 1, 64, 0)]);
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    for (let i = 0; i < 3; i++) kernel.tick(st);
    expect(rt.state.keys["key.forward"]).toBe(false);
    expect(st.phase).not.toBe("ERROR");
    expect(kernel.activeMission()).not.toBeNull(); // persistent — never self-ends
  });

  it("a long HOLD next to the leader never trips the progress watchdog (universal progress contract exemption)", () => {
    // FOLLOW is a movement phase, so the universal progress contract would give it the DEFAULT feet
    // backstop — and a leader standing still within the gap keeps OUR feet frozen forever, which is
    // correct. The follow-walk policy gates on the `walking` latch, so a hold is exempt: driving well
    // past the phase-stall budget must NOT PAUSE the mission.
    resetGreedyNav();
    const rt = createMockRuntime();
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    rt.setPeers([peer("Steve", "tp", 1, 64, 0)]); // within the gap → hold, feet frozen
    const cfg = makeGerdaConfig();
    const { kernel, st } = bot(rt);
    kernel.startMission(st, "follow", { target: "Steve" });
    for (let i = 0; i < cfg.safety.phaseStallTicks + 20; i++) kernel.tick(st);
    expect(st.phase).toBe("FOLLOW"); // never false-fired to PAUSED
    expect(kernel.activeMission()).not.toBeNull();
  });

  it("waits (no ERROR) and re-acquires when the peer leaves the snapshot", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    rt.setPos({ x: 0, y: 64, z: 0 });
    rt.setPeers([]); // peer not sensed at all
    const cfg = makeGerdaConfig();
    const { kernel, st, logs } = bot(rt);

    kernel.startMission(st, "follow", { target: "Steve" });
    for (let i = 0; i <= cfg.follow.lostWaitTicks + 2; i++) kernel.tick(st);

    expect(ev(logs, "FOLLOW_WAIT")?.fields).toMatchObject({ target: "Steve" });
    expect(st.phase).not.toBe("ERROR");
    expect(kernel.activeMission()).not.toBeNull(); // still following — waits, never ends
  });
});
