// Replan safety (RCA I-4): a `goto` across a hollow-tower roof walked off a 39-block rim. A voluntary
// extend-replan ran SYNCHRONOUSLY in the worker tick (~1.06M reader calls, ~25 s live) while forward +
// sprint stayed pressed from the previous drive; every veto runs only between worker ticks, so none ran.
// The executor releases the movement keys BEFORE a blocking replan (this file); main.js releases them
// again when the worker tick stalls (the dead-man, test-ts/harness-contract.test.ts). A plan is never
// cut short by its read count: a cut turned a reachable leg behind a concave pocket into a false
// blocked_no_path, so the last describe pins that such a leg arrives.
// Fixture 2 is the live block dump of the incident region (test-ts/fixtures/i4-hollow-tower.json).
import { readFileSync } from "node:fs";
import { makeGerdaConfig } from "@/bot/profile/config";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import { type Result, type Vec3, err } from "@/core/runtime/types";
import { greedyStep, navRouteSnapshot, resetGreedyNav } from "@/shared/nav";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Marks the span of every A* search the executor runs.
const probe = vi.hoisted(() => ({ depth: 0 }));
vi.mock("@/shared/domain/planner", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/shared/domain/planner")>();
  const planPath = (...a: Parameters<typeof mod.planPath>): ReturnType<typeof mod.planPath> => {
    probe.depth++;
    const r = mod.planPath(...a);
    probe.depth--;
    return r;
  };
  return { ...mod, planPath };
});

const HOTBAR = 36;
const cfg = makeGerdaConfig({});

/** Record key.forward on every world read made INSIDE an A* search. */
function recordForwardDuringPlans(rt: MockRuntime): boolean[] {
  const seen: boolean[] = [];
  const read = rt.world.blockId;
  rt.world.blockId = (b: Vec3): Result<string> => {
    if (probe.depth > 0) seen.push(rt.state.keys["key.forward"] === true);
    return read(b);
  };
  return seen;
}

describe("replan releases the movement keys first (RCA I-4 primary)", () => {
  beforeEach(() => resetGreedyNav());

  it("forward is up on every world read of every replan, first plan and extend alike", () => {
    const rt = createMockRuntime();
    // The RCA shape: a 10-cell roof at y106 (feet y107), void beyond its rim at x=9, ground 38 below.
    for (let x = 0; x <= 9; x++) rt.setBlock(x, 106, 0, "minecraft:stone");
    for (let x = -4; x <= 40; x++)
      for (let z = -4; z <= 4; z++) rt.setBlock(x, 68, z, "minecraft:stone");
    rt.state.slots.set(HOTBAR, { id: "minecraft:cobblestone", count: 64, durabilityPct: 100 });
    const seen = recordForwardDuringPlans(rt);

    // Walk the roof one cell per call, 2 ticks apart (clears the replan cooldown at the seams). Before
    // each call forward is HELD, as the previous tick's drive left it.
    for (let x = 0; x <= 9; x++) {
      rt.state.tick = x * 2;
      rt.setPos({ x: x + 0.5, y: 107, z: 0.5 });
      rt.state.keys["key.forward"] = true;
      rt.state.keys["key.sprint"] = true;
      greedyStep(rt, cfg, { x: 30, y: 107, z: 0 }, { column: true, bestEffort: true });
    }

    const snap = navRouteSnapshot();
    expect(snap.plans).toBeGreaterThanOrEqual(2); // the first plan AND at least one replan after it
    expect(seen.length).toBeGreaterThan(100); // the searches really read the world
    expect(seen.filter((held) => held)).toEqual([]); // no read of any search saw forward held
  });
});

/** Drive a column leg with a perfect body: each call the bot stands on the cell the last drive aimed
 *  at, with forward + sprint held as that drive left them. Returns the cells driven to and the last
 *  step outcome. */
function driveLeg(
  rt: MockRuntime,
  start: Vec3,
  target: Vec3,
  calls: number,
): { driven: Vec3[]; last: string } {
  const driven: Vec3[] = [];
  let feet: Vec3 = start;
  let last = "";
  for (let i = 0; i < calls; i++) {
    rt.state.tick = i * 11; // past cfg.nav.replanTicks every call: each seam may extend
    rt.setPos({ x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 });
    rt.state.keys["key.forward"] = true;
    rt.state.keys["key.sprint"] = true;
    last = greedyStep(rt, cfg, target, { column: true, bestEffort: true });
    if (last !== "moving") break;
    const next = navRouteSnapshot().lastStep.next;
    if (!next) break;
    driven.push(next);
    feet = next;
  }
  return { driven, last };
}

// — The live incident region ——————————————————————————————————————————————————————————————————————

interface Region {
  x: [number, number];
  y: [number, number];
  z: [number, number];
  cols: string[];
}
const REGION: Region = JSON.parse(readFileSync("test-ts/fixtures/i4-hollow-tower.json", "utf8"));
const ROOF_Y = 106; // the roof's top block at z=333 (feet y107); its rim is x=575
const RIM_X = 575;

/** A mock world of the dumped region: runs of blocks inside the box, air elsewhere in it, and an
 *  UNKNOWN read (err → the nav reader's null) outside it, as the replay of the live plan saw it. */
function regionRuntime(): MockRuntime {
  const rt = createMockRuntime();
  for (const col of REGION.cols) {
    const [xz, runs = ""] = col.split("|");
    const [x, z] = (xz ?? "").split(",").map(Number);
    for (const run of runs ? runs.split(",") : []) {
      const [span, id] = run.split(":");
      const [y0, y1] = (span ?? "").split("-").map(Number);
      for (let y = y0 ?? 0; y <= (y1 ?? -1); y++) rt.setBlock(x ?? 0, y, z ?? 0, `minecraft:${id}`);
    }
  }
  const inBox = (b: Vec3): boolean =>
    b.x >= REGION.x[0] &&
    b.x <= REGION.x[1] &&
    b.y >= REGION.y[0] &&
    b.y <= REGION.y[1] &&
    b.z >= REGION.z[0] &&
    b.z <= REGION.z[1];
  const read = rt.world.blockId;
  rt.world.blockId = (b: Vec3): Result<string> => (inBox(b) ? read(b) : err("outside the dump"));
  rt.state.slots.set(HOTBAR, { id: "minecraft:cobblestone", count: 64, durabilityPct: 100 });
  return rt;
}

describe("the I-4 hollow tower (live block dump)", () => {
  beforeEach(() => resetGreedyNav());

  it("the dump is the incident: a roof at y106 that ends at x=575 over a ~39-block drop", () => {
    const rt = regionRuntime();
    const at = (x: number, y: number): string | null => {
      const r = rt.world.blockId({ x, y, z: 333 });
      return r.ok ? r.value : null;
    };
    expect(at(570, ROOF_Y)).not.toBe("minecraft:air");
    expect(at(RIM_X, ROOF_Y)).not.toBe("minecraft:air");
    for (let y = 68; y <= ROOF_Y + 1; y++) expect(at(RIM_X + 1, y)).toBe("minecraft:air");
  });

  it("no replan reads the world with forward held, and the bot never drives past the rim", () => {
    const rt = regionRuntime();
    const seen = recordForwardDuringPlans(rt);
    const { driven, last } = driveLeg(
      rt,
      { x: 566, y: 107, z: 333 },
      { x: 580, y: 107, z: 333 },
      12,
    );

    expect(navRouteSnapshot().plans).toBeGreaterThanOrEqual(2); // the first plan and an extend
    expect(seen.length).toBeGreaterThan(100_000); // the incident-sized searches really ran
    expect(seen.filter((held) => held)).toEqual([]);
    // The best-effort route ends at the rim (RCA H2): every driven cell is on the roof, x ≤ 575,
    // the last one the rim itself, and the leg then blocks instead of driving on.
    for (const c of driven) expect(c.x <= RIM_X && c.y === ROOF_Y + 1).toBe(true);
    expect(driven[driven.length - 1]).toEqual({ x: RIM_X, y: ROOF_Y + 1, z: 333 });
    expect(last).toBe("blocked_no_path");
  }, 120_000);
});

// — A reachable leg behind a concave pocket arrives ——————————————————————————————————————————————————

/** A stone plain (top y63, feet y64) with a U-shaped trench of `hazard` opening toward the start,
 *  5 cells wide (past cfg.nav.parkourMaxGap): the side walls are z ∈ ±13..17 for x ∈ 2..17, the
 *  back wall x ∈ 13..17 for |z| ≤ 17. Inside the U (x 2..12, |z| ≤ 12, half-width 12) the plain
 *  goes on. The trench is lava from y56 to the surface, or air all the way down (a bottomless
 *  ravine). The goal column (22, 0) sits behind the U's closed back, so the straight line runs into
 *  the pocket and A* must exhaust it before it goes round a side wall. No filler in the bag: no
 *  bridge across. */
function pocketRuntime(hazard: "minecraft:lava" | "minecraft:air"): MockRuntime {
  const rt = createMockRuntime();
  for (let x = -6; x <= 30; x++)
    for (let z = -24; z <= 24; z++) {
      const side = x >= 2 && x <= 17 && Math.abs(z) >= 13 && Math.abs(z) <= 17;
      const back = x >= 13 && x <= 17 && Math.abs(z) <= 17;
      const trench = side || back;
      if (trench && hazard === "minecraft:air") continue;
      for (let y = 56; y <= 63; y++) rt.setBlock(x, y, z, trench ? hazard : "minecraft:stone");
    }
  return rt;
}

describe("a reachable goal behind a concave pocket arrives (no plan is cut short)", () => {
  beforeEach(() => resetGreedyNav());

  for (const [name, hazard] of [
    ["lava lake", "minecraft:lava"],
    ["air ravine", "minecraft:air"],
  ] as const) {
    it(`${name}: the U-pocket leg goes round and arrives`, () => {
      const rt = pocketRuntime(hazard);
      const { driven, last } = driveLeg(rt, { x: 0, y: 64, z: 0 }, { x: 22, y: 64, z: 0 }, 200);
      expect(last).toBe("arrived");
      // It went round a side wall, not through the pocket's back.
      expect(driven.some((c) => Math.abs(c.z) >= 18)).toBe(true);
    }, 120_000);
  }
});
