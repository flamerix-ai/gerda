import type { Vec3 } from "@/core/runtime/types";
// Property-based tests for the PURE navigator core (planner + movement-types + senses), run
// offline against thousands of fast-check-generated terrains. Where the hand-written nav-hill
// test pins ONE geometry, these assert INVARIANTS that must hold on every shape — and when one
// fails, fast-check shrinks to the minimal counterexample terrain (the "understand what and how" tool).
//
// The four load-bearing invariants:
//   1. COMPLETENESS — on a provably walk-connected field, strict A* always finds the exact goal.
//   2. LEGALITY     — any returned path is a chain of legal single moves onto walkable cells
//                     (no teleporting / no standing in a wall), on ANY terrain incl. cliffs/voids.
//   3. DETERMINISM  — same world + endpoints ⇒ byte-identical path.
//   4. BEST-EFFORT  — dominates strict (non-null whenever strict is) and never recedes from the goal.
import { GoalBlock } from "@/shared/domain/goal";
import type { MoveKind } from "@/shared/domain/movement-types";
import { DEFAULT_PLANNER_OPTS, type PathKind, planPath, smoothPath } from "@/shared/domain/planner";
import { type BlockReader, walkableAt } from "@/shared/domain/senses";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Heightfield, heightfieldReader, separableField, standCell } from "./_nav-terrain";

// Walk-only move set (no parkour/pillar/mine/bridge/waterDrop): the legal step ENVELOPE is then
// simple and INDEPENDENT of neighbors() — a real teleport/illegal-path bug can't hide behind the
// same code that generated it.
const WALK_OPTS = { ...DEFAULT_PLANNER_OPTS, maxDrop: 4, maxFallDamage: 0, bestEffort: false };
const WALK_BEST = { ...WALK_OPTS, bestEffort: true };

const floorEq = (a: Vec3, b: Vec3): boolean =>
  Math.floor(a.x) === Math.floor(b.x) &&
  Math.floor(a.y) === Math.floor(b.y) &&
  Math.floor(a.z) === Math.floor(b.z);

/** Is a→b a legal walk-only single step? |dx|,|dz|≤1; a diagonal changes Y by ≤1; a cardinal drops
 *  by ≤maxDrop or rises by 1; never a zero move (no pillar in the walk set). Pure geometry — derived
 *  from the move definitions, NOT from neighbors(), so it independently catches an over-generated edge. */
function legalWalkStep(a: Vec3, b: Vec3): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  if (Math.abs(dx) > 1 || Math.abs(dz) > 1) return false;
  if (dx === 0 && dz === 0) return false; // a pure vertical step needs pillar (off here)
  const diagonal = dx !== 0 && dz !== 0;
  if (diagonal) return dy >= -1 && dy <= 1;
  return dy >= -WALK_OPTS.maxDrop && dy <= 1;
}

// — Arbitraries ————————————————————————————————————————————————————————————————————————————————
// A field is W×D, built from two cumulative bounded-step profiles (see separableField). GENTLE
// steps ∈[-1,+1] make every cardinal neighbour reachable BOTH ways (rise +1 = stepUp, drop 1 =
// dropDownSafe) ⇒ the field is bidirectionally walk-connected. NB: a wider down-step like -2 is a
// +2 WALL in reverse that stepUp (only +1, no pillar here) cannot climb — fast-check found exactly
// that the first time this bound was [-3,+1], proving the connectivity precondition, not a planner
// bug. HARSH steps ∈[-6,+4] make cliffs/voids the planner must refuse (LEGALITY still holds).
function fieldArb(stepLo: number, stepHi: number) {
  return fc
    .record({
      w: fc.integer({ min: 2, max: 8 }),
      d: fc.integer({ min: 2, max: 8 }),
      xs: fc.array(fc.integer({ min: stepLo, max: stepHi }), { minLength: 7, maxLength: 7 }),
      zs: fc.array(fc.integer({ min: stepLo, max: stepHi }), { minLength: 7, maxLength: 7 }),
      sa: fc.nat({ max: 63 }),
      sb: fc.nat({ max: 63 }),
      ga: fc.nat({ max: 63 }),
      gb: fc.nat({ max: 63 }),
    })
    .map(({ w, d, xs, zs, sa, sb, ga, gb }) => {
      const hf: Heightfield = separableField(0, 0, 70, xs.slice(0, w - 1), zs.slice(0, d - 1));
      return {
        hf,
        start: standCell(hf, sa % w, sb % d),
        goal: standCell(hf, ga % w, gb % d),
      };
    });
}

const gentle = fieldArb(-1, 1);
const harsh = fieldArb(-6, 4);

// Is the emitted policy `kind` LEGAL for the geometry of the edge a→b? Derived from the move
// definitions, INDEPENDENTLY of neighbors(), so a mis-threaded kind can't hide behind the code that
// produced it. `lenientFlat` allows a `traverse` to be a flat DIAGONAL step too — smoothPath re-labels a
// collapsed flat run (cardinal OR diagonal) as `traverse` since both drive identically through the walk
// driver; the RAW planner path keeps them strict (traverse = cardinal, diagonal = diagonal).
function edgeMatchesKind(kind: MoveKind, a: Vec3, b: Vec3, lenientFlat: boolean): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const card = Math.abs(dx) + Math.abs(dz) === 1;
  const diag = Math.abs(dx) === 1 && Math.abs(dz) === 1;
  const vert = dx === 0 && dz === 0;
  const flatAdj = dy === 0 && Math.max(Math.abs(dx), Math.abs(dz)) === 1 && !vert;
  switch (kind) {
    case "traverse":
      return lenientFlat ? flatAdj : card && dy === 0;
    case "stepUp":
      return card && dy === 1;
    case "dropDownSafe":
    case "waterDrop":
      return card && dy <= -1;
    case "diagonal":
      return diag && dy === 0;
    case "diagonalAscend":
      return diag && dy === 1;
    case "diagonalDescend":
      return diag && dy === -1;
    case "parkour":
      return (dx === 0 || dz === 0) && Math.abs(dx) + Math.abs(dz) >= 2 && dy === 0;
    case "mineTraverse":
    case "bridgePlace":
    case "ladderEnter":
      return card && dy === 0;
    case "mineAscend":
      return card && dy === 1;
    case "mineDescend":
      return card && dy === -1;
    case "pillarUp":
    case "ladderUp":
      return vert && dy === 1;
    case "mineDown":
    case "ladderDown":
      return vert && dy === -1;
  }
}

// The move-policy array is parallel to the path, starts with the sentinel, and every element is LEGAL
// for its edge. `lenientFlat` for a smoothed path (see edgeMatchesKind).
function assertKindsSound(
  path: readonly Vec3[],
  kinds: readonly PathKind[],
  lenientFlat: boolean,
): void {
  expect(kinds.length).toBe(path.length);
  expect(kinds[0]).toBe("start");
  for (let i = 1; i < path.length; i++) {
    const k = kinds[i];
    const a = path[i - 1];
    const b = path[i];
    if (!a || !b || k === undefined) throw new Error("path/kind hole");
    expect(k).not.toBe("start"); // only the start cell carries the sentinel
    expect(edgeMatchesKind(k as MoveKind, a, b, lenientFlat)).toBe(true);
  }
}

// Every interior cell of a returned path is a walkable stand; consecutive cells are legal steps.
function assertPathSound(reader: BlockReader, path: readonly Vec3[], start: Vec3): void {
  expect(floorEq(path[0] ?? start, start)).toBe(true);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (!a || !b) throw new Error("path hole");
    expect(legalWalkStep(a, b)).toBe(true);
    expect(walkableAt(reader, b)).toBe(true); // never routes the bot to stand inside a wall / float
  }
}

describe("planner properties — pure nav core on random terrain", () => {
  it("COMPLETENESS: strict A* reaches the exact goal on every walk-connected field", () => {
    fc.assert(
      fc.property(gentle, ({ hf, start, goal }) => {
        const r = planPath(heightfieldReader(hf), start, new GoalBlock(goal), WALK_OPTS);
        expect(r).not.toBeNull();
        if (r) {
          const last = r.path[r.path.length - 1];
          expect(last && floorEq(last, goal)).toBe(true);
          assertPathSound(heightfieldReader(hf), r.path, start);
        }
      }),
      { numRuns: 600 },
    );
  });

  it("LEGALITY: any non-null path is a legal walkable chain on ANY terrain (cliffs/voids)", () => {
    fc.assert(
      fc.property(harsh, ({ hf, start, goal }) => {
        const reader = heightfieldReader(hf);
        const r = planPath(reader, start, new GoalBlock(goal), WALK_OPTS);
        if (r) assertPathSound(reader, r.path, start);
      }),
      { numRuns: 600 },
    );
  });

  it("DETERMINISM: identical world + endpoints ⇒ identical path", () => {
    fc.assert(
      fc.property(harsh, ({ hf, start, goal }) => {
        const a = planPath(heightfieldReader(hf), start, new GoalBlock(goal), WALK_OPTS);
        const b = planPath(heightfieldReader(hf), start, new GoalBlock(goal), WALK_OPTS);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      }),
      { numRuns: 300 },
    );
  });

  it("BEST-EFFORT dominates strict: non-null whenever strict is, and never recedes from goal", () => {
    fc.assert(
      fc.property(harsh, ({ hf, start, goal }) => {
        const reader = heightfieldReader(hf);
        const g = new GoalBlock(goal);
        const strict = planPath(reader, start, g, WALK_OPTS);
        const best = planPath(reader, start, g, WALK_BEST);
        if (strict) expect(best).not.toBeNull();
        if (best) {
          assertPathSound(reader, best.path, start);
          const last = best.path[best.path.length - 1] ?? start;
          // best-effort lands at least as close to the goal as the start was.
          expect(g.heuristic(last)).toBeLessThanOrEqual(g.heuristic(start));
        }
      }),
      { numRuns: 600 },
    );
  });

  it("POLICY LEGALITY: kinds is parallel + start-sentinel + each kind legal for its edge", () => {
    fc.assert(
      fc.property(harsh, ({ hf, start, goal }) => {
        const reader = heightfieldReader(hf);
        const r = planPath(reader, start, new GoalBlock(goal), WALK_BEST);
        if (r) assertKindsSound(r.path, r.kinds, false);
      }),
      { numRuns: 600 },
    );
  });

  it("POLICY LEGALITY survives smoothing: the smoothed kinds stay parallel + legal for each edge", () => {
    fc.assert(
      fc.property(harsh, ({ hf, start, goal }) => {
        const reader = heightfieldReader(hf);
        const r = planPath(reader, start, new GoalBlock(goal), WALK_OPTS);
        if (!r || r.path.length < 2) return;
        const sm = smoothPath(reader, r.path, r.kinds);
        assertKindsSound(sm.path, sm.kinds, true); // lenient: a collapsed flat run is labelled traverse
      }),
      { numRuns: 600 },
    );
  });

  it("SMOOTH-PATH stays legal: string-pull preserves endpoints + the walkable-chain invariant", () => {
    fc.assert(
      fc.property(harsh, ({ hf, start, goal }) => {
        const reader = heightfieldReader(hf);
        const r = planPath(reader, start, new GoalBlock(goal), WALK_OPTS);
        if (!r || r.path.length < 2) return;
        const sm = smoothPath(reader, r.path, r.kinds).path;
        const first = sm[0];
        const last = sm[sm.length - 1];
        const rFirst = r.path[0];
        const rLast = r.path[r.path.length - 1];
        expect(first && rFirst && floorEq(first, rFirst)).toBe(true);
        expect(last && rLast && floorEq(last, rLast)).toBe(true);
        assertPathSound(reader, sm, start);
      }),
      { numRuns: 600 },
    );
  });
});
