import { PERSIST_SLICE, persistence } from "@/bot/capabilities/persistence";
import { MINE_EDGES } from "@/bot/missions/mine";
import { MINING_SLICE, type MiningMem, initMiningMem } from "@/bot/missions/mine/mining-mem";
import { navigation } from "@/bot/missions/mine/navigation";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { createMockRuntime } from "@/core/runtime/mock";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogSink, Logger } from "@/shared/kernel/logger";
import { resetGreedyNav } from "@/shared/nav";
import { describe, expect, it } from "vitest";
import { untilSearchEnds } from "./_greedy-step";

const sink: LogSink = { emit: () => {} };

function bot() {
  const rt = createMockRuntime();
  // navigation's GOTO arrival transitions into SCAN (a mine edge), so load MINE_EDGES.
  // GOTO is greedy-only now (Baritone removed). Greedy key-walks; the mock has no physics,
  // so a test lays a floor (so greedy emits "moving") and simulates arrival with rt.setPos.
  resetGreedyNav(); // greedy planner cache is a module singleton
  const kernel = new Kernel(
    rt,
    new Logger(sink, "ERR"),
    new Bus(),
    makeGerdaConfig({}),
    GERDA_PHASES,
    [MINE_EDGES],
  );
  kernel.register(persistence).register(navigation);
  const st = makeInitialState();
  kernel.init(st);
  return { rt, kernel, st };
}

/** A flat stone floor at y=63 spanning the rectangle [0..maxX]×[0..maxZ] so greedy can walk it. */
function floor(rt: ReturnType<typeof createMockRuntime>, maxX: number, maxZ: number): void {
  for (let x = 0; x <= maxX; x++)
    for (let z = 0; z <= maxZ; z++) rt.setBlock(x, 63, z, "minecraft:stone");
}

function addVein(kernel: Kernel, st: BotState, name: string, x: number, y: number, z: number) {
  kernel.command(st, { type: "add_waypoint", name, kind: "vein", x, y, z });
}

describe("goto_waypoint", () => {
  it("walks (GoalXZ column) to a named vein, then SCANs on arrival", () => {
    const { rt, kernel, st } = bot();
    floor(rt, 20, 5);
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    addVein(kernel, st, "vein_a", 20, 50, 5);

    kernel.command(st, { type: "goto_waypoint", name: "vein_a" });
    expect(st.phase).toBe("GOTO");
    expect(st.running).toBe(true);
    // The leg is an "xz" column approach (Y-free) — greedy aims at the X/Z, not the (unknown) surface Y.
    expect((st.bb[MINING_SLICE.name] as MiningMem).navMode).toBe("xz");

    untilSearchEnds(() => kernel.tick(st)); // greedy walks toward the column — still en route
    expect(rt.state.keys["key.forward"]).toBe(true);
    expect(st.phase).toBe("GOTO");

    rt.setPos({ x: 20, y: 70, z: 5 }); // arrived horizontally (Y differs — the column approach ignores it)
    kernel.tick(st);
    expect(st.phase).toBe("SCAN");
  });

  it("with no name, heads for the nearest non-depleted vein", () => {
    const { rt, kernel, st } = bot();
    floor(rt, 8, 0);
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    addVein(kernel, st, "far", 100, 64, 0);
    addVein(kernel, st, "near", 8, 64, 0);

    kernel.command(st, { type: "goto_waypoint" });
    kernel.tick(st);
    // Picked the NEAR vein as the stand-pos column and started walking toward it.
    expect((st.bb[MINING_SLICE.name] as MiningMem).standPos).toMatchObject({ x: 8, z: 0 });
    expect(rt.state.keys["key.forward"]).toBe(true);
  });

  it("can be issued while PAUSED (IDLE/PAUSED → GOTO edge)", () => {
    const { rt, kernel, st } = bot();
    rt.setPos({ x: 0, y: 64, z: 0 });
    addVein(kernel, st, "v", 12, 64, 0);
    st.phase = "PAUSED";

    kernel.command(st, { type: "goto_waypoint", name: "v" });
    expect(st.phase).toBe("GOTO");
  });

  it("ignores a goto_waypoint with no matching waypoint", () => {
    const { rt, kernel, st } = bot();
    rt.setPos({ x: 0, y: 64, z: 0 });
    kernel.command(st, { type: "goto_waypoint", name: "nope" });
    expect(st.phase).toBe("IDLE");
    expect(st.running).toBe(false);
  });

  it("a refused waypoint (no GOTO edge from this phase) leaves the nav target untouched", () => {
    const { rt, kernel, st } = bot();
    rt.setPos({ x: 0, y: 64, z: 0 });
    addVein(kernel, st, "v", 30, 64, 0);
    const m = initMiningMem();
    m.standPos = { x: 5, y: 64, z: 5 };
    m.origin = { x: 1, y: 64, z: 1 };
    st.bb[MINING_SLICE.name] = m;
    st.phase = "DUMP"; // DUMP → GOTO is not an edge
    kernel.command(st, { type: "goto_waypoint", name: "v" });
    expect(st.phase).toBe("DUMP");
    expect(m.standPos).toEqual({ x: 5, y: 64, z: 5 });
    expect(m.navMode).toBe("block");
    expect(m.arrivalPhase).toBeNull();
    expect(m.origin).toEqual({ x: 1, y: 64, z: 1 });
  });

  it("resets stale scan progress so SCAN re-anchors at the destination", () => {
    const { rt, kernel, st } = bot();
    rt.setPos({ x: 0, y: 64, z: 0 });
    addVein(kernel, st, "v", 30, 64, 0);

    const mining = st.bb[MINING_SLICE.name] as MiningMem | undefined;
    // Simulate a previous area's scan state lingering on the blackboard.
    const m = mining ?? initMiningMem();
    m.origin = { x: 999, y: 999, z: 999 };
    m.scanCycle = 5;
    st.bb[MINING_SLICE.name] = m;

    kernel.command(st, { type: "goto_waypoint", name: "v" });
    const after = st.bb[MINING_SLICE.name] as MiningMem;
    expect(after.origin).toBeNull();
    expect(after.scanCycle).toBe(0);
    expect(after.navMode).toBe("xz");
    expect(after.arrivalPhase).toBe("SCAN");
    // sanity: the persist slice actually had the waypoint
    expect((st.bb[PERSIST_SLICE.name] as { waypoints: unknown[] }).waypoints.length).toBe(1);
  });
});
