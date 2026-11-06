import type { Vec3 } from "@/core/runtime/types";
// Offline repro of the surface-traversal "blocked_no_path" gap (a Baritone-removal blocker).
// Reconstructs the exact hilly S-profile arena the in-game probe failed on and runs the REAL
// planner against it — ground truth for "is this a planner bug, a horizon/bestEffort policy, or
// a terrain-model artifact?", replacing reasoning-from-traces with a deterministic unit test.
import { GoalNear } from "@/shared/domain/goal";
import { DEFAULT_PLANNER_OPTS, planPath } from "@/shared/domain/planner";
import type { BlockReader } from "@/shared/domain/senses";
import { walkableAt } from "@/shared/domain/senses";
import { describe, expect, it } from "vitest";

// The arena: per-x stone columns y100→S(x) for the 3-wide strip z∈{-1,0,1}; everything else
// UNKNOWN (null) — exactly how a freshly-built solid hill reads to a cold world-view (only the
// strip the bot walked/sensed is known). Descend 110→105 (valley x207–210) then ascend → 113.
const S = [
  110, 110, 110, 109, 108, 107, 106, 105, 105, 105, 105, 106, 107, 108, 109, 110, 111, 112, 113,
  113, 113, 113, 113,
];
const X0 = 200;
const surfaceAt = (x: number): number | undefined => {
  const i = x - X0;
  return i >= 0 && i < S.length ? S[i] : undefined;
};
const stripReader: BlockReader = (x, y, z) => {
  if (z < -1 || z > 1) return null; // outside the sensed strip → unknown
  const s = surfaceAt(x);
  if (s === undefined) return null; // beyond the arena → unknown
  return y <= s ? "minecraft:stone" : "minecraft:air";
};

const START: Vec3 = { x: 200, y: 111, z: 0 }; // feet on surface S(200)=110

describe("nav-hill — surface-traversal planPath repro", () => {
  it("sanity: every surface stand-cell along the path is walkable", () => {
    const bad: string[] = [];
    for (let x = X0; x < X0 + S.length; x++) {
      const s = surfaceAt(x);
      if (s === undefined) continue;
      const feet = { x, y: s + 1, z: 0 };
      if (!walkableAt(stripReader, feet)) bad.push(`${x}@${feet.y}`);
    }
    // a non-empty list (printed by vitest on failure) = a real walkability hole in the surface
    expect(bad).toEqual([]);
  });

  // The in-game block was a mid-route REPLAN at the valley (x207.6), not a plan from start. So the
  // decisive probe is planPath from valley / mid-descent / airborne-floored start cells toward the
  // far goal — exactly what routeNext.replan() runs each time the cache invalidates en route.
  it("planPath from EVERY cell along the route still reaches the x=214 goal (mid-route replan)", () => {
    const target: Vec3 = { x: 214, y: 109, z: 0 };
    const goal = new GoalNear(target, 2.5);
    const opts = {
      ...DEFAULT_PLANNER_OPTS,
      maxDrop: 4,
      maxFallDamage: 0,
      bestEffort: false,
    };
    const nulls: string[] = [];
    // walk the descend-then-flat-then-ascend route the way the executor would, plus one block of
    // "airborne" overshoot per cell (feet one above the surface, as a mid-fall replan would floor).
    for (let x = 200; x <= 214; x++) {
      const s = surfaceAt(x);
      if (s === undefined) continue;
      for (const groundedFeetY of [s + 1, s + 2]) {
        const from: Vec3 = { x, y: groundedFeetY, z: 0 };
        const r = planPath(stripReader, from, goal, opts);
        if (r === null) nulls.push(JSON.stringify(from));
      }
    }
    // any entry (printed by vitest on failure) = a start cell the planner couldn't route from
    expect(nulls).toEqual([]);
  });

  // The crux: the in-game probe BLOCKED on the far (x214/x218) goals while x212 ARRIVED — yet the
  // planner reaches ALL of them here, strict==best (goal genuinely satisfied, best-effort never even
  // triggers). So the surface-traversal gap is NOT a planPath-null; it lives in the executor /
  // route-cache / live-cachingReader layer, which a pure planner test can't reproduce.
  for (const gx of [205, 207, 210, 212, 214, 218, 222]) {
    it(`planPath reaches the x=${gx} goal (strict, not best-effort)`, () => {
      const s = surfaceAt(gx);
      if (s === undefined) throw new Error("test goal off-arena");
      const target: Vec3 = { x: gx, y: s, z: 0 };
      const goal = new GoalNear(target, 2.5);
      const opts = { ...DEFAULT_PLANNER_OPTS, maxDrop: 4, maxFallDamage: 0, bestEffort: false };

      const strict = planPath(stripReader, START, goal, opts);
      const best = planPath(stripReader, START, goal, { ...opts, bestEffort: true });

      expect(strict).not.toBeNull(); // never null — the planner is sound on this hill
      if (strict) {
        const end = strict.path[strict.path.length - 1];
        expect(end && goal.isInGoal(end)).toBe(true); // path ends within the arrival radius
      }
      // strict already reaches the goal ⇒ best-effort returns the identical path (its fallback is dead).
      expect(JSON.stringify(best)).toBe(JSON.stringify(strict));
    });
  }
});
