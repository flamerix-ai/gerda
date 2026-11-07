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
import { greedyStep, navRouteSnapshot, navSearchPending, resetGreedyNav } from "@/shared/nav";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Marks the span of every run of every A* search the executor opens, and counts the searches. Per
// run it also counts the reader calls (the unit cfg.nav.planReadsPerTick budgets) and keeps the most
// any run spent past its largest single expansion: the budget is checked between expansions.
const probe = vi.hoisted(() => ({ depth: 0, searches: 0, maxRunOverExpansion: 0 }));
vi.mock("@/shared/domain/planner", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/shared/domain/planner")>();
  class PlanSearch extends mod.PlanSearch {
    constructor(...a: ConstructorParameters<typeof mod.PlanSearch>) {
      super(...a);
      probe.searches++;
    }
    override run(...[reader, yieldNow]: Parameters<InstanceType<typeof mod.PlanSearch>["run"]>) {
      let calls = 0;
      let sinceYield = 0;
      let maxExpansion = 0;
      probe.depth++;
      const r = super.run(
        (x, y, z) => {
          calls++;
          sinceYield++;
          return reader(x, y, z);
        },
        () => {
          maxExpansion = Math.max(maxExpansion, sinceYield);
          sinceYield = 0;
          return yieldNow();
        },
      );
      probe.depth--;
      probe.maxRunOverExpansion = Math.max(probe.maxRunOverExpansion, calls - maxExpansion);
      return r;
    }
  }
  return { ...mod, PlanSearch };
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

    // Walk the roof one cell per served step, 2 ticks a call (clears the replan cooldown at the
    // seams); while a search runs the body stands. Before each call forward is HELD, as the previous
    // tick's drive left it.
    let tick = 0;
    for (let x = 0; x <= 9; x++) {
      rt.setPos({ x: x + 0.5, y: 107, z: 0.5 });
      do {
        rt.state.tick = tick;
        tick += 2;
        rt.state.keys["key.forward"] = true;
        rt.state.keys["key.sprint"] = true;
        greedyStep(rt, cfg, { x: 30, y: 107, z: 0 }, { column: true, bestEffort: true });
      } while (navSearchPending());
    }

    const snap = navRouteSnapshot();
    expect(snap.plans).toBeGreaterThanOrEqual(2); // the first plan AND at least one replan after it
    expect(seen.length).toBeGreaterThan(100); // the searches really read the world
    expect(seen.filter((held) => held)).toEqual([]); // no read of any search saw forward held
  });
});

/** Drive a column leg with a perfect body: each call the bot stands on the cell the last drive aimed
 *  at (or where it stood, while a route search runs), with forward + sprint held as that drive left
 *  them, `pace` ticks after the previous call (the default is past cfg.nav.replanTicks, so each seam
 *  may extend). Stops after `steps` served steps, or once the feet stand on `stopAt`. Returns the
 *  cells driven to, the last step outcome and the most search reads `seen` gained in one call. */
function driveLeg(
  rt: MockRuntime,
  start: Vec3,
  target: Vec3,
  steps: number,
  pace = 11,
  stopAt?: Vec3,
  seen: boolean[] = [],
): { driven: Vec3[]; last: string; maxCallReads: number } {
  const driven: Vec3[] = [];
  let feet: Vec3 = start;
  let last = "";
  let maxCallReads = 0;
  for (let i = 0; driven.length < steps && i < 2000; i++) {
    if (stopAt && feet.x === stopAt.x && feet.y === stopAt.y && feet.z === stopAt.z) break;
    rt.state.tick = i * pace;
    rt.setPos({ x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 });
    rt.state.keys["key.forward"] = true;
    rt.state.keys["key.sprint"] = true;
    const before = seen.length;
    last = greedyStep(rt, cfg, target, { column: true, bestEffort: true });
    maxCallReads = Math.max(maxCallReads, seen.length - before);
    if (last !== "moving") break;
    if (navSearchPending()) continue; // the search runs on; the body holds still
    const next = navRouteSnapshot().lastStep.next;
    if (!next) break;
    driven.push(next);
    feet = next;
  }
  return { driven, last, maxCallReads };
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
    expect(seen.length).toBeGreaterThan(50_000); // the two incident-sized searches really ran
    expect(seen.filter((held) => held)).toEqual([]);
    // The best-effort route ends at the rim (RCA H2): every driven cell is on the roof, x ≤ 575,
    // the last one the rim itself, and the leg then blocks instead of driving on.
    for (const c of driven) expect(c.x <= RIM_X && c.y === ROOF_Y + 1).toBe(true);
    expect(driven[driven.length - 1]).toEqual({ x: RIM_X, y: ROOF_Y + 1, z: 333 });
    expect(last).toBe("blocked_no_path");
  }, 120_000);

  // RCA K-2: every search of this leg ends at the rim, and live each one held the worker tick for
  // about 30 s. One re-search that ends where the last route ended means the frontier stopped:
  // the leg runs to the rim and blocks without a search from every cell on the way.
  for (const pace of [2, 11]) {
    it(`the leg searches twice, not from every cell (K-2), at ${pace} ticks a cell`, () => {
      const rt = regionRuntime();
      probe.searches = 0;
      const { driven, last } = driveLeg(
        rt,
        { x: 566, y: 107, z: 333 },
        { x: 580, y: 107, z: 333 },
        12,
        pace,
      );

      expect(probe.searches).toBe(2); // the first plan and the one re-search that did not get further
      expect(driven[driven.length - 1]).toEqual({ x: RIM_X, y: ROOF_Y + 1, z: 333 });
      expect(last).toBe("blocked_no_path");
    }, 120_000);
  }

  it("no worker tick spends more than one read budget on a search (K-2)", () => {
    probe.maxRunOverExpansion = 0;
    const rt = regionRuntime();
    const seen = recordForwardDuringPlans(rt);
    const { last, maxCallReads } = driveLeg(
      rt,
      { x: 566, y: 107, z: 333 },
      { x: 580, y: 107, z: 333 },
      12,
      11,
      undefined,
      seen,
    );
    expect(last).toBe("blocked_no_path");
    expect(seen.length).toBeGreaterThan(10 * cfg.nav.planReadsPerTick); // the searches span ticks
    // A live read is one of the reader calls the budget counts (1133 measured; a whole search ~37k).
    expect(maxCallReads).toBeLessThanOrEqual(cfg.nav.planReadsPerTick);
    // The budget itself: a run stops at most one expansion past it.
    expect(probe.maxRunOverExpansion).toBeGreaterThan(0);
    expect(probe.maxRunOverExpansion).toBeLessThanOrEqual(cfg.nav.planReadsPerTick);
  }, 120_000);

  it("the refusal is reported once: the next call on the leg searches again", () => {
    const rt = regionRuntime();
    probe.searches = 0;
    const target = { x: 580, y: 107, z: 333 };
    driveLeg(rt, { x: 566, y: 107, z: 333 }, target, 12);
    expect(probe.searches).toBe(2);
    rt.state.tick += 100; // past the cooldown; the bot still stands on the rim
    greedyStep(rt, cfg, target, { column: true, bestEffort: true });
    expect(probe.searches).toBe(3);
  }, 120_000);

  it("a bot pushed off the stopped route replans instead of blocking", () => {
    const rt = regionRuntime();
    probe.searches = 0;
    const target = { x: 580, y: 107, z: 333 };
    // Six calls end on (572,107,333): the re-search at 571 already ended on the rim.
    driveLeg(rt, { x: 566, y: 107, z: 333 }, target, 6);
    expect(probe.searches).toBe(2);
    rt.state.tick += 1; // inside the cooldown: only a forced replan may search
    rt.setPos({ x: 572.5, y: ROOF_Y + 1, z: 334.5 }); // a roof cell beside the route, off it
    const step = greedyStep(rt, cfg, target, { column: true, bestEffort: true });
    expect(probe.searches).toBe(3);
    expect(step).toBe("moving");
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
