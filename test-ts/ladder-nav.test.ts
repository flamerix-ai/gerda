// Ladder climbing ("Both: ladder, else dig"): the navigator rides an existing ladder/vine
// to reach a different level, the clean non-destructive alternative to pillarUp/mineDown. Pure tests
// over synthetic voxel worlds: the climbableAt sense, the three ladder moves (ladderEnter/Up/Down),
// and an end-to-end plan that climbs a ladder onto an upper floor and PREFERS it over a pillar.
import { LADDER_ONE_BLOCK_TICKS, WALK_ONE_BLOCK_TICKS } from "@/core/prim/movement-physics";
import { encodePos } from "@/core/prim/pos";
import { GoalBlock } from "@/shared/domain/goal";
import { neighbors } from "@/shared/domain/movement-types";
import { DEFAULT_PLANNER_OPTS, planPath } from "@/shared/domain/planner";
import { type BlockReader, climbableAt } from "@/shared/domain/senses";
import { describe, expect, it } from "vitest";

/** A mutable voxel world. `stand` carves a standable feet cell; `ladder` places a climbable cell
 *  backed by a stone wall (so the executor can find a facing); `wall` places plain stone. */
function world() {
  const m = new Map<string, string>();
  const set = (x: number, y: number, z: number, id: string) => m.set(encodePos(x, y, z), id);
  const reader: BlockReader = (x, y, z) => m.get(encodePos(x, y, z)) ?? null;
  // Fill a bounding box with air first (an unset cell reads null = conservatively solid, so a sparse
  // world wrongly walls off jump clearance / heads — carve the open space explicitly, then place blocks).
  const fillAir = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) set(x, y, z, "minecraft:air");
  };
  const stand = (x: number, y: number, z: number) => {
    set(x, y - 1, z, "minecraft:stone");
    set(x, y, z, "minecraft:air");
    set(x, y + 1, z, "minecraft:air");
    set(x, y + 2, z, "minecraft:air");
  };
  const ladder = (x: number, y: number, z: number) => {
    set(x, y, z, "minecraft:ladder");
    set(x + 1, y, z, "minecraft:stone"); // backing wall (gives ladderFacing a target)
  };
  return { set, reader, stand, ladder, fillAir };
}

const LADDER = { ...DEFAULT_PLANNER_OPTS, maxDrop: 4, maxFallDamage: 0, ladder: true } as const;
const NO_LADDER = { ...DEFAULT_PLANNER_OPTS, maxDrop: 4, maxFallDamage: 0 } as const;

describe("climbableAt sense", () => {
  it("is true for ladders/vines/scaffolding, false for solids/air/unknown", () => {
    const w = world();
    w.set(0, 64, 0, "minecraft:ladder");
    w.set(0, 65, 0, "minecraft:vine");
    w.set(0, 66, 0, "minecraft:scaffolding");
    w.set(1, 64, 0, "minecraft:stone");
    w.set(2, 64, 0, "minecraft:air");
    expect(climbableAt(w.reader, { x: 0, y: 64, z: 0 })).toBe(true);
    expect(climbableAt(w.reader, { x: 0, y: 65, z: 0 })).toBe(true);
    expect(climbableAt(w.reader, { x: 0, y: 66, z: 0 })).toBe(true);
    expect(climbableAt(w.reader, { x: 1, y: 64, z: 0 })).toBe(false);
    expect(climbableAt(w.reader, { x: 2, y: 64, z: 0 })).toBe(false);
    expect(climbableAt(w.reader, { x: 9, y: 9, z: 9 })).toBe(false); // unknown → false
  });
});

describe("ladder moves", () => {
  it("ladderEnter: steps from a floor onto an adjacent ladder cell (cost = a walk)", () => {
    const w = world();
    w.stand(0, 64, 0); // standing
    w.ladder(1, 64, 0); // ladder one step ahead (+X)
    w.set(1, 65, 0, "minecraft:air"); // head above the ladder cell open
    const ns = neighbors(w.reader, { x: 0, y: 64, z: 0 }, LADDER);
    const enter = ns.find((n) => n.kind === "ladderEnter" && n.to.x === 1 && n.to.y === 64);
    expect(enter).toBeDefined();
    expect(enter?.cost).toBeCloseTo(WALK_ONE_BLOCK_TICKS, 6);
  });

  it("ladderUp: climbs one rung when on a ladder that continues above (cost = climb tick)", () => {
    const w = world();
    w.ladder(1, 64, 0);
    w.ladder(1, 65, 0);
    w.set(1, 66, 0, "minecraft:air"); // head clearance above the new feet
    const ns = neighbors(w.reader, { x: 1, y: 64, z: 0 }, LADDER);
    const up = ns.find((n) => n.kind === "ladderUp" && n.to.y === 65);
    expect(up).toBeDefined();
    expect(up?.cost).toBeCloseTo(LADDER_ONE_BLOCK_TICKS, 6);
  });

  it("ladderUp: TOPS OUT onto the stand above the last rung (mantle off the ladder)", () => {
    const w = world();
    w.ladder(1, 64, 0); // single rung (the top)
    w.set(1, 65, 0, "minecraft:air"); // stand-on-top cell
    w.set(1, 66, 0, "minecraft:air"); // head clearance for the stand
    const ns = neighbors(w.reader, { x: 1, y: 64, z: 0 }, LADDER);
    const top = ns.find((n) => n.kind === "ladderUp" && n.to.y === 65);
    expect(top).toBeDefined(); // can rise to stand ON TOP of the ladder (floor below = the rung)
  });

  it("ladderUp: refuses when the cell above is neither climbable nor a clear stand", () => {
    const w = world();
    w.ladder(1, 64, 0);
    w.set(1, 65, 0, "minecraft:air");
    w.set(1, 66, 0, "minecraft:stone"); // head blocked → can't top out, no rung above → no climb
    const ns = neighbors(w.reader, { x: 1, y: 64, z: 0 }, LADDER);
    expect(ns.some((n) => n.kind === "ladderUp")).toBe(false);
  });

  it("ladderDown: descends one rung when the ladder continues below", () => {
    const w = world();
    w.ladder(1, 65, 0);
    w.ladder(1, 64, 0);
    const ns = neighbors(w.reader, { x: 1, y: 65, z: 0 }, LADDER);
    const down = ns.find((n) => n.kind === "ladderDown" && n.to.y === 64);
    expect(down).toBeDefined();
    expect(down?.cost).toBeCloseTo(LADDER_ONE_BLOCK_TICKS, 6);
  });

  it("offers NO ladder moves when opts.ladder is off (base move set unchanged)", () => {
    const w = world();
    w.stand(0, 64, 0);
    w.ladder(1, 64, 0);
    w.ladder(1, 65, 0);
    const ns = neighbors(w.reader, { x: 0, y: 64, z: 0 }, NO_LADDER);
    expect(ns.some((n) => n.kind.startsWith("ladder"))).toBe(false);
  });
});

describe("planPath with a ladder", () => {
  // A bottom floor at y64, a 3-tall ladder against a wall, an upper floor at y67 beside the ladder
  // top — the city's "chest on the floor above" shape. Without a ladder the upper floor is +3 sheer
  // (unreachable by walk-only); the ladder makes it reachable.
  function tower() {
    const w = world();
    w.fillAir(0, 1, 64, 69, 0, 0); // open the shaft (unset cells read as solid)
    w.stand(0, 64, 0); // bottom floor at x=0
    // ladder column at x=1, y=64..66 backed by the wall at x=2 (set by ladder())
    w.ladder(1, 64, 0);
    w.ladder(1, 65, 0);
    w.ladder(1, 66, 0);
    // upper floor at y67, one cell over from the ladder top (x=0): a stepUp off the top rung lands here.
    w.stand(0, 67, 0);
    return w;
  }

  it("routes UP the ladder to the upper floor", () => {
    const w = tower();
    const r = planPath(
      w.reader,
      { x: 0, y: 64, z: 0 },
      new GoalBlock({ x: 0, y: 67, z: 0 }),
      LADDER,
    );
    expect(r).not.toBeNull();
    expect(r?.path.some((c) => c.x === 1 && c.y >= 65)).toBe(true); // went through the ladder column
    const last = r ? r.path[r.path.length - 1] : undefined;
    expect(last).toEqual({ x: 0, y: 67, z: 0 });
  });

  it("cannot reach the upper floor without ladder support (walk-only)", () => {
    const w = tower();
    const r = planPath(
      w.reader,
      { x: 0, y: 64, z: 0 },
      new GoalBlock({ x: 0, y: 67, z: 0 }),
      NO_LADDER,
    );
    // No pillar/mine either → the +3 sheer upper floor is unreachable; strict planPath returns null.
    expect(r).toBeNull();
  });

  it("a climb rung is cheaper than a pillar rung (so the planner prefers a ladder where one exists)", () => {
    // A ladder rung costs one climb tick; a pillar rung costs a jump + the placement penalty. The two
    // never apply at the SAME cell (pillarUp needs a passable cell above, a ladder cell is not passable),
    // so preference is a pure cost ordering: any route up a ladder out-bids the equivalent pillar climb.
    const w = world();
    w.ladder(1, 64, 0);
    w.ladder(1, 65, 0);
    w.set(1, 66, 0, "minecraft:air");
    const rung = neighbors(w.reader, { x: 1, y: 64, z: 0 }, LADDER).find(
      (n) => n.kind === "ladderUp",
    );
    // open column with filler available → a pillar rung
    const p = world();
    p.fillAir(0, 0, 64, 67, 0, 0);
    p.set(0, 63, 0, "minecraft:stone");
    const pillar = neighbors(
      p.reader,
      { x: 0, y: 64, z: 0 },
      {
        ...LADDER,
        canPillar: true,
        pillarPenalty: 20,
      },
    ).find((n) => n.kind === "pillarUp");
    expect(rung).toBeDefined();
    expect(pillar).toBeDefined();
    expect(rung?.cost ?? 0).toBeLessThan(pillar?.cost ?? Number.POSITIVE_INFINITY);
  });
});
