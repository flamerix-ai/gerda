// Descent recoverability guard (viability-kernel / RCSPP). The greedy executor must never
// follow cheap unconditional drops DOWN into a ravine it can't climb back out of (live: a
// surface search sank a bot ~30 blocks into a pit and wedged). The hard veto is goal-aware and reads
// the Runtime for carried filler; its PURE decision core is `descentBeyondBudget`. The executor leg
// itself needs a physics sim to test (see the nav-offline harness note), so these lock the decision:
// hand-pinned cases + fast-check invariants that must hold for every rim/feet/next/goal/budget.
import { descentBeyondBudget } from "@/shared/nav";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

describe("descentBeyondBudget — the pure descent-veto decision", () => {
  it("never vetoes a non-descending step (level or rising)", () => {
    // rim 80, deep below the goal, zero budget — still allowed because next.y >= feet.y.
    expect(descentBeyondBudget(80, 64, 64, 79, 0, 0)).toBe(false); // level
    expect(descentBeyondBudget(80, 64, 70, 79, 0, 0)).toBe(false); // rising
  });

  it("never vetoes a step that stays at/above the goal's level (downward goal descends freely)", () => {
    // A mine-shaft goal at y20: every descending step toward it is at/above y20 until the very end.
    expect(descentBeyondBudget(70, 50, 49, 20, 0, 0)).toBe(false);
    expect(descentBeyondBudget(70, 30, 21, 20, 0, 0)).toBe(false);
    expect(descentBeyondBudget(70, 30, 20, 20, 0, 0)).toBe(false); // exactly at goal level
  });

  it("vetoes a descent that sinks past allowance + filler below the rim (the ravine plunge)", () => {
    // Surface leg: rim AND goal at y80, allowance 8, no filler. A step to y71 is 9 below rim > 8 → veto.
    expect(descentBeyondBudget(80, 72, 71, 80, 8, 0)).toBe(true);
    // one block shallower (y72, 8 below rim) is exactly within budget → allowed.
    expect(descentBeyondBudget(80, 73, 72, 80, 8, 0)).toBe(false);
  });

  it("carried filler extends the budget block-for-block (one pillar block = one block of climb-back)", () => {
    // The y71 step that vetoed with 0 filler is allowed once 1+ filler is carried (9 ≤ 8+1).
    expect(descentBeyondBudget(80, 72, 71, 80, 8, 0)).toBe(true);
    expect(descentBeyondBudget(80, 72, 71, 80, 8, 1)).toBe(false);
    expect(descentBeyondBudget(80, 72, 71, 80, 8, 64)).toBe(false);
  });

  it("MONOTONIC: once a depth is vetoed, every deeper descending step is also vetoed", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200 }), // rim
        fc.integer({ min: 0, max: 200 }), // feet
        fc.integer({ min: -100, max: 100 }), // goal
        fc.integer({ min: 0, max: 32 }), // allowance
        fc.integer({ min: 0, max: 64 }), // filler
        fc.integer({ min: 1, max: 50 }), // extra depth below the first vetoed cell
        (rim, feet, goal, allowance, filler, extra) => {
          // Find the shallowest descending cell that is below the goal: y = min(feet, goal) - 1.
          const y0 = Math.min(feet, goal) - 1;
          if (!descentBeyondBudget(rim, feet, y0, goal, allowance, filler)) return; // not vetoed here
          // Any deeper cell is still a descending sub-goal-level step ⇒ must remain vetoed.
          expect(descentBeyondBudget(rim, feet, y0 - extra, goal, allowance, filler)).toBe(true);
        },
      ),
      { numRuns: 600 },
    );
  });

  it("INVARIANT: a veto implies the bot would stand strictly deeper than its recovery budget allows", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: 0, max: 32 }),
        fc.integer({ min: 0, max: 64 }),
        (rim, feet, next, goal, allowance, filler) => {
          if (descentBeyondBudget(rim, feet, next, goal, allowance, filler)) {
            // The three conditions a veto guarantees: descending, below the goal, and beyond budget.
            expect(next).toBeLessThan(feet);
            expect(next).toBeLessThan(goal);
            expect(rim - next).toBeGreaterThan(allowance + filler);
          }
        },
      ),
      { numRuns: 600 },
    );
  });
});
