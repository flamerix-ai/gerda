// Descent hazard-cache RECORDING seam (descent-recoverability follow-up). When the greedy executor's
// hard descent veto fires mid-leg (`descent.unrecoverable` — a dip below the goal, past the rim's
// recovery budget), the mine navigation handler must persist the blocked target's column as a `ravine`
// HazardMarker in mc_world.json, so a LATER run's SCAN skips the same unclimbable pit (the cross-run
// twin of the in-run mem.cache). This drives the REAL mine-mission GOTO into a crafted pit and asserts
// the marker lands. The pure veto core is locked in descent-guard.test.ts; consumption in
// scan-hazard.test.ts — this closes the loop between them (veto → descentVetoFired → recordRavine).
import { core } from "@/bot/capabilities/core";
import { mineMission } from "@/bot/missions/mine";
import { MINING_SLICE, initMiningMem } from "@/bot/missions/mine/mining-mem";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { decodeJson } from "@/core/prim/json";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import type { ConfigOverrides } from "@/shared/config/schema";
import { getSection, normalizeModel } from "@/shared/domain/world-model";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogRecord, type LogSink, Logger } from "@/shared/kernel/logger";
import { resetGreedyNav } from "@/shared/nav";
import { beforeEach, describe, expect, it } from "vitest";

// Aerial escapes off (parkour/bridge/pillar) so the ONLY route down the crafted pit is a plain walk
// into the dip — where the hard descent veto bites. Smoothing/D* off keeps the route cell-by-cell.
const CFG: ConfigOverrides = {
  nav: { smoothPath: false, dStar: false, parkour: false, bridge: false, pillar: false },
};

function bot(cfg: ConfigOverrides = {}): {
  rt: MockRuntime;
  kernel: Kernel;
  st: BotState;
  logs: LogRecord[];
} {
  const logs: LogRecord[] = [];
  const sink: LogSink = { emit: (line) => logs.push(JSON.parse(line) as LogRecord) };
  const rt = createMockRuntime();
  const kernel = new Kernel(
    rt,
    new Logger(sink, "INFO"),
    new Bus(),
    makeGerdaConfig({ ...CFG, ...cfg, nav: { ...CFG.nav, ...cfg.nav } }),
    GERDA_PHASES,
  );
  kernel.register(core);
  kernel.registerMission(mineMission);
  const st = makeInitialState();
  kernel.init(st);
  kernel.startMission(st, "mine");
  return { rt, kernel, st, logs };
}

// A descending corridor of SAFE 3-drops (maxFallDamage 0 forbids 4-drops) that dips ONE block below a
// reachable far goal ledge. Rim stays 64 (high-water feet); the dip cell (feet 53) is 11 below rim
// (>8 allowance, empty bag ⇒ 0 filler) AND below goalY 55 → the veto fires stepping into it.
function pit(rt: MockRuntime): void {
  rt.setBlock(0, 63, 0, "minecraft:stone"); // feet 64  (rim)
  rt.setBlock(1, 60, 0, "minecraft:stone"); // feet 61
  rt.setBlock(2, 57, 0, "minecraft:stone"); // feet 58
  rt.setBlock(3, 54, 0, "minecraft:stone"); // feet 55  (9 below rim, but ≥ goalY 55 → allowed)
  rt.setBlock(4, 52, 0, "minecraft:stone"); // feet 53  (the dip — 11 below rim, < goalY → VETO)
  rt.setBlock(5, 53, 0, "minecraft:stone"); // feet 54  (climb back out)
  rt.setBlock(6, 54, 0, "minecraft:stone"); // feet 55
  rt.setBlock(7, 54, 0, "minecraft:stone"); // feet 55
  rt.setBlock(8, 54, 0, "minecraft:stone"); // feet 55  (goal ledge, far from the dip)
}

const GOAL = { x: 8, y: 55, z: 0 };
// The bot doesn't self-propel on the mock, so we hand-walk it down the corridor between ticks (same as
// the greedy-nav executor tests). rimY high-water persists across ticks because the goal is unchanged.
const WALK = [
  { x: 0.5, y: 64, z: 0.5 },
  { x: 1.5, y: 61, z: 0.5 },
  { x: 2.5, y: 58, z: 0.5 },
  { x: 3.5, y: 55, z: 0.5 }, // stepping on from here targets the dip → veto
];

function hazards(rt: MockRuntime) {
  const raw = rt.fs.read(makeGerdaConfig().worldModelPath);
  const parsed = raw.ok && raw.value ? decodeJson(raw.value) : null;
  const model = normalizeModel(parsed?.ok ? parsed.value : null);
  return getSection(model, rt.state.worldSig).hazards;
}

describe("descent veto records a persistent ravine hazard (cross-run mark it and don't come back)", () => {
  beforeEach(() => resetGreedyNav()); // descent rim / route cache are module singletons

  it("marks the blocked target column and logs NAV_RAVINE_MARKED", () => {
    const b = bot();
    pit(b.rt);
    const mem = initMiningMem();
    b.st.bb[MINING_SLICE.name] = mem;
    mem.standPos = GOAL;
    mem.navMode = "block";
    b.st.phase = "GOTO";
    b.st.phaseTicks = 0;

    // Walk the corridor tick-by-tick; the veto fires on the step into the dip.
    for (const p of WALK) {
      b.rt.setPos(p);
      b.kernel.tick(b.st);
      if (b.logs.some((l) => l.event === "NAV_RAVINE_MARKED")) break;
    }

    expect(b.logs.some((l) => l.event === "NAV_RAVINE_MARKED")).toBe(true);
    expect(hazards(b.rt)).toContainEqual(expect.objectContaining({ kind: "ravine", x: 8, z: 0 }));
  });

  it("records NOTHING when the descent guard is disabled (no veto to persist)", () => {
    const b = bot({ nav: { descentGuard: false } });
    pit(b.rt);
    const mem = initMiningMem();
    b.st.bb[MINING_SLICE.name] = mem;
    mem.standPos = GOAL;
    mem.navMode = "block";
    b.st.phase = "GOTO";
    b.st.phaseTicks = 0;

    for (const p of WALK) {
      b.rt.setPos(p);
      b.kernel.tick(b.st);
    }

    expect(b.logs.some((l) => l.event === "NAV_RAVINE_MARKED")).toBe(false);
    expect(hazards(b.rt)).toHaveLength(0);
  });
});
