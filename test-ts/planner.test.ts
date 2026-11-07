// A* planner + movement-type registry over synthetic voxel worlds. Pure,
// no runtime. Covers flat traverse, stepUp, a safe drop, and an unreachable goal.
import {
  JUMP_ONE_BLOCK_TICKS,
  WALK_ONE_BLOCK_TICKS,
  fallTicks,
} from "@/core/prim/movement-physics";
import { encodePos } from "@/core/prim/pos";
import { GoalBlock, GoalXZ } from "@/shared/domain/goal";
import { neighbors } from "@/shared/domain/movement-types";
import {
  DEFAULT_PLANNER_OPTS,
  type PathKind,
  type PlanResult,
  PlanSearch,
  planPath,
  smoothPath,
} from "@/shared/domain/planner";
import type { BlockReader } from "@/shared/domain/senses";
import { describe, expect, it } from "vitest";

/** A mutable voxel world + a reader; `stand` carves a standable feet cell (floor + clearance). */
function world() {
  const m = new Map<string, string>();
  const set = (x: number, y: number, z: number, id: string) => m.set(encodePos(x, y, z), id);
  const reader: BlockReader = (x, y, z) => m.get(encodePos(x, y, z)) ?? null;
  const stand = (x: number, y: number, z: number) => {
    set(x, y - 1, z, "minecraft:stone"); // floor
    set(x, y, z, "minecraft:air");
    set(x, y + 1, z, "minecraft:air");
    set(x, y + 2, z, "minecraft:air"); // jump clearance
  };
  return { set, reader, stand };
}

describe("neighbors", () => {
  it("offers a same-level traverse on flat ground", () => {
    const w = world();
    w.stand(0, 64, 0);
    w.stand(1, 64, 0);
    const ns = neighbors(w.reader, { x: 0, y: 64, z: 0 }, { maxDrop: 4, maxFallDamage: 0 });
    expect(ns.some((n) => n.kind === "traverse" && n.to.x === 1 && n.to.y === 64)).toBe(true);
  });

  it("offers a diagonal step when both corners are open (cost √2·walk)", () => {
    const w = world();
    w.stand(0, 64, 0);
    w.stand(1, 64, 0); // corner A
    w.stand(0, 64, 1); // corner B
    w.stand(1, 64, 1); // destination
    const ns = neighbors(w.reader, { x: 0, y: 64, z: 0 }, { maxDrop: 4, maxFallDamage: 0 });
    const diag = ns.find((n) => n.kind === "diagonal" && n.to.x === 1 && n.to.z === 1);
    expect(diag).toBeDefined();
    expect(diag?.cost).toBeCloseTo(WALK_ONE_BLOCK_TICKS * Math.SQRT2, 6);
  });

  it("refuses the diagonal when a corner is blocked (no corner-clip)", () => {
    const w = world();
    w.stand(0, 64, 0);
    w.stand(1, 64, 1); // destination standable…
    w.stand(0, 64, 1); // corner B open
    w.set(1, 64, 0, "minecraft:stone"); // …but corner A is a solid block at feet height
    const ns = neighbors(w.reader, { x: 0, y: 64, z: 0 }, { maxDrop: 4, maxFallDamage: 0 });
    expect(ns.some((n) => n.kind === "diagonal")).toBe(false);
  });

  it("offers a diagonal ASCEND onto a +1 corner (cost √2·walk + jump)", () => {
    const w = world();
    w.stand(0, 64, 0); // take-off (air at 64–66)
    w.stand(1, 65, 1); // destination, one block up the diagonal
    // both orthogonal corners clear at feet/head/jump height
    for (const y of [64, 65, 66]) {
      w.set(1, y, 0, "minecraft:air");
      w.set(0, y, 1, "minecraft:air");
    }
    const ns = neighbors(w.reader, { x: 0, y: 64, z: 0 }, { maxDrop: 4, maxFallDamage: 0 });
    const asc = ns.find((n) => n.kind === "diagonalAscend" && n.to.x === 1 && n.to.y === 65);
    expect(asc).toBeDefined();
    expect(asc?.cost).toBeCloseTo(WALK_ONE_BLOCK_TICKS * Math.SQRT2 + JUMP_ONE_BLOCK_TICKS, 6);
  });

  it("offers a diagonal DESCEND onto a −1 corner (cost √2·walk + a 1-block fall)", () => {
    const w = world();
    w.stand(0, 64, 0);
    w.stand(1, 63, 1); // destination, one block down the diagonal
    for (const y of [64, 65]) {
      w.set(1, y, 0, "minecraft:air"); // corners clear at the start level
      w.set(0, y, 1, "minecraft:air");
    }
    const ns = neighbors(w.reader, { x: 0, y: 64, z: 0 }, { maxDrop: 4, maxFallDamage: 0 });
    const desc = ns.find((n) => n.kind === "diagonalDescend" && n.to.x === 1 && n.to.y === 63);
    expect(desc).toBeDefined();
    expect(desc?.cost).toBeCloseTo(WALK_ONE_BLOCK_TICKS * Math.SQRT2 + fallTicks(1), 6);
  });

  it("refuses the diagonal DESCEND when a corner is a same-level standable ledge (catch-ledge)", () => {
    // Live-found (snow-plateau edge): the +z corner cell is open at feet+head (passes
    // the corner-clip guard) but its FLOOR is at the FROM level, so the 0.6-wide box rides that
    // ledge through the whole diagonal and never tips into the lower destination — the walk driver
    // holds forward forever without advancing. The planner must NOT emit this. Mirrors the real
    // wedge: +z corner is a same-level plateau (catches), +x corner drops away by one.
    const w = world();
    w.stand(0, 64, 0);
    w.stand(1, 63, 1); // destination, one block down the diagonal (SE)
    // +x corner (1,*,0): OPEN at feet/head AND its from-level floor is air → drops away cleanly.
    for (const y of [63, 64, 65]) w.set(1, y, 0, "minecraft:air");
    // +z corner (0,*,1): open at feet/head…
    for (const y of [64, 65]) w.set(0, y, 1, "minecraft:air");
    w.set(0, 63, 1, "minecraft:stone"); // …but its floor is at the FROM level (top == y64) → catches
    const ns = neighbors(w.reader, { x: 0, y: 64, z: 0 }, { maxDrop: 4, maxFallDamage: 0 });
    expect(ns.some((n) => n.kind === "diagonalDescend")).toBe(false);
    // the cardinal decomposition's first leg survives: a same-level traverse onto the catching
    // corner (then drop) — the executor drives cardinal traverse+drop reliably.
    expect(ns.some((n) => n.kind === "traverse" && n.to.x === 0 && n.to.z === 1)).toBe(true);
  });
});

describe("PlanSearch resumed every expansion answers as planPath (RCA K-2)", () => {
  /** A 9×9 plane with a wall across x=4 except a gap at z=8, and a pit nothing reaches. */
  function walled() {
    const w = world();
    for (let x = 0; x <= 8; x++) for (let z = 0; z <= 8; z++) w.stand(x, 64, z);
    for (let z = 0; z <= 7; z++) for (const y of [64, 65, 66]) w.set(4, y, z, "minecraft:bedrock");
    return w;
  }
  function stepwise(w: ReturnType<typeof world>, goal: GoalBlock | GoalXZ, bestEffort: boolean) {
    const opts = { ...DEFAULT_PLANNER_OPTS, bestEffort };
    const s = new PlanSearch({ x: 0, y: 64, z: 0 }, goal, opts);
    let runs = 0;
    for (;;) {
      runs++;
      const r = s.run(w.reader, () => true);
      if (r.done) return { result: r.result, runs };
    }
  }
  const cases: readonly [string, GoalBlock | GoalXZ, boolean][] = [
    ["reachable round the wall", new GoalBlock({ x: 8, y: 64, z: 0 }), false],
    ["unreachable, hard null", new GoalXZ(30, 0), false],
    ["unreachable, best effort", new GoalXZ(30, 0), true],
  ];
  for (const [name, goal, bestEffort] of cases) {
    it(name, () => {
      const w = walled();
      const once: PlanResult | null = planPath(w.reader, { x: 0, y: 64, z: 0 }, goal, {
        ...DEFAULT_PLANNER_OPTS,
        bestEffort,
      });
      const { result, runs } = stepwise(w, goal, bestEffort);
      expect(runs).toBeGreaterThan(10); // it really paused and resumed
      expect(result).toEqual(once);
    });
  }
});

describe("planPath with diagonals", () => {
  it("cuts the corner — a diagonal path is shorter than the manhattan detour", () => {
    const w = world();
    for (let x = 0; x <= 3; x++) for (let z = 0; z <= 3; z++) w.stand(x, 64, z);
    const r = planPath(w.reader, { x: 0, y: 64, z: 0 }, new GoalBlock({ x: 3, y: 64, z: 3 }));
    expect(r).not.toBeNull();
    // 3 diagonals (√2 each) beats 6 cardinals — the planner uses the diagonal move.
    expect(r?.cost).toBeCloseTo(3 * WALK_ONE_BLOCK_TICKS * Math.SQRT2, 6);
    expect(r?.path.some((c, i) => i > 0 && c.x !== 0 && c.z !== 0)).toBe(true);
  });
});

describe("planPath with parkour", () => {
  it("sprint-jumps a void gap that walk / safe-drop cannot cross", () => {
    const w = world();
    w.stand(0, 64, 0); // take-off
    w.stand(3, 64, 0); // landing — 3 cells away, a 2-block air gap between
    // gap cells x=1,2: feet + head air, NO floor below (void deeper than maxDrop) → must be jumped
    for (const x of [1, 2]) {
      w.set(x, 64, 0, "minecraft:air");
      w.set(x, 65, 0, "minecraft:air");
    }
    const start = { x: 0, y: 64, z: 0 };
    const goal = new GoalBlock({ x: 3, y: 64, z: 0 });
    // without parkour the gap is impassable (no walk, no safe drop into a bottomless void) → null
    expect(planPath(w.reader, start, goal)).toBeNull();
    // with parkour enabled, one hop crosses it
    const r = planPath(w.reader, start, goal, {
      ...DEFAULT_PLANNER_OPTS,
      parkour: true,
      maxParkour: 4,
    });
    expect(r).not.toBeNull();
    expect(r?.path.length).toBe(2); // [take-off, landing] — a single jump, not cell-by-cell
    expect(r?.path[1]).toEqual({ x: 3, y: 64, z: 0 });
    expect(r?.cost).toBeCloseTo(3 * WALK_ONE_BLOCK_TICKS, 3); // dist 3 → WALK×3, penalty 0
  });

  it("does not parkour where the ground is solid — a flat walk owns it", () => {
    const w = world();
    for (let x = 0; x <= 3; x++) w.stand(x, 64, 0); // solid ground the whole way
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      {
        ...DEFAULT_PLANNER_OPTS,
        parkour: true,
        maxParkour: 4,
      },
    );
    // every cell has a floor → no open gap → parkour offers nothing; traverse handles it
    expect(ns.some((n) => n.kind === "parkour")).toBe(false);
    expect(ns.some((n) => n.kind === "traverse" && n.to.x === 1)).toBe(true);
  });
});

describe("neighbors with pillarUp", () => {
  it("offers a pillarUp straight overhead when canPillar (cost jump + penalty)", () => {
    const w = world();
    w.stand(0, 64, 0); // floor at 63; 64/65/66 already air (jump clearance)
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      {
        ...DEFAULT_PLANNER_OPTS,
        canPillar: true,
        pillarPenalty: 20,
      },
    );
    const up = ns.find((n) => n.kind === "pillarUp");
    expect(up).toBeDefined();
    expect(up?.to).toEqual({ x: 0, y: 65, z: 0 }); // rise in place
    expect(up?.cost).toBeCloseTo(JUMP_ONE_BLOCK_TICKS + 20, 6);
  });

  it("does not offer pillarUp without canPillar (the planner can't read inventory)", () => {
    const w = world();
    w.stand(0, 64, 0);
    const ns = neighbors(w.reader, { x: 0, y: 64, z: 0 }, { maxDrop: 4, maxFallDamage: 0 });
    expect(ns.some((n) => n.kind === "pillarUp")).toBe(false);
  });

  it("does not offer pillarUp when there is no headroom to rise + stand", () => {
    const w = world();
    w.stand(0, 64, 0);
    w.set(0, 66, 0, "minecraft:stone"); // ceiling at the would-be new head → can't rise
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      {
        ...DEFAULT_PLANNER_OPTS,
        canPillar: true,
      },
    );
    expect(ns.some((n) => n.kind === "pillarUp")).toBe(false);
  });
});

describe("planPath with pillarUp", () => {
  it("pillars straight up to an overhead goal a step route can't reach", () => {
    const w = world();
    w.set(0, 63, 0, "minecraft:stone"); // ground
    for (let y = 64; y <= 69; y++) w.set(0, y, 0, "minecraft:air"); // a clear sheer column
    const start = { x: 0, y: 64, z: 0 };
    const goal = new GoalBlock({ x: 0, y: 67, z: 0 });
    // no canPillar → can't rise in place, no adjacent steps → unreachable
    expect(planPath(w.reader, start, goal)).toBeNull();
    const r = planPath(w.reader, start, goal, {
      ...DEFAULT_PLANNER_OPTS,
      canPillar: true,
      pillarPenalty: 0,
    });
    expect(r).not.toBeNull();
    const p = r?.path ?? [];
    expect(p[p.length - 1]).toEqual({ x: 0, y: 67, z: 0 });
    expect(p.length).toBe(4); // 64 → 65 → 66 → 67, three pillarUps
  });
});

describe("neighbors with mineDown", () => {
  it("offers a mineDown through the floor when mine + breakable floor + a landing below (cost fall + breakCost)", () => {
    const w = world();
    w.stand(0, 64, 0); // floor at 63 (stone), 64/65/66 air
    w.set(0, 62, 0, "minecraft:stone"); // a surface one further down to land on
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      { maxDrop: 4, maxFallDamage: 0, mine: true, breakCost: 20 },
    );
    const down = ns.find((n) => n.kind === "mineDown");
    expect(down).toBeDefined();
    expect(down?.to).toEqual({ x: 0, y: 63, z: 0 }); // sink one block in place
    expect(down?.cost).toBeCloseTo(fallTicks(1) + 20, 6);
  });

  it("does not offer mineDown without opts.mine (gated like the other mine-moves)", () => {
    const w = world();
    w.stand(0, 64, 0);
    w.set(0, 62, 0, "minecraft:stone");
    const ns = neighbors(w.reader, { x: 0, y: 64, z: 0 }, { maxDrop: 4, maxFallDamage: 0 });
    expect(ns.some((n) => n.kind === "mineDown")).toBe(false);
  });

  it("does not mineDown an already-open column — there is no floor to break (gravity/drop owns it)", () => {
    const w = world();
    w.set(0, 64, 0, "minecraft:air");
    w.set(0, 65, 0, "minecraft:air");
    w.set(0, 63, 0, "minecraft:air"); // floor already gone
    w.set(0, 62, 0, "minecraft:stone");
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      { maxDrop: 4, maxFallDamage: 0, mine: true, breakCost: 20 },
    );
    expect(ns.some((n) => n.kind === "mineDown")).toBe(false);
  });

  it("does not mineDown when there is no surface to land on below (would open a deep void)", () => {
    const w = world();
    w.stand(0, 64, 0); // floor at 63
    w.set(0, 62, 0, "minecraft:air"); // nothing to land on after breaking the floor
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      { maxDrop: 4, maxFallDamage: 0, mine: true, breakCost: 20 },
    );
    expect(ns.some((n) => n.kind === "mineDown")).toBe(false);
  });

  it("refuses to mine a bedrock floor (breakableSolid = false)", () => {
    const w = world();
    w.set(0, 64, 0, "minecraft:air");
    w.set(0, 65, 0, "minecraft:air");
    w.set(0, 66, 0, "minecraft:air");
    w.set(0, 63, 0, "minecraft:bedrock"); // unmineable floor
    w.set(0, 62, 0, "minecraft:stone");
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      { maxDrop: 4, maxFallDamage: 0, mine: true, breakCost: 20 },
    );
    expect(ns.some((n) => n.kind === "mineDown")).toBe(false);
  });
});

describe("planPath with mineDown", () => {
  it("bores straight down to a buried at-or-below goal a walk route can't reach", () => {
    const w = world();
    w.set(0, 64, 0, "minecraft:air"); // start feet
    w.set(0, 65, 0, "minecraft:air"); // start head
    w.set(0, 66, 0, "minecraft:air");
    for (let y = 60; y <= 63; y++) w.set(0, y, 0, "minecraft:stone"); // solid rock to bore through + land on
    const start = { x: 0, y: 64, z: 0 };
    const goal = new GoalBlock({ x: 0, y: 61, z: 0 });
    // no mine → can't break the floor, no adjacent route → unreachable
    expect(planPath(w.reader, start, goal)).toBeNull();
    const r = planPath(w.reader, start, goal, {
      ...DEFAULT_PLANNER_OPTS,
      mine: true,
      breakCost: 1,
    });
    expect(r).not.toBeNull();
    const p = r?.path ?? [];
    expect(p[p.length - 1]).toEqual({ x: 0, y: 61, z: 0 }); // 64 → 63 → 62 → 61, three mineDowns
  });
});

describe("neighbors with mining", () => {
  it("offers a mineTraverse through a solid wall when mine + breakable (cost walk + breakCost·cells)", () => {
    const w = world();
    w.stand(0, 64, 0);
    w.set(1, 63, 0, "minecraft:stone"); // a standable floor at the destination…
    w.set(1, 64, 0, "minecraft:stone"); // …with feet + head solid (a wall to tunnel through)
    w.set(1, 65, 0, "minecraft:stone");
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      {
        maxDrop: 4,
        maxFallDamage: 0,
        mine: true,
        breakCost: 20,
      },
    );
    const m = ns.find((n) => n.kind === "mineTraverse" && n.to.x === 1 && n.to.y === 64);
    expect(m).toBeDefined();
    expect(m?.cost).toBeCloseTo(WALK_ONE_BLOCK_TICKS + 2 * 20, 6); // feet + head = 2 breaks
  });

  it("does not offer a mine-move without opts.mine (gated like canPillar)", () => {
    const w = world();
    w.stand(0, 64, 0);
    w.set(1, 63, 0, "minecraft:stone");
    w.set(1, 64, 0, "minecraft:stone");
    w.set(1, 65, 0, "minecraft:stone");
    const ns = neighbors(w.reader, { x: 0, y: 64, z: 0 }, { maxDrop: 4, maxFallDamage: 0 });
    expect(ns.some((n) => n.kind.startsWith("mine"))).toBe(false);
  });

  it("does not mineTraverse an already-open step — traverse owns it (≥1 break required)", () => {
    const w = world();
    w.stand(0, 64, 0);
    w.stand(1, 64, 0); // fully open destination
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      {
        maxDrop: 4,
        maxFallDamage: 0,
        mine: true,
        breakCost: 20,
      },
    );
    expect(ns.some((n) => n.kind === "mineTraverse")).toBe(false);
    expect(ns.some((n) => n.kind === "traverse" && n.to.x === 1)).toBe(true);
  });

  it("refuses to mine into bedrock / a hazard (breakableSolid = false)", () => {
    const w = world();
    w.stand(0, 64, 0);
    w.set(1, 63, 0, "minecraft:stone");
    w.set(1, 64, 0, "minecraft:bedrock"); // unmineable
    w.set(1, 65, 0, "minecraft:air");
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      {
        maxDrop: 4,
        maxFallDamage: 0,
        mine: true,
        breakCost: 20,
      },
    );
    expect(ns.some((n) => n.kind === "mineTraverse")).toBe(false);
  });

  it("offers a mineAscend up a solid tread (cost walk + jump + breakCost·cells)", () => {
    const w = world();
    w.stand(0, 64, 0);
    w.set(1, 64, 0, "minecraft:stone"); // the tread to climb onto (stays solid)
    w.set(1, 65, 0, "minecraft:stone"); // destination feet — break
    w.set(1, 66, 0, "minecraft:stone"); // destination head — break
    w.set(0, 66, 0, "minecraft:stone"); // headroom over the take-off — break
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      {
        maxDrop: 4,
        maxFallDamage: 0,
        mine: true,
        breakCost: 20,
      },
    );
    const m = ns.find((n) => n.kind === "mineAscend" && n.to.x === 1 && n.to.y === 65);
    expect(m).toBeDefined();
    expect(m?.cost).toBeCloseTo(WALK_ONE_BLOCK_TICKS + JUMP_ONE_BLOCK_TICKS + 3 * 20, 6);
  });

  it("offers a mineDescend down a forward-down step through rock (cost walk + fall + breakCost·cells)", () => {
    const w = world();
    w.stand(0, 64, 0); // start at feet 64 on floor 63
    w.set(1, 64, 0, "minecraft:stone"); // destination HEAD (= from.y, forward) — break
    w.set(1, 63, 0, "minecraft:stone"); // destination FEET (forward + down) — break
    w.set(1, 62, 0, "minecraft:stone"); // the tread to land on — stays solid
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      { maxDrop: 4, maxFallDamage: 0, mine: true, breakCost: 20 },
    );
    const m = ns.find((n) => n.kind === "mineDescend" && n.to.x === 1 && n.to.y === 63);
    expect(m).toBeDefined();
    expect(m?.cost).toBeCloseTo(WALK_ONE_BLOCK_TICKS + fallTicks(1) + 2 * 20, 6); // feet + head = 2 breaks
  });

  it("does not mineDescend an already-open down-step — dropDownSafe owns it (≥1 break required)", () => {
    const w = world();
    w.stand(0, 64, 0);
    w.set(1, 65, 0, "minecraft:air"); // forward column already open (feet + head)…
    w.set(1, 64, 0, "minecraft:air");
    w.set(1, 63, 0, "minecraft:air");
    w.set(1, 62, 0, "minecraft:stone"); // …with a tread → a plain safe drop, not a dig
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      { maxDrop: 4, maxFallDamage: 0, mine: true, breakCost: 20 },
    );
    expect(ns.some((n) => n.kind === "mineDescend")).toBe(false);
    expect(ns.some((n) => n.kind === "dropDownSafe")).toBe(true);
  });
});

describe("planPath with mining", () => {
  it("tunnels through rock to a walled-off goal only when mine is enabled", () => {
    const w = world();
    w.stand(0, 64, 0); // start
    // a solid rock run between start and goal: floor solid, feet+head solid at x=1,2
    for (const x of [1, 2]) {
      w.set(x, 63, 0, "minecraft:stone");
      w.set(x, 64, 0, "minecraft:stone");
      w.set(x, 65, 0, "minecraft:stone");
    }
    w.stand(3, 64, 0); // the goal cell, open
    const start = { x: 0, y: 64, z: 0 };
    const goal = new GoalBlock({ x: 3, y: 64, z: 0 });
    // walled off with no mining → unreachable
    expect(planPath(w.reader, start, goal)).toBeNull();
    const r = planPath(w.reader, start, goal, {
      ...DEFAULT_PLANNER_OPTS,
      mine: true,
      breakCost: 20,
    });
    expect(r).not.toBeNull();
    const path = r?.path ?? [];
    expect(path[path.length - 1]).toEqual({ x: 3, y: 64, z: 0 });
    expect(path.length).toBe(4); // 0 → 1 → 2 → 3, two mineTraverses + a final open traverse
  });

  it("digs a down-forward staircase step (mineDescend) — cheaper than mineTraverse + mineDown", () => {
    const w = world();
    w.stand(0, 64, 0); // start at feet 64
    w.set(1, 64, 0, "minecraft:stone"); // forward head — break
    w.set(1, 63, 0, "minecraft:stone"); // forward + down feet (the goal) — break
    w.set(1, 62, 0, "minecraft:stone"); // the tread to land on
    const start = { x: 0, y: 64, z: 0 };
    const goal = new GoalBlock({ x: 1, y: 63, z: 0 });
    expect(planPath(w.reader, start, goal)).toBeNull(); // solid, no mining → unreachable
    const r = planPath(w.reader, start, goal, {
      ...DEFAULT_PLANNER_OPTS,
      mine: true,
      breakCost: 20,
    });
    expect(r).not.toBeNull();
    const path = r?.path ?? [];
    expect(path[path.length - 1]).toEqual({ x: 1, y: 63, z: 0 });
    expect(path.length).toBe(2); // ONE mineDescend (2 breaks) beats mineTraverse→mineDown (3 breaks)
  });

  it("reaches a DIAGONALLY-offset target through solid rock via an L of cardinal mine steps (L-composition)", () => {
    const w = world();
    w.stand(0, 64, 0); // start, encased
    // a solid rock slab over the 0..3 × 0..3 diagonal region at the walk level (floor + feet + head)
    for (let x = 0; x <= 3; x++) {
      for (let z = 0; z <= 3; z++) {
        w.set(x, 63, z, "minecraft:stone"); // floor / tread
        if (!(x === 0 && z === 0)) {
          w.set(x, 64, z, "minecraft:stone"); // feet-level solid (mine)
          w.set(x, 65, z, "minecraft:stone"); // head-level solid (mine)
        }
      }
    }
    const start = { x: 0, y: 64, z: 0 };
    const goal = new GoalBlock({ x: 3, y: 64, z: 3 });
    const r = planPath(w.reader, start, goal, {
      ...DEFAULT_PLANNER_OPTS,
      mine: true,
      breakCost: 20,
    });
    expect(r).not.toBeNull();
    const path = r?.path ?? [];
    expect(path[path.length - 1]).toEqual({ x: 3, y: 64, z: 3 });
    // EVERY step is CARDINAL (exactly one of x/z moves by 1, y flat): there is no diagonal-mine move,
    // so the planner reaches a diagonal target by an L of cardinal mineTraverses — the L-composition.
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const dx = Math.abs((b?.x ?? 0) - (a?.x ?? 0));
      const dz = Math.abs((b?.z ?? 0) - (a?.z ?? 0));
      const dy = Math.abs((b?.y ?? 0) - (a?.y ?? 0));
      expect(dy).toBe(0);
      expect(dx + dz).toBe(1);
    }
  });
});

describe("neighbors with bridging", () => {
  it("offers a bridgePlace across a void gap when bridge enabled (cost walk + penalty)", () => {
    const w = world();
    w.stand(0, 64, 0); // start
    w.set(1, 64, 0, "minecraft:air"); // next cell open…
    w.set(1, 65, 0, "minecraft:air");
    w.set(2, 64, 0, "minecraft:air"); // …a 2-cell void gap (x=1,2)…
    w.set(2, 65, 0, "minecraft:air");
    w.stand(3, 64, 0); // …with real ground at x=3 (landfall within bridgeMaxRun) → a crossable gap
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      {
        maxDrop: 4,
        maxFallDamage: 0,
        bridge: true,
        bridgePenalty: 20,
        bridgeMaxRun: 6,
      },
    );
    const b = ns.find((n) => n.kind === "bridgePlace" && n.to.x === 1 && n.to.y === 64);
    expect(b).toBeDefined();
    expect(b?.cost).toBeCloseTo(WALK_ONE_BLOCK_TICKS + 20, 6);
  });

  it("offers a bridgePlace when the only landfall is a +1 step-up (across-void ore-top)", () => {
    const w = world();
    w.stand(0, 64, 0); // start
    for (const x of [1, 2]) {
      w.set(x, 64, 0, "minecraft:air"); // a 2-cell void at the bridge level
      w.set(x, 65, 0, "minecraft:air");
      w.set(x, 66, 0, "minecraft:air");
    }
    // far side: a solid ore whose TOP (the pickaxe stand-pos) is one ABOVE the bridge plane, so the
    // ONLY foothold is (3,65) — a step-up landing, NOT (3,64). Same-level-only landfall would miss it.
    w.set(3, 64, 0, "minecraft:iron_ore");
    w.set(3, 65, 0, "minecraft:air");
    w.set(3, 66, 0, "minecraft:air");
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      { maxDrop: 4, maxFallDamage: 0, bridge: true, bridgePenalty: 20, bridgeMaxRun: 6 },
    );
    expect(ns.some((n) => n.kind === "bridgePlace" && n.to.x === 1 && n.to.y === 64)).toBe(true);
  });

  it("offers a bridgePlace when the only landfall is a safe drop BELOW (ravine's lower far rim)", () => {
    const w = world();
    w.stand(0, 64, 0); // start
    for (const x of [1, 2]) {
      w.set(x, 64, 0, "minecraft:air"); // a 2-cell void at the bridge level
      w.set(x, 65, 0, "minecraft:air");
    }
    // far rim ONE BLOCK LOWER than the bridge plane: standable at (3,63), so (3,64)/(3,65) are air —
    // a same-or-higher-only landfall would miss it and refuse to bridge over a lower ravine side.
    w.stand(3, 63, 0);
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      { maxDrop: 4, maxFallDamage: 0, bridge: true, bridgePenalty: 20, bridgeMaxRun: 6 },
    );
    expect(ns.some((n) => n.kind === "bridgePlace" && n.to.x === 1 && n.to.y === 64)).toBe(true);
  });

  it("does NOT bridge toward a far rim BELOW a safe drop (the drop would hurt — no landfall)", () => {
    const w = world();
    w.stand(0, 64, 0);
    for (const x of [1, 2]) {
      w.set(x, 64, 0, "minecraft:air");
      w.set(x, 65, 0, "minecraft:air");
    }
    w.stand(3, 55, 0); // far rim 9 blocks below the plane — past any 0-damage drop, so unreachable
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      { maxDrop: 4, maxFallDamage: 0, bridge: true, bridgePenalty: 20, bridgeMaxRun: 6 },
    );
    expect(ns.some((n) => n.kind === "bridgePlace")).toBe(false);
  });

  it("does NOT bridge into an unbounded void with no landing in range (the anti-hang bound)", () => {
    const w = world();
    w.stand(0, 64, 0); // start, then open air forever in +x with no landing
    for (let x = 1; x <= 10; x++) {
      w.set(x, 64, 0, "minecraft:air");
      w.set(x, 65, 0, "minecraft:air");
    }
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      { maxDrop: 4, maxFallDamage: 0, bridge: true, bridgePenalty: 20, bridgeMaxRun: 6 },
    );
    // No ground within bridgeMaxRun → no bridge edge → A* can't spread across the void (no getBlock storm).
    expect(ns.some((n) => n.kind === "bridgePlace")).toBe(false);
  });

  it("does not offer a bridge without opts.bridge (gated like canPillar)", () => {
    const w = world();
    w.stand(0, 64, 0);
    w.set(1, 64, 0, "minecraft:air");
    w.set(1, 65, 0, "minecraft:air");
    const ns = neighbors(w.reader, { x: 0, y: 64, z: 0 }, { maxDrop: 4, maxFallDamage: 0 });
    expect(ns.some((n) => n.kind === "bridgePlace")).toBe(false);
  });

  it("does not bridge a SAFE short drop — dropDownSafe owns it (don't waste filler)", () => {
    const w = world();
    w.stand(0, 64, 0);
    w.set(1, 64, 0, "minecraft:air");
    w.set(1, 65, 0, "minecraft:air");
    w.stand(1, 62, 0); // a 2-block drop with a landing → safe, no bridge
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      {
        maxDrop: 4,
        maxFallDamage: 0,
        bridge: true,
        bridgePenalty: 20,
      },
    );
    expect(ns.some((n) => n.kind === "bridgePlace")).toBe(false);
    expect(ns.some((n) => n.kind === "dropDownSafe")).toBe(true);
  });
});

describe("planPath with bridging", () => {
  it("chains bridgePlace across a WIDE void parkour can't jump (optimistic placement)", () => {
    const w = world();
    w.stand(0, 64, 0); // near side
    w.stand(5, 64, 0); // far side, 4 void cells (x=1..4) between — beyond parkour's 3-gap reach
    for (const x of [1, 2, 3, 4]) {
      w.set(x, 64, 0, "minecraft:air");
      w.set(x, 65, 0, "minecraft:air");
    }
    const start = { x: 0, y: 64, z: 0 };
    const goal = new GoalBlock({ x: 5, y: 64, z: 0 });
    // even with parkour (max 4 → lands on a VOID cell, never the far floor) the 4-wide void is
    // uncrossable; only a chain of bridges spans it.
    expect(
      planPath(w.reader, start, goal, { ...DEFAULT_PLANNER_OPTS, parkour: true, maxParkour: 4 }),
    ).toBeNull();
    const r = planPath(w.reader, start, goal, {
      ...DEFAULT_PLANNER_OPTS,
      bridge: true,
      bridgePenalty: 20,
    });
    expect(r).not.toBeNull();
    const path = r?.path ?? [];
    expect(path[path.length - 1]).toEqual({ x: 5, y: 64, z: 0 });
    expect(path.length).toBe(6); // 0 →1→2→3→4 (four chained bridges) → 5 (traverse onto real floor)
  });

  it("composes bridge + stepUp to reach an ore-top one block ABOVE the bridge plane", () => {
    const w = world();
    w.stand(0, 64, 0); // start at feet y=64
    for (const x of [1, 2]) {
      w.set(x, 64, 0, "minecraft:air"); // 2-cell void at the bridge level
      w.set(x, 65, 0, "minecraft:air");
      w.set(x, 66, 0, "minecraft:air"); // step-up jump clearance over the void
    }
    w.set(3, 64, 0, "minecraft:iron_ore"); // ore across the void; its top (stand-pos) is y=65, +1 up
    w.set(3, 65, 0, "minecraft:air");
    w.set(3, 66, 0, "minecraft:air");
    const start = { x: 0, y: 64, z: 0 };
    const goal = new GoalBlock({ x: 3, y: 65, z: 0 }); // stand on the ore-top, above the bridge plane
    const r = planPath(w.reader, start, goal, {
      ...DEFAULT_PLANNER_OPTS,
      bridge: true,
      bridgePenalty: 20,
    });
    expect(r).not.toBeNull();
    const path = r?.path ?? [];
    expect(path[path.length - 1]).toEqual({ x: 3, y: 65, z: 0 }); // ends on the ore-top
    const last = path[path.length - 1];
    const prev = path[path.length - 2];
    expect((last?.y ?? 0) - (prev?.y ?? 0)).toBe(1); // the final move ASCENDS one (the stepUp finish)
  });

  it("composes bridge + dropDownSafe to reach a ravine's lower far rim", () => {
    const w = world();
    w.stand(0, 64, 0); // near rim
    for (const x of [1, 2]) {
      w.set(x, 64, 0, "minecraft:air"); // 2-cell void at the bridge plane
      w.set(x, 65, 0, "minecraft:air");
    }
    w.set(3, 64, 0, "minecraft:air"); // the drop column: air at the plane…
    w.set(3, 65, 0, "minecraft:air");
    w.stand(3, 63, 0); // …far rim ONE block below → bridge flat to (2,64), then dropDownSafe onto (3,63)
    const start = { x: 0, y: 64, z: 0 };
    const goal = new GoalBlock({ x: 3, y: 63, z: 0 });
    const r = planPath(w.reader, start, goal, {
      ...DEFAULT_PLANNER_OPTS,
      bridge: true,
      bridgePenalty: 20,
    });
    expect(r).not.toBeNull();
    const path = r?.path ?? [];
    expect(path[path.length - 1]).toEqual({ x: 3, y: 63, z: 0 }); // ends on the lower far rim
    const last = path[path.length - 1];
    const prev = path[path.length - 2];
    expect((last?.y ?? 0) - (prev?.y ?? 0)).toBe(-1); // the final move DESCENDS one (the dropDownSafe finish)
  });

  it("prefers a parkour hop over a bridge when the gap is jumpable (no wasted filler)", () => {
    const w = world();
    w.stand(0, 64, 0);
    w.stand(3, 64, 0); // a 2-cell void → parkour dist 3 lands it
    for (const x of [1, 2]) {
      w.set(x, 64, 0, "minecraft:air");
      w.set(x, 65, 0, "minecraft:air");
    }
    const start = { x: 0, y: 64, z: 0 };
    const goal = new GoalBlock({ x: 3, y: 64, z: 0 });
    // both moves available — parkour (WALK×3) is cheaper than 2 bridges (2×(WALK+20))
    const r = planPath(w.reader, start, goal, {
      ...DEFAULT_PLANNER_OPTS,
      parkour: true,
      maxParkour: 4,
      bridge: true,
      bridgePenalty: 20,
    });
    expect(r).not.toBeNull();
    expect(r?.path.length).toBe(2); // a single parkour hop, not a bridge chain
  });
});

describe("planPath", () => {
  it("walks a straight flat corridor at the walk cost", () => {
    const w = world();
    for (let x = 0; x <= 5; x++) w.stand(x, 64, 0);
    const r = planPath(w.reader, { x: 0, y: 64, z: 0 }, new GoalBlock({ x: 5, y: 64, z: 0 }));
    expect(r).not.toBeNull();
    const path = r?.path ?? [];
    expect(path.length).toBe(6);
    expect(path[path.length - 1]).toEqual({ x: 5, y: 64, z: 0 });
    expect(r?.cost).toBeCloseTo(5 * WALK_ONE_BLOCK_TICKS, 3);
  });

  it("climbs a step up onto a raised block", () => {
    const w = world();
    w.stand(0, 64, 0);
    w.stand(1, 64, 0);
    w.stand(2, 64, 0);
    w.stand(3, 65, 0); // one block higher
    const r = planPath(w.reader, { x: 0, y: 64, z: 0 }, new GoalBlock({ x: 3, y: 65, z: 0 }));
    expect(r).not.toBeNull();
    const path = r?.path ?? [];
    expect(path[path.length - 1]).toEqual({ x: 3, y: 65, z: 0 });
  });

  it("drops down a safe ledge", () => {
    const w = world();
    w.stand(0, 64, 0);
    w.stand(1, 64, 0);
    w.stand(2, 64, 0);
    w.set(3, 64, 0, "minecraft:air"); // open column to fall through
    w.set(3, 65, 0, "minecraft:air");
    w.stand(3, 61, 0); // ground 3 blocks down (safe: ≤ 3, 0 damage)
    const r = planPath(w.reader, { x: 0, y: 64, z: 0 }, new GoalBlock({ x: 3, y: 61, z: 0 }));
    expect(r).not.toBeNull();
    const path = r?.path ?? [];
    expect(path[path.length - 1]).toEqual({ x: 3, y: 61, z: 0 });
  });

  it("returns null for an unreachable goal", () => {
    const w = world();
    w.stand(0, 64, 0); // goal cell never built
    const r = planPath(w.reader, { x: 0, y: 64, z: 0 }, new GoalBlock({ x: 9, y: 64, z: 0 }));
    expect(r).toBeNull();
  });

  it("GoalXZ reaches a column at the wrong-guessed Y EXACTLY — no bestEffort needed", () => {
    // The walk-to-vein win: the surface is y64 but the vein Y is unknown (guessed y66). A GoalBlock
    // floats and needs bestEffort; a GoalXZ ignores Y and just walks to the column at its surface.
    const w = world();
    for (let x = 0; x <= 5; x++) w.stand(x, 64, 0);
    expect(
      planPath(w.reader, { x: 0, y: 64, z: 0 }, new GoalBlock({ x: 5, y: 66, z: 0 })),
    ).toBeNull();
    const r = planPath(w.reader, { x: 0, y: 64, z: 0 }, new GoalXZ(5, 0));
    expect(r).not.toBeNull();
    const p = r?.path ?? [];
    expect(p[p.length - 1]).toEqual({ x: 5, y: 64, z: 0 }); // arrived on the column, surface Y
  });

  it("bestEffort approaches an unreachable GoalBlock — lands on the closest cell", () => {
    const w = world();
    for (let x = 0; x <= 5; x++) w.stand(x, 64, 0);
    const approached = planPath(
      w.reader,
      { x: 0, y: 64, z: 0 },
      new GoalBlock({ x: 5, y: 66, z: 0 }),
      { ...DEFAULT_PLANNER_OPTS, bestEffort: true },
    );
    expect(approached).not.toBeNull();
    const p = approached?.path ?? [];
    expect(p[p.length - 1]).toEqual({ x: 5, y: 64, z: 0 }); // the column surface under the goal
  });

  it("bestEffort still returns null when it cannot beat the start", () => {
    const w = world();
    w.stand(0, 64, 0); // walled in — no neighbor is standable
    const r = planPath(w.reader, { x: 0, y: 64, z: 0 }, new GoalBlock({ x: 9, y: 64, z: 0 }), {
      ...DEFAULT_PLANNER_OPTS,
      bestEffort: true,
    });
    expect(r).toBeNull();
  });
});

/** Carve an adjacent column at x=1 that the bot can step into and then drop down `feetY-1 → surfaceY`
 *  onto solid ground (open feet+head at the start plane and at the landing). `surfaceY` is the block
 *  the player lands ON; the drop = (startY-1) - surfaceY. Intermediate cells stay null (a real gap). */
function dropColumn(
  w: ReturnType<typeof world>,
  startY: number,
  surfaceY: number,
  floor = "minecraft:stone",
) {
  w.set(1, startY, 0, "minecraft:air"); // step-in cell (feet)
  w.set(1, startY + 1, 0, "minecraft:air"); // head clearance
  w.set(1, surfaceY, 0, floor); // landing surface
  w.set(1, surfaceY + 1, 0, "minecraft:air"); // landing feet
  w.set(1, surfaceY + 2, 0, "minecraft:air"); // landing head
}

describe("neighbors with waterDrop (proactive clutch dive)", () => {
  it("offers a waterDrop into a fatal-but-finite drop when enabled (cost walk + fall + penalty)", () => {
    const w = world();
    w.stand(0, 64, 0); // start
    dropColumn(w, 64, 53); // step into x=1 and dive 10 blocks (64-1 → 53) onto stone — fatal at maxFallDamage 0
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      { maxDrop: 4, maxFallDamage: 0, waterDrop: true, waterDropMaxDrop: 48, waterDropPenalty: 40 },
    );
    const d = ns.find((n) => n.kind === "waterDrop" && n.to.x === 1 && n.to.y === 54);
    expect(d).toBeDefined();
    expect(d?.cost).toBeCloseTo(WALK_ONE_BLOCK_TICKS + fallTicks(10) + 40, 6);
  });

  it("does not offer a waterDrop without opts.waterDrop (gated like canBridge/canPillar)", () => {
    const w = world();
    w.stand(0, 64, 0);
    dropColumn(w, 64, 53);
    const ns = neighbors(w.reader, { x: 0, y: 64, z: 0 }, { maxDrop: 4, maxFallDamage: 0 });
    expect(ns.some((n) => n.kind === "waterDrop")).toBe(false);
  });

  it("does NOT waterDrop a SAFE short drop — dropDownSafe owns it (don't waste a bucket cycle)", () => {
    const w = world();
    w.stand(0, 64, 0);
    dropColumn(w, 64, 61); // a 2-block drop (63 → 61) → fall damage 0 → dropDownSafe, never waterDrop
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      { maxDrop: 4, maxFallDamage: 0, waterDrop: true, waterDropMaxDrop: 48, waterDropPenalty: 40 },
    );
    expect(ns.some((n) => n.kind === "waterDrop")).toBe(false);
    expect(ns.some((n) => n.kind === "dropDownSafe")).toBe(true);
  });

  it("does NOT waterDrop into a bottomless void (no landing within waterDropMaxDrop — can't clutch onto nothing)", () => {
    const w = world();
    w.stand(0, 64, 0);
    w.set(1, 64, 0, "minecraft:air"); // open feet+head, then open air all the way down within the scan bound
    w.set(1, 65, 0, "minecraft:air");
    for (let y = 63; y > 64 - 8; y--) w.set(1, y, 0, "minecraft:air");
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      { maxDrop: 4, maxFallDamage: 0, waterDrop: true, waterDropMaxDrop: 6, waterDropPenalty: 40 },
    );
    expect(ns.some((n) => n.kind === "waterDrop")).toBe(false);
  });

  it("does NOT waterDrop onto a hazard floor (water saves the fall, not a lava landing)", () => {
    const w = world();
    w.stand(0, 64, 0);
    dropColumn(w, 64, 53, "minecraft:lava"); // a fatal drop, but the landing block is lava → refuse
    const ns = neighbors(
      w.reader,
      { x: 0, y: 64, z: 0 },
      { maxDrop: 4, maxFallDamage: 0, waterDrop: true, waterDropMaxDrop: 48, waterDropPenalty: 40 },
    );
    expect(ns.some((n) => n.kind === "waterDrop")).toBe(false);
  });
});

describe("planPath with waterDrop", () => {
  it("descends a deep shaft via a waterDrop dive when no safe route exists", () => {
    const w = world();
    w.stand(0, 64, 0); // start at the shaft top
    dropColumn(w, 64, 50); // a 13-block plunge to the shaft floor (x=1), fatal without a clutch
    const start = { x: 0, y: 64, z: 0 };
    const goal = new GoalBlock({ x: 1, y: 51, z: 0 });
    // no safe descent (the drop is fatal, no staircase) → unreachable until waterDrop is enabled
    expect(planPath(w.reader, start, goal)).toBeNull();
    const r = planPath(w.reader, start, goal, {
      ...DEFAULT_PLANNER_OPTS,
      waterDrop: true,
      waterDropMaxDrop: 48,
      waterDropPenalty: 40,
    });
    expect(r).not.toBeNull();
    const path = r?.path ?? [];
    expect(path[path.length - 1]).toEqual({ x: 1, y: 51, z: 0 });
  });
});

describe("PlanSearch expansion cap", () => {
  // A 1-wide corridor: A* pops its cells in order, so reaching x=d takes exactly d expansions.
  it("a goal d expansions away is found under a cap of d, not under d - 1", () => {
    const w = world();
    const d = 6;
    for (let x = 0; x <= d; x++) w.stand(x, 64, 0);
    const found = (cap: number): boolean =>
      planPath(w.reader, { x: 0, y: 64, z: 0 }, new GoalBlock({ x: d, y: 64, z: 0 }), {
        ...DEFAULT_PLANNER_OPTS,
        maxExpansions: cap,
      }) !== null;
    expect(found(d)).toBe(true);
    expect(found(d - 1)).toBe(false);
  });
});

describe("smoothPath (string-pull)", () => {
  const Y = 64;
  const key = (c: { x: number; y: number; z: number }) => `${c.x},${c.y},${c.z}`;
  // A synthetic parallel kinds array for a hand-built path: "start" for path[0], "traverse" for the rest.
  // smoothPath's PATH output is independent of the kind VALUES (it branches on cell geometry), so these
  // tests — which only assert on the cells — pass any legal kinds array of the right length.
  const kindsFor = (p: readonly unknown[]): PathKind[] =>
    p.map((_, i) => (i === 0 ? "start" : "traverse"));

  it("collapses a manhattan zigzag to the straight diagonal on open flat ground", () => {
    const w = world();
    for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) w.stand(x, Y, z);
    // A staircase path (alternating cardinal steps) from (0,0) to (4,4).
    const zig = [
      { x: 0, y: Y, z: 0 },
      { x: 1, y: Y, z: 0 },
      { x: 1, y: Y, z: 1 },
      { x: 2, y: Y, z: 1 },
      { x: 2, y: Y, z: 2 },
      { x: 3, y: Y, z: 2 },
      { x: 3, y: Y, z: 3 },
      { x: 4, y: Y, z: 3 },
      { x: 4, y: Y, z: 4 },
    ];
    const out = smoothPath(w.reader, zig, kindsFor(zig)).path;
    expect(out).toEqual([
      { x: 0, y: Y, z: 0 },
      { x: 1, y: Y, z: 1 },
      { x: 2, y: Y, z: 2 },
      { x: 3, y: Y, z: 3 },
      { x: 4, y: Y, z: 4 },
    ]);
  });

  it("never cuts a wall corner — keeps the detour, every cell standable, reaches the goal", () => {
    const w = world();
    // An L-corridor only: row z=0 (x 0..3) + column x=3 (z 0..3). The inside (1,1)/(2,2) are NOT carved,
    // so a straight diagonal shortcut would clip non-standable cells.
    for (let x = 0; x <= 3; x++) w.stand(x, Y, 0);
    for (let z = 0; z <= 3; z++) w.stand(3, Y, z);
    const lpath = [
      { x: 0, y: Y, z: 0 },
      { x: 1, y: Y, z: 0 },
      { x: 2, y: Y, z: 0 },
      { x: 3, y: Y, z: 0 },
      { x: 3, y: Y, z: 1 },
      { x: 3, y: Y, z: 2 },
      { x: 3, y: Y, z: 3 },
    ];
    const out = smoothPath(w.reader, lpath, kindsFor(lpath)).path;
    // Reaches the goal, stays on carved cells, and never grabs the diagonal shortcut through the wall.
    expect(out[out.length - 1]).toEqual({ x: 3, y: Y, z: 3 });
    const carved = new Set(lpath.map(key));
    for (const c of out) expect(carved.has(key(c))).toBe(true);
    expect(out.some((c) => c.x === 1 && c.z === 1)).toBe(false);
    expect(out.some((c) => c.x === 2 && c.z === 2)).toBe(false);
  });

  it("preserves an EMBEDDED parkour landing verbatim — never interpolates the air cells over the gap", () => {
    // Live-found: a parkour is the ONE same-Y move that spans >1 cell. When it sits inside
    // a longer path (runway → parkour → …), the string-pull's flat branch used to lineCellsFlat the
    // takeoff→landing jump, INSERTING the air cells over the void as bogus `parkour` steps. The executor
    // then drove a parkour to the first AIR cell, whose floor is gone → ABORT_FLOOR_GONE every tick (and
    // that abort never latches parkourGaveUp → an infinite retreat/abort loop, never bridging).
    const w = world();
    for (let x = 0; x <= 3; x++) w.stand(x, Y, 0); // runway + takeoff at x=3
    w.stand(7, Y, 0); // landing past a 3-air gap (x=4,5,6 have no floor)
    const path = [
      { x: 0, y: Y, z: 0 },
      { x: 1, y: Y, z: 0 },
      { x: 2, y: Y, z: 0 },
      { x: 3, y: Y, z: 0 }, // takeoff
      { x: 7, y: Y, z: 0 }, // parkour landing — 4 cells away, same Y
    ];
    const kinds: PathKind[] = ["start", "traverse", "traverse", "traverse", "parkour"];
    const out = smoothPath(w.reader, path, kinds);
    // The takeoff is immediately followed by the REAL landing (kind parkour), not an air cell.
    expect(out.path).toEqual(path);
    // None of the void cells over the gap leaked into the smoothed path.
    for (const gx of [4, 5, 6]) expect(out.path.some((c) => c.x === gx)).toBe(false);
    // The landing keeps its parkour policy (so the executor drives the run-up, not a walk).
    const li = out.path.findIndex((c) => c.x === 7);
    expect(out.kinds[li]).toBe("parkour");
  });

  it("preserves a Y-change (step-up) cell verbatim, smoothing only the flat runs around it", () => {
    const w = world();
    for (let x = 0; x <= 2; x++) w.stand(x, Y, 0);
    for (let x = 3; x <= 5; x++) w.stand(x, Y + 1, 0);
    w.set(2, Y + 2, 0, "minecraft:air"); // jump clearance over the take-off
    const path = [
      { x: 0, y: Y, z: 0 },
      { x: 1, y: Y, z: 0 },
      { x: 2, y: Y, z: 0 },
      { x: 3, y: Y + 1, z: 0 },
      { x: 4, y: Y + 1, z: 0 },
      { x: 5, y: Y + 1, z: 0 },
    ];
    const out = smoothPath(w.reader, path, kindsFor(path)).path;
    expect(out).toContainEqual({ x: 3, y: Y + 1, z: 0 }); // the step-up cell survives unchanged
    expect(out[out.length - 1]).toEqual({ x: 5, y: Y + 1, z: 0 });
  });
});
