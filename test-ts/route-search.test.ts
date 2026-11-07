// What a route search and a cached route do when the goal or the body moves while they live: the
// decision in routeNext (src/shared/nav/route.ts#routeNext). Each fixture varies on every axis live data
// varies on: the sign, x alone, y alone, z alone, and exactly at the slack and one cell past it.
import { makeGerdaConfig } from "@/bot/profile/config";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import type { Vec3 } from "@/core/runtime/types";
import {
  type GreedyOpts,
  greedyStep,
  navRouteSnapshot,
  navSearchPending,
  navSearchResumed,
  resetGreedyNav,
} from "@/shared/nav";
import { beforeEach, describe, expect, it } from "vitest";
import { greedyStepPlanned } from "./_greedy-step";

const cfg = makeGerdaConfig({});
const slowCfg = makeGerdaConfig({ nav: { planReadsPerTick: 5 } }); // a search here spans many calls
const SLACK = cfg.nav.goalShiftCells;
const REPLAN = cfg.nav.replanTicks;

const AXES: readonly (readonly [string, Vec3])[] = [
  ["+x", { x: 1, y: 0, z: 0 }],
  ["-x", { x: -1, y: 0, z: 0 }],
  ["+y", { x: 0, y: 1, z: 0 }],
  ["-y", { x: 0, y: -1, z: 0 }],
  ["+z", { x: 0, y: 0, z: 1 }],
  ["-z", { x: 0, y: 0, z: -1 }],
];
const add = (v: Vec3, by: Vec3, n: number): Vec3 => ({
  x: v.x + by.x * n,
  y: v.y + by.y * n,
  z: v.z + by.z * n,
});
const center = (c: Vec3): Vec3 => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 });

/** A stone floor at y=63 along `dir` for `len` cells from the origin. */
function floorAlong(rt: MockRuntime, dir: Vec3, len: number): void {
  for (let i = 0; i <= len; i++) {
    const c = add({ x: 0, y: 63, z: 0 }, dir, i);
    rt.setBlock(c.x, c.y, c.z, "minecraft:stone");
  }
}
const X = { x: 1, y: 0, z: 0 };
const Z = { x: 0, y: 0, z: 1 };

function atCorridorStart(len: number): MockRuntime {
  const rt = createMockRuntime();
  floorAlong(rt, X, len);
  rt.setPos(center({ x: 0, y: 64, z: 0 }));
  return rt;
}

// A wall the search has to go round: long enough at the default budget that a search spans ticks.
const chaseOpts: GreedyOpts = { column: true, bestEffort: true };
function wallArena(rt: MockRuntime, wallHalf = 20): void {
  for (let x = -30; x <= 30; x++)
    for (let z = -30; z <= 30; z++) rt.setBlock(x, 63, z, "minecraft:stone");
  for (let z = -wallHalf; z <= wallHalf; z++)
    for (let y = 64; y <= 67; y++) rt.setBlock(8, y, z, "minecraft:bedrock");
}
const BEHIND_WALL = { x: 16.5, y: 64, z: 0.5 };

describe("a goal that moves while the route serves it", () => {
  beforeEach(() => resetGreedyNav());

  for (const [axis, dir] of [
    ["x", X],
    ["z", Z],
  ] as const) {
    for (const stride of [1, 2, SLACK]) {
      it(`a goal stepped ${stride} cell(s) along ${axis} at a time is never reported blocked`, () => {
        for (const pace of [2, 5, REPLAN + 2]) {
          resetGreedyNav();
          const rt = createMockRuntime();
          floorAlong(rt, dir, 60);
          let feet: Vec3 = { x: 0, y: 64, z: 0 };
          rt.setPos(center(feet));
          let tick = 0;
          for (let cell = 0; cell < 18; cell += stride) {
            const goal = add(feet, dir, stride);
            for (let i = 0; i < pace; i++) {
              rt.state.tick = tick++;
              expect(greedyStep(rt, cfg, center(goal), { block: true })).toBe("moving");
            }
            feet = goal;
            rt.setPos(center(feet));
          }
        }
      });
    }
  }

  // The drop hops after it lands; a hop into the cooldown with the route already walked is the case.
  for (const hopAt of [2, 8, 11, 14]) {
    for (const [axis, dir] of [
      ["x", X],
      ["z", Z],
    ] as const) {
      it(`a drop that hops along ${axis} at tick ${hopAt} is walked to, not given up on`, () => {
        const rt = createMockRuntime();
        for (let x = -2; x <= 14; x++)
          for (let z = -2; z <= 14; z++) rt.setBlock(x, 63, z, "minecraft:stone");
        let pos: Vec3 = { x: 0.5, y: 64, z: 0.5 };
        rt.setPos(pos);
        const first = add({ x: 0.5, y: 64.2, z: 0.5 }, dir, 3);
        let r = "moving";
        for (let t = 0; t < 120 && r === "moving"; t++) {
          rt.state.tick = t;
          const drop = t < hopAt ? first : add(first, dir, 2);
          r = greedyStep(rt, cfg, drop, { arrivalRadius: cfg.loot.pickupDist });
          if (rt.state.keys["key.forward"]) pos = add(pos, dir, 0.216);
          rt.setPos(pos);
        }
        expect(r).toBe("arrived");
      });
    }
  }

  for (const [axis, by] of AXES) {
    it(`a route serves a goal moved the slack along ${axis}, and replans one cell past it`, () => {
      const goal = { x: 20, y: 64, z: 0 };
      const planned = (shift: number): number => {
        resetGreedyNav();
        const rt = atCorridorStart(30);
        rt.state.tick = 0;
        greedyStepPlanned(rt, cfg, goal);
        rt.setPos(center({ x: 1, y: 64, z: 0 }));
        rt.state.tick = 1; // inside the cooldown: only a forced replan may search
        greedyStepPlanned(rt, cfg, add(goal, by, shift));
        return navRouteSnapshot().plans;
      };
      expect(planned(SLACK)).toBe(1);
      expect(planned(SLACK + 1)).toBe(2);
    });
  }

  it("a route to a goal since moved ends short of it: at its end the moved goal searches", () => {
    const rt = atCorridorStart(12);
    const first = { x: 2, y: 64, z: 0 };
    const moved = { x: 4, y: 64, z: 0 };
    rt.state.tick = 0;
    greedyStep(rt, slowCfg, center(first), { block: true });
    expect(navSearchPending()).toBe(true);
    let t = 1;
    for (; t < 100 && navSearchPending(); t++) {
      rt.state.tick = t;
      // the search for `first` runs on
      expect(greedyStep(rt, slowCfg, center(moved), { block: true })).toBe("moving");
    }
    expect(t).toBeLessThan(REPLAN);
    rt.setPos(center(first)); // the route walked, the cooldown still running
    rt.state.tick = t;
    expect(greedyStepPlanned(rt, slowCfg, center(moved), { block: true })).toBe("moving");
    expect(navRouteSnapshot().lastStep.next).toEqual({ x: 3, y: 64, z: 0 });
  });

  it("a route serves the goal of the call its search ended on, not the call before", () => {
    const target = { x: 20, y: 64, z: 0 };
    const callsToEnd = (): number => {
      const rt = atCorridorStart(30);
      let calls = 1;
      for (greedyStep(rt, slowCfg, target); navSearchPending(); calls++)
        greedyStep(rt, slowCfg, target);
      return calls;
    };
    const calls = callsToEnd();
    resetGreedyNav();
    const rt = atCorridorStart(30);
    for (let i = 1; i < calls; i++) greedyStep(rt, slowCfg, target);
    const last = { x: 20 + SLACK, y: 64, z: 0 };
    greedyStep(rt, slowCfg, last); // the search ends on this call
    expect(navSearchPending()).toBe(false);
    expect(navRouteSnapshot().plans).toBe(1);
    rt.state.tick = 1;
    greedyStep(rt, slowCfg, { x: 20 + 2 * SLACK, y: 64, z: 0 }); // the slack again, from there
    expect(navRouteSnapshot().plans).toBe(1);
    expect(navSearchPending()).toBe(false);
  });

  it("a replanned route serves the goal it was planned for, not the one before it", () => {
    const rt = atCorridorStart(40);
    greedyStepPlanned(rt, cfg, { x: 10, y: 64, z: 0 });
    rt.state.tick = 1;
    greedyStepPlanned(rt, cfg, { x: 10 + 2 * SLACK, y: 64, z: 0 }); // jumped: replanned
    expect(navRouteSnapshot().plans).toBe(2);
    rt.state.tick = 2;
    greedyStepPlanned(rt, cfg, { x: 11 + 2 * SLACK, y: 64, z: 0 }); // moved a cell from there
    expect(navRouteSnapshot().plans).toBe(2);
  });
});

describe("what the search change must leave as it was", () => {
  beforeEach(() => resetGreedyNav());

  it("a cached step whose edge went away is replanned, not driven", () => {
    const rt = createMockRuntime();
    for (let x = 0; x <= 10; x++)
      for (let z = -1; z <= 1; z++) rt.setBlock(x, 63, z, "minecraft:stone");
    rt.setPos(center({ x: 0, y: 64, z: 0 }));
    greedyStepPlanned(rt, cfg, center({ x: 10, y: 64, z: 0 }), { block: true });
    expect(navRouteSnapshot().lastStep.next).toEqual({ x: 1, y: 64, z: 0 });
    rt.setBlock(1, 63, 0, "minecraft:air"); // the floor of the next cell falls away
    rt.state.tick = cfg.nav.worldViewTtlTicks + 1; // the edge check reads the world-view cache
    expect(greedyStepPlanned(rt, cfg, center({ x: 10, y: 64, z: 0 }), { block: true })).toBe(
      "moving",
    );
    expect(navRouteSnapshot().plans).toBe(2);
    expect(navRouteSnapshot().lastStep.next).not.toEqual({ x: 1, y: 64, z: 0 });
  });

  it("the doorstep micro-walk of a complete route does not search again", () => {
    const rt = createMockRuntime();
    for (let x = 9; x <= 12; x++)
      for (let z = 9; z <= 12; z++) rt.setBlock(x, 63, z, "minecraft:stone");
    rt.setPos({ x: 11.95, y: 64, z: 11.95 }); // in a goal cell, outside the radius
    for (let t = 0; t < 3 * REPLAN; t += REPLAN) {
      rt.state.tick = t;
      expect(greedyStep(rt, cfg, { x: 10, y: 64, z: 10 })).toBe("moving");
    }
    expect(navRouteSnapshot().plans).toBe(1);
  });

  it("smoothing follows cfg.nav.smoothPath", () => {
    // On open ground the raw route to (6,5) leaves along x, the string-pulled one on the diagonal.
    const first = (smooth: boolean): Vec3 | null => {
      resetGreedyNav();
      const rt = createMockRuntime();
      for (let x = -1; x <= 10; x++)
        for (let z = -1; z <= 6; z++) rt.setBlock(x, 63, z, "minecraft:stone");
      rt.setPos(center({ x: 0, y: 64, z: 0 }));
      const scfg = makeGerdaConfig({ nav: { smoothPath: smooth } });
      greedyStepPlanned(rt, scfg, center({ x: 6, y: 64, z: 5 }), { block: true });
      return navRouteSnapshot().lastStep.next;
    };
    expect(first(true)).toEqual({ x: 1, y: 64, z: 1 });
    expect(first(false)).toEqual({ x: 1, y: 64, z: 0 });
  });

  it("a D* leg with no way across still blocks", () => {
    const dcfg = makeGerdaConfig({ nav: { dStar: true, mine: false } }); // D* takes no mine moves
    const rt = createMockRuntime();
    for (let x = 0; x <= 3; x++) rt.setBlock(x, 63, 0, "minecraft:stone");
    for (let x = 12; x <= 15; x++) rt.setBlock(x, 63, 0, "minecraft:stone");
    rt.setPos(center({ x: 0, y: 64, z: 0 }));
    let r = "moving";
    for (let t = 0; t < 200 && r === "moving"; t++) {
      rt.state.tick = t;
      r = greedyStep(rt, dcfg, center({ x: 14, y: 64, z: 0 }), { block: true });
    }
    expect(navRouteSnapshot().dstarConverged).toBe(true); // the leg ran on D*
    expect(r).toBe("blocked_no_path");
  });
});

describe("a stopped frontier and a goal that moves", () => {
  beforeEach(() => resetGreedyNav());

  // A 10-cell floor, void past it: every route to the column ends on the rim.
  const beyond = { x: 30, y: 64, z: 0 };

  /** Walk cell by cell past the cooldown, the target chosen per cell, up to the feet at `to`. */
  function walk(rt: MockRuntime, from: number, to: number, target: (x: number) => Vec3): void {
    for (let x = from; x <= to; x++) {
      rt.state.tick += REPLAN + 1;
      rt.setPos(center({ x, y: 64, z: 0 }));
      greedyStepPlanned(rt, cfg, target(x), chaseOpts);
    }
  }

  it("the refusal at the end of a stopped route does not stand for a goal that moved", () => {
    const rt = atCorridorStart(10);
    walk(rt, 0, 9, () => beyond);
    expect(navRouteSnapshot().plans).toBe(2); // the first route, and the re-search that ended on the rim
    rt.state.tick += 1; // inside the cooldown
    rt.setPos(center({ x: 10, y: 64, z: 0 }));
    greedyStepPlanned(rt, cfg, { x: 30, y: 64, z: 1 }, chaseOpts);
    expect(navRouteSnapshot().plans).toBe(3);
  });

  it("a new goal whose route ends on the old rim has not stopped: it gets its own re-search", () => {
    const rt = atCorridorStart(10);
    walk(rt, 0, 1, () => beyond);
    walk(rt, 2, 9, () => ({ x: 30, y: 64, z: 2 * SLACK })); // jumped at x=2: not the same goal
    expect(navRouteSnapshot().plans).toBe(3); // first route, the jump, its re-search on the rim
  });

  it("a target that hops off the end of a route and back keeps the search it opened", () => {
    const rt = atCorridorStart(10);
    const budget = makeGerdaConfig({ nav: { planReadsPerTick: 5 } });
    const leg = { x: 30, y: 64, z: 0 };
    greedyStepPlanned(rt, budget, leg, chaseOpts);
    rt.setPos(center({ x: 10, y: 64, z: 0 })); // the route's end, inside the cooldown
    rt.state.tick = 1;
    greedyStep(rt, budget, { x: 30, y: 64, z: 1 }, chaseOpts); // moved: the route is out, it searches
    expect(navSearchPending()).toBe(true);
    rt.state.tick = 2;
    expect(greedyStep(rt, budget, leg, chaseOpts)).toBe("moving");
    expect(navSearchResumed()).toBe(true);
  });

  it("a re-search for a goal that moved a cell still counts as stopped when it ends on the rim", () => {
    const rt = atCorridorStart(10);
    const moved = { x: 30, y: 64, z: 1 };
    walk(rt, 0, 3, () => beyond);
    walk(rt, 4, 10, () => moved);
    expect(navRouteSnapshot().plans).toBe(2);
  });

  it("at the end of a stopped route, a goal that hops a cell and back is served its search, not the refusal", () => {
    const rt = atCorridorStart(10);
    walk(rt, 0, 9, () => beyond); // the re-search ended on the rim: the route is stopped
    expect(navRouteSnapshot().plans).toBe(2);
    rt.state.tick += 1; // inside the cooldown
    rt.setPos(center({ x: 10, y: 64, z: 0 })); // the stopped route's end
    greedyStep(rt, slowCfg, { x: 30, y: 64, z: 1 }, chaseOpts); // moved: a search begins
    expect(navSearchPending()).toBe(true);
    rt.state.tick += 1;
    expect(greedyStep(rt, slowCfg, beyond, chaseOpts)).toBe("moving"); // hopped back: resumed
    expect(navSearchResumed()).toBe(true);
    expect(navRouteSnapshot().lastBlock).toBe("");
  });
});

describe("a search left running by an arrival", () => {
  beforeEach(() => resetGreedyNav());

  it("a leg arrived at while its search ran does not hand that search to the next leg", () => {
    const rt = atCorridorStart(10);
    // Leg A: a point 2.9 above the feet, out of reach (no filler); its best-effort search sweeps the
    // whole corridor, so it spans calls. A jump carries the body into its radius: arrived.
    const above = { x: 0.3, y: 66.9, z: 0.3 };
    greedyStep(rt, slowCfg, above, { bestEffort: true });
    expect(navSearchPending()).toBe(true);
    rt.state.onGround = false;
    rt.setPos({ x: 0.5, y: 64.6, z: 0.5 });
    expect(greedyStep(rt, slowCfg, above, { bestEffort: true })).toBe("arrived");
    // Leg B: a goal within the slack of leg A's, from the cell leg A's search began on. Its own
    // search finds the next cell; leg A's would have ended on the feet with nothing to drive.
    rt.state.onGround = true;
    rt.setPos(center({ x: 0, y: 64, z: 0 }));
    const next = { x: 3.4, y: 64, z: 0.5 };
    expect(greedyStepPlanned(rt, slowCfg, next)).toBe("moving");
    expect(navRouteSnapshot().lastBlock).toBe("");
    expect(navRouteSnapshot().lastStep.next).toEqual({ x: 1, y: 64, z: 0 });
  });
});

describe("a search whose goal moved", () => {
  beforeEach(() => resetGreedyNav());

  for (const [axis, by] of AXES) {
    it(`a goal moved the slack along ${axis} keeps the search, a cell past it drops it`, () => {
      const rt = atCorridorStart(30);
      const goal = { x: 20.5, y: 64, z: 0.5 };
      rt.state.tick = 1;
      greedyStep(rt, slowCfg, goal);
      rt.state.tick = 2;
      greedyStep(rt, slowCfg, add(goal, by, SLACK));
      expect(navSearchResumed()).toBe(true);
      rt.state.tick = 3; // measured per call: from where the goal stood last call
      greedyStep(rt, slowCfg, add(goal, by, 2 * SLACK + 1));
      expect(navSearchResumed()).toBe(false);
      expect(navSearchPending()).toBe(true); // a fresh search, for the new goal
    });
  }

  it("a target that covers 3 cells between calls still gets a step behind the wall", () => {
    const rt = createMockRuntime();
    wallArena(rt);
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    let served = -1;
    for (let t = 0; t < 600 && served < 0; t++) {
      rt.state.tick = t;
      const leg = t % 6; // z 0, 3, 6, 9, 6, 3: 3 cells a call, the default cfg.nav.goalShiftCells
      const z = 3 * (leg < 3 ? leg : 6 - leg);
      expect(greedyStep(rt, cfg, { x: 16.5, y: 64, z: z + 0.5 }, chaseOpts)).toBe("moving");
      if (!navSearchPending()) served = t;
    }
    expect(served).toBeGreaterThan(0);
  });

  it("a goal 4 cells from the last call is a new goal under the default slack", () => {
    const rt = atCorridorStart(30);
    const goal = { x: 20.5, y: 64, z: 0.5 };
    greedyStep(rt, slowCfg, goal);
    greedyStep(rt, slowCfg, { ...goal, x: goal.x + 4 });
    expect(navSearchResumed()).toBe(false);
  });

  it("a reset drops the running search", () => {
    const rt = atCorridorStart(30);
    greedyStep(rt, slowCfg, { x: 20, y: 64, z: 0 });
    expect(navSearchPending()).toBe(true);
    resetGreedyNav();
    expect(navSearchPending()).toBe(false);
  });

  const unreachable = { x: 6.5, y: 64, z: 2.5 };
  const reachable = { x: 6.5, y: 64, z: 0.5 };

  it("no route to the goal a search began for is no verdict on the goal it moved to", () => {
    const rt = atCorridorStart(12);
    rt.state.tick = 0;
    expect(greedyStep(rt, slowCfg, unreachable, { block: true })).toBe("moving");
    expect(navSearchPending()).toBe(true);
    for (let t = 1; t < 60; t++) {
      rt.state.tick = t;
      expect(greedyStep(rt, slowCfg, reachable, { block: true })).toBe("moving");
      if (navRouteSnapshot().plans > 0) break;
    }
    expect(navRouteSnapshot().plans).toBe(1);
    expect(navRouteSnapshot().lastStep.next).toEqual({ x: 1, y: 64, z: 0 });
  });

  it("a search whose goal went away and came back still gives its verdict", () => {
    const rt = atCorridorStart(12);
    rt.state.tick = 0;
    greedyStep(rt, slowCfg, unreachable, { block: true });
    rt.state.tick = 1;
    greedyStep(rt, slowCfg, reachable, { block: true });
    let r = "moving";
    for (let t = 2; t < 2000 && r === "moving"; t++) {
      rt.state.tick = t;
      r = greedyStep(rt, slowCfg, unreachable, { block: true });
    }
    expect(r).toBe("blocked_no_path");
  });
});

describe("a body that moves while the search runs", () => {
  beforeEach(() => resetGreedyNav());

  /** Ticks a search of the leg takes, from the first call to the tick it ends. */
  function searchTicks(everyTicks: number, by: Vec3): { ticks: number; rt: MockRuntime } {
    resetGreedyNav();
    const rt = createMockRuntime();
    wallArena(rt);
    rt.state.onGround = false;
    rt.state.keys["key.forward"] = true;
    const start = { x: 0, y: 64, z: 0 };
    rt.setPos(center(start));
    let t = 0;
    let crossed = 0;
    for (; t < 400; t++) {
      rt.state.tick = t;
      expect(greedyStep(rt, cfg, BEHIND_WALL, chaseOpts)).toBe("moving");
      if (!navSearchPending()) break;
      expect(rt.state.keys["key.forward"]).toBe(true); // rides on while the search runs
      if (t > 0) expect(navSearchResumed()).toBe(true);
      if (everyTicks > 0 && t % everyTicks === everyTicks - 1) {
        crossed++;
        rt.setPos(center(add(start, by, 1 + (crossed % 6)))); // short of the goal, never on the start
      }
    }
    return { ticks: t, rt };
  }

  for (const [axis, by] of AXES) {
    for (const every of [2, 9]) {
      it(`off the ground, a cell along ${axis} every ${every} ticks leaves the search running to its end`, () => {
        const still = searchTicks(0, by).ticks;
        expect(still).toBeGreaterThan(every); // the body really crosses cells during it
        const { ticks, rt } = searchTicks(every, by);
        expect(ticks).toBe(still);
        expect(navRouteSnapshot().plans).toBe(1);
        // Its route starts behind the feet: nothing is driven, and the heading ends with the search.
        expect(navRouteSnapshot().lastStep.branch).toBe("planning");
        expect(rt.state.keys["key.forward"]).toBe(false);
      });
    }
  }

  it("a search that ended behind the body lets the next one start from a body at rest", () => {
    const { rt } = searchTicks(9, { x: 0, y: 0, z: 1 });
    const t = rt.tick() + 1;
    rt.state.tick = t;
    greedyStep(rt, cfg, BEHIND_WALL, chaseOpts);
    expect(navSearchPending()).toBe(true); // off the route: a search from the feet
    expect(rt.state.keys["key.forward"]).toBe(false); // and no heading to ride on
  });

  it("a route the body was carried onto is followed from where the feet are", () => {
    const rt = atCorridorStart(20);
    rt.state.onGround = false;
    const target = { x: 20, y: 64, z: 0 };
    greedyStep(rt, slowCfg, target);
    expect(navSearchPending()).toBe(true);
    rt.setPos(center({ x: 3, y: 64, z: 0 }));
    for (let t = 1; t < 500 && navSearchPending(); t++) {
      rt.state.tick = t;
      greedyStep(rt, slowCfg, target);
    }
    expect(navRouteSnapshot().plans).toBe(1);
    rt.state.onGround = true;
    rt.state.tick = 600;
    greedyStep(rt, slowCfg, target);
    expect(navRouteSnapshot().plans).toBe(1); // no second search
    expect(navRouteSnapshot().lastStep.next).toEqual({ x: 4, y: 64, z: 0 });
  });

  /** Two platforms 8 cells apart: no route from the first to the goal, one from the second. */
  function twoPlatforms(): MockRuntime {
    const rt = createMockRuntime();
    for (let x = 0; x <= 20; x++) {
      if (x > 5 && x < 14) continue;
      for (let z = -2; z <= 2; z++) rt.setBlock(x, 63, z, "minecraft:stone");
    }
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    return rt;
  }
  const farSide = { x: 18.5, y: 64, z: 0.5 };

  it("off the ground, no route from a cell the body left is no verdict", () => {
    const rt = twoPlatforms();
    rt.state.onGround = false;
    greedyStep(rt, slowCfg, farSide);
    expect(navSearchPending()).toBe(true);
    rt.setPos({ x: 14.5, y: 64, z: 0.5 }); // carried across while the search ran
    for (let t = 1; t < 2000 && navSearchPending(); t++) {
      rt.state.tick = t;
      expect(greedyStep(rt, slowCfg, farSide)).toBe("moving");
    }
    expect(navRouteSnapshot().plans).toBe(0);
    rt.state.onGround = true; // lands inside the cooldown of a route that was never installed
    expect(greedyStepPlanned(rt, slowCfg, farSide)).toBe("moving");
    expect(navRouteSnapshot().lastStep.next).toEqual({ x: 15, y: 64, z: 0 });
  });

  for (const [axis, by] of AXES) {
    it(`a grounded body moved a cell along ${axis} drops the search for one from the feet`, () => {
      const rt = createMockRuntime();
      wallArena(rt);
      rt.setBlock(5, 64, 5, "minecraft:stone"); // the floor one cell up, for +y
      const start = { x: 5, y: 65, z: 5 };
      rt.setPos(center(start));
      rt.state.tick = 1;
      greedyStep(rt, slowCfg, BEHIND_WALL, chaseOpts);
      expect(navSearchPending()).toBe(true);
      rt.setPos(center(add(start, by, 1)));
      rt.state.tick = 2;
      greedyStep(rt, slowCfg, BEHIND_WALL, chaseOpts);
      expect(navSearchResumed()).toBe(false);
      expect(navSearchPending()).toBe(true);
    });
  }

  it("a body that stays on its cell keeps the search, grounded or not", () => {
    for (const onGround of [true, false]) {
      resetGreedyNav();
      const rt = atCorridorStart(20);
      rt.state.onGround = onGround;
      rt.state.tick = 1;
      greedyStep(rt, slowCfg, { x: 20, y: 64, z: 0 });
      rt.setPos({ x: 0.9, y: 64, z: 0.1 }); // a sub-cell slide
      rt.state.tick = 2;
      greedyStep(rt, slowCfg, { x: 20, y: 64, z: 0 });
      expect(navSearchResumed()).toBe(true);
    }
  });

  // Position from yaw and the forward key, never on the ground: the search takes ~75 ticks here, so
  // at this speed every answer is left behind a body that keeps its heading from search to search.
  it("a swimmer behind a long wall reaches the goal, on a heading held for one search at most", () => {
    const rt = createMockRuntime();
    for (let x = -60; x <= 60; x++)
      for (let z = -60; z <= 60; z++) {
        rt.setBlock(x, 60, z, "minecraft:stone");
        for (let y = 61; y <= 64; y++) rt.setBlock(x, y, z, "minecraft:water");
      }
    const wallHalf = 20;
    for (let z = -wallHalf; z <= wallHalf; z++)
      for (let y = 61; y <= 67; y++) rt.setBlock(8, y, z, "minecraft:bedrock");
    rt.state.onGround = false;
    rt.state.keys["key.forward"] = true;
    rt.state.rotation.yaw = 0; // heading +z, along the wall
    let px = 0.5;
    let pz = 0.5;
    const speed = 0.2;
    rt.setPos({ x: px, y: 64, z: pz });
    let r = "moving";
    let blindRun = 0;
    let longestBlindRun = 0;
    for (let t = 0; t < 1500 && r === "moving"; t++) {
      rt.state.tick = t;
      r = greedyStep(rt, cfg, BEHIND_WALL, chaseOpts);
      const planning = navRouteSnapshot().lastStep.branch === "planning";
      blindRun = planning && rt.state.keys["key.forward"] ? blindRun + 1 : 0;
      longestBlindRun = Math.max(longestBlindRun, blindRun);
      if (!rt.state.keys["key.forward"]) continue;
      const yaw = (rt.state.rotation.yaw * Math.PI) / 180;
      const nx = px - Math.sin(yaw) * speed;
      const nz = pz + Math.cos(yaw) * speed;
      if (Math.floor(nx) === 8 && Math.abs(Math.floor(nz)) <= wallHalf) continue; // the wall stops it
      px = nx;
      pz = nz;
      rt.setPos({ x: px, y: 64, z: pz });
    }
    expect(r).toBe("arrived");
    expect(longestBlindRun).toBeLessThan(100); // one search of ~75 ticks, never two end to end
  });
});
