import type { Vec3 } from "@/core/runtime/types";
import { DStarLite, engageable } from "@/shared/domain/dstar";
// Property tests for D* Lite (src/shared/domain/dstar.ts) against the A* planner as a CORRECTNESS ORACLE.
// D* Lite is an incremental algorithm — easy to get subtly wrong (km bookkeeping, predecessor
// enumeration, under/over-consistent repair). The strongest guard is differential: on the SAME
// world + endpoints, D* Lite's optimal cost must EQUAL strict A*'s, for the initial search AND
// after the world is edited under it (incremental repair == replan-from-scratch). Reuses the
// fast-check terrain harness; the walk-only (bounded-reach) move set is exactly D* Lite's scope.
import { GoalBlock } from "@/shared/domain/goal";
import { DEFAULT_COST, DEFAULT_PLANNER_OPTS, planPath } from "@/shared/domain/planner";
import { type BlockReader, walkableAt } from "@/shared/domain/senses";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Heightfield, heightfieldReader, separableField, standCell } from "./_nav-terrain";

const OPTS = { ...DEFAULT_PLANNER_OPTS, maxDrop: 4, maxFallDamage: 0, bestEffort: false };

// True-optimum oracle: a GoalBlock whose heuristic is identically 0 turns planPath into Dijkstra
// (no admissibility concern), so its cost is the GUARANTEED minimum. Production A* (GoalBlock with
// octile+level) is slightly inadmissible downhill, so it is NOT a valid optimal reference — D* Lite,
// being admissible, can legitimately beat it. We assert D* == Dijkstra (both optimal).
class GoalDijkstra extends GoalBlock {
  override heuristic(): number {
    return 0;
  }
}

const floorEq = (a: Vec3, b: Vec3): boolean =>
  Math.floor(a.x) === Math.floor(b.x) &&
  Math.floor(a.y) === Math.floor(b.y) &&
  Math.floor(a.z) === Math.floor(b.z);

function legalStep(a: Vec3, b: Vec3): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  if (Math.abs(dx) > 1 || Math.abs(dz) > 1) return false;
  if (dx === 0 && dz === 0) return false;
  if (dx !== 0 && dz !== 0) return dy >= -1 && dy <= 1;
  return dy >= -OPTS.maxDrop && dy <= 1;
}

function assertSound(reader: BlockReader, path: readonly Vec3[], start: Vec3, goal: Vec3): void {
  expect(floorEq(path[0] ?? start, start)).toBe(true);
  expect(floorEq(path[path.length - 1] ?? start, goal)).toBe(true);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (!a || !b) throw new Error("path hole");
    expect(legalStep(a, b)).toBe(true);
    expect(walkableAt(reader, b)).toBe(true);
  }
}

// Gentle, bidirectionally walk-connected fields (steps ∈[-1,+1]) so the exact goal is always
// reachable both ways (see nav-planner.property.test.ts for why the bound is ±1).
function fieldArb() {
  return fc
    .record({
      w: fc.integer({ min: 2, max: 7 }),
      d: fc.integer({ min: 2, max: 7 }),
      xs: fc.array(fc.integer({ min: -1, max: 1 }), { minLength: 6, maxLength: 6 }),
      zs: fc.array(fc.integer({ min: -1, max: 1 }), { minLength: 6, maxLength: 6 }),
      sa: fc.nat({ max: 63 }),
      sb: fc.nat({ max: 63 }),
      ga: fc.nat({ max: 63 }),
      gb: fc.nat({ max: 63 }),
      ea: fc.nat({ max: 63 }),
      eb: fc.nat({ max: 63 }),
    })
    .map(({ w, d, xs, zs, sa, sb, ga, gb, ea, eb }) => {
      // `rows` is a MUTABLE copy (an edit bumps a column in place); the Heightfield shares the SAME
      // array objects, so the reader sees the mutation. We keep `rows` typed mutable separately.
      const hf = separableField(0, 0, 70, xs.slice(0, w - 1), zs.slice(0, d - 1));
      const rows: number[][] = hf.heights.map((c) => [...c]);
      const mhf: Heightfield = { ...hf, heights: rows };
      return {
        hf: mhf,
        rows,
        start: standCell(mhf, sa % w, sb % d),
        goal: standCell(mhf, ga % w, gb % d),
        edit: { ix: ea % w, iz: eb % d },
      };
    });
}

const fields = fieldArb();

function optimalCost(reader: BlockReader, start: Vec3, goal: Vec3): number | null {
  const r = planPath(reader, start, new GoalDijkstra(goal), OPTS);
  return r ? r.cost : null;
}

describe("D* Lite — differential correctness vs the true optimum", () => {
  it("scope gate: walk-only opts are engageable; any filler move disables D* Lite", () => {
    expect(engageable(OPTS)).toBe(true);
    expect(engageable({ ...OPTS, bridge: true })).toBe(false);
    expect(engageable({ ...OPTS, canPillar: true })).toBe(false);
    expect(engageable({ ...OPTS, mine: true })).toBe(false);
    expect(engageable({ ...OPTS, waterDrop: true })).toBe(false);
  });

  it("INITIAL: D* Lite cost == true optimum, path legal + reaches goal", () => {
    fc.assert(
      fc.property(fields, ({ hf, start, goal }) => {
        const reader = heightfieldReader(hf);
        const ds = new DStarLite(reader, start, goal, OPTS);
        const dp = ds.extractPath();
        const oc = optimalCost(reader, start, goal);
        expect(oc).not.toBeNull(); // gentle field ⇒ always reachable
        expect(dp).not.toBeNull();
        if (dp && oc !== null) {
          expect(dp.cost).toBeCloseTo(oc, 6);
          assertSound(reader, dp.path, start, goal);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("POLICY: extractPath emits a parallel kinds array, start-sentinel + kind legal for each edge", () => {
    // On the walk-only bounded set the g-descent edge kind must match the geometry of the step it took
    // (planner-emitted move policy): the same parallel-policy contract the A* planner carries, proven for the D* extractor.
    fc.assert(
      fc.property(fields, ({ hf, start, goal }) => {
        const reader = heightfieldReader(hf);
        const dp = new DStarLite(reader, start, goal, OPTS).extractPath();
        if (!dp) return;
        expect(dp.kinds.length).toBe(dp.path.length);
        expect(dp.kinds[0]).toBe("start");
        for (let i = 1; i < dp.path.length; i++) {
          const a = dp.path[i - 1];
          const b = dp.path[i];
          const k = dp.kinds[i];
          if (!a || !b || k === undefined) throw new Error("path/kind hole");
          expect(k).not.toBe("start");
          expect(legalStep(a, b)).toBe(true); // the walk-set geometry the emitted kind must fit
        }
      }),
      { numRuns: 300 },
    );
  });

  it("MOVING START: re-rooting via setStart matches the optimum from the new start", () => {
    fc.assert(
      fc.property(fields, ({ hf, start, goal }) => {
        const reader = heightfieldReader(hf);
        const ds = new DStarLite(reader, start, goal, OPTS);
        const first = ds.extractPath();
        if (!first || first.path.length < 2) return;
        const step = first.path[1]; // advance one cell along the optimal route
        if (!step) return;
        ds.setStart(step);
        const dp = ds.extractPath();
        const oc = optimalCost(reader, step, goal);
        if (oc !== null && dp) expect(dp.cost).toBeCloseTo(oc, 6);
      }),
      { numRuns: 300 },
    );
  });

  // FIXED (was quarantined). The incremental repair failed whenever an edit
  // flipped a cell's STANDABILITY because notifyChanges' dirty box did not mirror pred()'s reach:
  // ±1 horizontally missed PARKOUR predecessors (reach rH = maxParkour), and the vertical range
  // extended maxDrop DOWN when drop-move predecessors sit up to maxDrop ABOVE their landing. Stale
  // rhs on those out-of-box vertices kept phantom edges into a buried stand cell (raise) and never
  // saw the new cheaper drop edge (lower). The fix widens the box to ±(rH+1) × [c.y-3, c.y+maxDrop+2]
  // — no updateVertex/walkableAt guard needed (an earlier attempt at one regressed start/goal edits).
  // Still NOT on the production path (dstarNext never calls notifyChanges), but the entry point is
  // now differentially correct vs the Dijkstra oracle.
  it("INCREMENTAL: after raising a column under the route, repaired cost == replan-from-scratch", () => {
    fc.assert(
      fc.property(fields, ({ hf, rows, start, goal, edit }) => {
        const reader = heightfieldReader(hf); // closes over hf.heights (mutated in place below)
        const ds = new DStarLite(reader, start, goal, OPTS);
        ds.extractPath();
        // Edit: raise the edit column by +1 (still ±1-connected). The newly-solid cell is the old
        // surface+1 becoming stone; its block read flips air→stone.
        const col = rows[edit.ix];
        if (!col) return;
        const oldH = col[edit.iz];
        if (oldH === undefined) return;
        const newH = oldH + 1;
        col[edit.iz] = newH;
        const changed: Vec3[] = [{ x: hf.X0 + edit.ix, y: newH, z: hf.Z0 + edit.iz }];
        ds.notifyChanges(reader, changed);
        const dp = ds.extractPath();
        const oc = optimalCost(reader, start, goal); // fresh optimum over the edited world
        // Both must agree on reachability and cost.
        expect(dp === null).toBe(oc === null);
        if (dp && oc !== null) {
          expect(dp.cost).toBeCloseTo(oc, 6);
          assertSound(reader, dp.path, start, goal);
        }
      }),
      { numRuns: 300 },
    );
  });

  // DETERMINISTIC REGRESSION for the intermittent INCREMENTAL-repair flake. The two
  // random INCREMENTAL properties above failed ~1-in-5 runs under fast-check, ISOLATED, on a genuine
  // repair bug (NOT shared state — the memory's singleton prior was wrong). This pins the minimal
  // shrunk counterexample so the bug can never silently return: a FLAT plane where a single +1 raise
  // BURIES the stand cell on the only straight corridor, forcing a re-route the whole way around.
  // Two coupled defects made repair report the goal UNREACHABLE here:
  //   1. updateVertex recomputed a vertex's rhs from its OUTGOING edges without checking the vertex
  //      itself was still standable, so the buried cell kept a phantom finite g/rhs (fixed: the
  //      occupiable() guard forces rhs=INF for a non-standable, non-start vertex);
  //   2. converged() compared the queue top's k1 to the start's k1 with EXACT ==, but the same path
  //      cost summed as (2 edges + a 3-cell octile heuristic) vs (5 accumulated edges) differs by one
  //      float ULP → the tied top read as "≥ start" and halted the increase-wave one pop early, leaving
  //      stale g on every vertex upstream of the cut (fixed: keyLessTol's relative-ULP tolerance).
  // On the pre-fix code `repaired` is null; post-fix it equals the from-scratch optimum.
  it("INCREMENTAL regression: a raise that severs the only corridor re-routes (no phantom-unreachable)", () => {
    const flat = (): number[][] => [
      [70, 70, 70, 70, 70, 70, 70],
      [70, 70, 70, 70, 70, 70, 70],
    ];
    const mk = (rows: number[][]): Heightfield => ({ heights: rows, X0: 0, Z0: 0, W: 2, D: 7 });
    const start = standCell(mk(flat()), 0, 5); // (0,71,5)
    const goal = standCell(mk(flat()), 0, 0); // (0,71,0)

    const ds = new DStarLite(heightfieldReader(mk(flat())), start, goal, OPTS);
    ds.extractPath();

    // Raise column (x=0,z=1) by +1: the block at y=71 turns to stone, burying the (0,71,1) stand cell
    // that the straight x=0 corridor ran through. The route must now detour via the x=1 lane.
    const raised = flat();
    const raisedCol = raised[0];
    if (!raisedCol) throw new Error("raised[0] hole");
    raisedCol[1] = 71;
    const reader2 = heightfieldReader(mk(raised));
    ds.notifyChanges(reader2, [{ x: 0, y: 71, z: 1 }]);

    const repaired = ds.extractPath();
    const oc = optimalCost(reader2, start, goal);
    expect(oc).not.toBeNull(); // the goal IS reachable around the bump
    expect(repaired).not.toBeNull(); // ← was null on the buggy repair (phantom-unreachable)
    if (repaired && oc !== null) {
      expect(repaired.cost).toBeCloseTo(oc, 6);
      assertSound(reader2, repaired.path, start, goal);
    }
  });

  // ANYTIME (the cold-start freeze fix): a tiny per-call budget means computeShortestPath yields
  // BEFORE the backward wavefront reaches the start. The searcher must report "still computing" (not
  // converged, not reachable) and hand back a best-effort step toward the goal so the bot walks while
  // the tree finishes — instead of the ~9 s synchronous freeze the full search caused live.
  it("ANYTIME: a budget-1 search hasn't converged but yields a best-effort step toward the goal", () => {
    // A long flat corridor so the start is many pops from the goal-rooted wavefront.
    const hf = separableField(0, 0, 70, [0, 0, 0, 0, 0, 0, 0], [0]);
    const reader = heightfieldReader(hf);
    const start = standCell(hf, 0, 0);
    const goal = standCell(hf, 7, 0);

    const ds = new DStarLite(reader, start, goal, OPTS, DEFAULT_COST, 1); // budget = 1 pop
    expect(ds.converged()).toBe(false); // wavefront nowhere near the start yet
    expect(ds.reachable()).toBe(false); // g(start) still INF → no path to extract
    expect(ds.extractPath()).toBeNull();

    const step = ds.bestEffortStep();
    expect(step).not.toBeNull();
    if (step) {
      // toward the goal: strictly closer in x (the corridor axis) than the start was
      expect(Math.abs(step.x - goal.x)).toBeLessThan(Math.abs(start.x - goal.x));
    }

    // The SAME field run to completion (no budget) converges and reaches the goal — proving budget-1
    // was a partial-progress state, not an unreachable one.
    const full = new DStarLite(reader, start, goal, OPTS);
    expect(full.converged()).toBe(true);
    expect(full.reachable()).toBe(true);
    const fp = full.extractPath();
    expect(fp).not.toBeNull();
    if (fp) assertSound(reader, fp.path, start, goal);
  });

  // Same dirty-box fix as the raise case above — the lower direction exercises the missing
  // drop-predecessor coverage (the improvement has to PROPAGATE from above the changed cell).
  it("INCREMENTAL: lowering a column repairs to the new cheaper cost", () => {
    fc.assert(
      fc.property(fields, ({ hf, rows, start, goal, edit }) => {
        const reader = heightfieldReader(hf);
        const ds = new DStarLite(reader, start, goal, OPTS);
        ds.extractPath();
        const col = rows[edit.ix];
        if (!col) return;
        const oldH = col[edit.iz];
        if (oldH === undefined) return;
        const newH = oldH - 1; // remove the top block → air where stone was
        col[edit.iz] = newH;
        const changed: Vec3[] = [{ x: hf.X0 + edit.ix, y: oldH, z: hf.Z0 + edit.iz }];
        ds.notifyChanges(reader, changed);
        const dp = ds.extractPath();
        const oc = optimalCost(reader, start, goal);
        expect(dp === null).toBe(oc === null);
        if (dp && oc !== null) expect(dp.cost).toBeCloseTo(oc, 6);
      }),
      { numRuns: 300 },
    );
  });
});
