// Greedy executor (own navigator; Baritone removed) — the key-driven local navigator, on the mock runtime. Verifies
// it steers + walks toward a target, stops on arrival, and the act-on-truth step-hazard veto
// blocks a step that the (stale) plan thinks is safe but the LIVE world says is lava.
import { makeGerdaConfig } from "@/bot/profile/config";
import { encodePos } from "@/core/prim/pos";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import type { Vec3 } from "@/core/runtime/types";
import {
  driveBridgeStep,
  greedyRelease,
  greedyStep,
  horizonSubGoal,
  isBlocked,
  navRouteSnapshot,
  parkourSnapshot,
  resetGreedyNav,
} from "@/shared/nav";
import { beforeEach, describe, expect, it } from "vitest";

const HOTBAR = 36; // HOTBAR_VANILLA_START — slot 0 of the hotbar

const cfg = makeGerdaConfig({});

/** Lay a flat stone floor at y=63 for x in [0..len], z=0 (feet/head cells are air by default). */
function corridor(rt: MockRuntime, len: number): void {
  for (let x = 0; x <= len; x++) rt.setBlock(x, 63, 0, "minecraft:stone");
}

describe("greedyStep", () => {
  beforeEach(() => resetGreedyNav()); // the planning cache is a module singleton

  it("faces the target and walks", () => {
    const rt = createMockRuntime();
    corridor(rt, 5);
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });

    const r = greedyStep(rt, cfg, { x: 5, y: 64, z: 0 });
    expect(r).toBe("moving");
    expect(rt.state.keys["key.forward"]).toBe(true);
    expect(rt.state.keys["key.jump"]).toBe(false); // flat — no step-up
    // first step is +X → MC yaw -90 (east); pitch level
    expect(rt.state.rotation.yaw).toBeCloseTo(-90, 3);
    expect(rt.state.rotation.pitch).toBeCloseTo(0, 6);
  });

  it("sprints on a clear flat runway, but walks the final approach", () => {
    const rt = createMockRuntime();
    corridor(rt, 10);
    const scfg = makeGerdaConfig({ nav: { sprint: true } }); // sprint is opt-in (default off — FOV-crash guard)

    // far from the target with ≥2 clear flat cells ahead → sprint asserted
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    expect(greedyStep(rt, scfg, { x: 10, y: 64, z: 0 })).toBe("moving");
    expect(rt.state.keys["key.sprint"]).toBe(true);

    // inside cfg.nav.sprintMinDist (3) but still beyond cfg.nav.gotoArrivalDist (2.5) → moving, but a WALK
    // (no sprint) for a precise, momentum-free stop on the final approach
    resetGreedyNav();
    rt.setPos({ x: 7.2, y: 64, z: 0.5 });
    expect(greedyStep(rt, scfg, { x: 10, y: 64, z: 0 })).toBe("moving");
    expect(rt.state.keys["key.sprint"]).toBe(false);
  });

  it("block goal reaches an adjacent cell where a tight-radius cell-CENTRE goal can't (excavate corridor bug)", () => {
    // The EXCAVATE/DIG_TO corridor-walk bug: greedyStep(cellCentre(next), {arrivalRadius: cfg.drill.centerTol})
    // targets a DIFFERENT cell with a sub-block radius. planPath tests INTEGER cells and the closest cell
    // coord is ~0.87 from its own centre — so a 0.2 radius is never satisfied → blocked_no_path on every
    // corridor step (the live NO_PATH spin that mined nothing). A GoalBlock (opts.block) floors → matches.
    const rt = createMockRuntime();
    corridor(rt, 3); // flat stone floor at y63, x∈[0..3]; feet/head air
    const cellCentre = { x: 1.5, y: 64.5, z: 0.5 }; // centre of the ADJACENT cell (1,64,0)

    // Bug repro: tight radius around the cell centre → the planner can't satisfy it → blocked.
    resetGreedyNav();
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    const blocked = greedyStep(rt, cfg, cellCentre, { arrivalRadius: 0.2 });
    expect(blocked).toBe("blocked_no_path");

    // Fix: a GoalBlock exact-cell arrival routes into the adjacent cell (walks toward it).
    resetGreedyNav();
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    const moving = greedyStep(rt, cfg, cellCentre, { block: true });
    expect(moving).toBe("moving");
    expect(rt.state.keys["key.forward"]).toBe(true);

    // …and once feet are IN the target cell, the block goal reports arrival.
    resetGreedyNav();
    rt.setPos({ x: 1.5, y: 64, z: 0.5 });
    expect(greedyStep(rt, cfg, cellCentre, { block: true })).toBe("arrived");
  });

  it("micro-walks (not blocks) when the route ends in a goal CELL whose far side is outside the radius", () => {
    // The attic-chest doorstep bug: the planner stops the route at the first cell whose INTEGER corner
    // satisfies GoalNear (diagonal cell corner = √2 ≈ 1.41 ≤ 2.5), but arrival tests the RAW player
    // position — and the far corner of that same cell is 2·√2 ≈ 2.83 > 2.5. Entering the final cell
    // from the far side: route consumed → no next → the old exact-cell doorstep test missed → spurious
    // blocked_no_path two steps from the goal. The doorstep test must mirror the planner's stop test.
    const rt = createMockRuntime();
    for (let x = 9; x <= 12; x++)
      for (let z = 9; z <= 12; z++) rt.setBlock(x, 63, z, "minecraft:stone");
    const target = { x: 10, y: 64, z: 10 }; // raw GoalNear target, default radius 2.5

    // Feet in cell (11,64,11) — in-goal by the planner's corner test — but pos at the FAR corner,
    // 2.76 > 2.5 from the target. Route from here is a single-cell path (start is in-goal) → no next.
    rt.setPos({ x: 11.95, y: 64, z: 11.95 });
    const r = greedyStep(rt, cfg, target);
    expect(r).toBe("moving"); // micro-walk toward the exact point, NOT blocked_no_path
    expect(rt.state.keys["key.forward"]).toBe(true);
    expect(rt.state.keys["key.sprint"]).toBe(false); // never sprint the final settle

    // A tick later the micro-walk has closed the sub-cell distance → raw-pos arrival fires.
    rt.setPos({ x: 11.3, y: 64, z: 11.3 });
    expect(greedyStep(rt, cfg, target)).toBe("arrived");
  });

  it("parkour run-up: CHARGES (sprint, no jump yet) from a slow takeoff", () => {
    const rt = createMockRuntime();
    // take-off floor at x=0, landing floor at x=3; x=1,2 are a bottomless void gap (unset = air,
    // no floor) the greedy planner can only cross with a parkour hop. No floor behind x=0 → no
    // retreat runway → the run-up starts straight in CHARGE.
    rt.setBlock(0, 63, 0, "minecraft:stone");
    rt.setBlock(3, 63, 0, "minecraft:stone");
    rt.setPos({ x: 0.5, y: 64, z: 0.5 }); // near edge of the takeoff, standstill (velocity 0)

    const pcfg = makeGerdaConfig({ nav: { parkour: true, parkourMaxGap: 3, sprint: true } });
    const r = greedyStep(rt, pcfg, { x: 3, y: 64, z: 0 });
    expect(r).toBe("moving");
    expect(rt.state.keys["key.forward"]).toBe(true);
    expect(rt.state.keys["key.sprint"]).toBe(true); // building run-up speed toward the gap
    expect(rt.state.keys["key.jump"]).toBe(false); // too slow to clear the gap — don't launch yet
    expect(rt.state.rotation.yaw).toBeCloseTo(-90, 3); // faces the landing cell centre: +X → yaw -90
  });

  it("parkour run-up: LAUNCHES (jump) once at takeoff speed on the takeoff cell", () => {
    const rt = createMockRuntime();
    rt.setBlock(0, 63, 0, "minecraft:stone");
    rt.setBlock(3, 63, 0, "minecraft:stone");
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });

    const pcfg = makeGerdaConfig({ nav: { parkour: true, parkourMaxGap: 3, sprint: true } });
    const tight = { arrivalRadius: 0.5 }; // x=0.78 is within the default 2.5 of x=3 → would "arrive" early
    greedyStep(rt, pcfg, { x: 3, y: 64, z: 0 }, tight); // tick 1: start the run-up (CHARGE)
    rt.setPos({ x: 0.78, y: 64, z: 0.5 }); // carried across to the take-off FAR edge…
    rt.state.velocity = { x: 0.3, y: 0, z: 0 }; // …at sprint speed
    const r = greedyStep(rt, pcfg, { x: 3, y: 64, z: 0 }, tight); // tick 2: run-up owns the tick → launch
    expect(r).toBe("moving");
    expect(rt.state.keys["key.sprint"]).toBe(true);
    expect(rt.state.keys["key.jump"]).toBe(true); // at the far edge at speed → fire the jump
    expect(rt.state.jumpCount).toBe(1); // and the REAL jump (jumpFromGround) fired — keybind alone won't
  });

  it("parkour run-up: RETREATS first when there is solid runway behind the takeoff", () => {
    const rt = createMockRuntime();
    for (let x = -3; x <= 0; x++) rt.setBlock(x, 63, 0, "minecraft:stone"); // 3 cells of runway behind
    rt.setBlock(3, 63, 0, "minecraft:stone"); // landing
    rt.setPos({ x: 0.5, y: 64, z: 0.5 }); // at the takeoff edge, standstill

    const pcfg = makeGerdaConfig({ nav: { parkour: true, parkourMaxGap: 3, sprint: true } });
    const r = greedyStep(rt, pcfg, { x: 3, y: 64, z: 0 });
    expect(r).toBe("moving");
    expect(rt.state.keys["key.forward"]).toBe(true);
    expect(rt.state.keys["key.jump"]).toBe(false); // backing up, not jumping
    // BACKUP walks toward the anchor BEHIND the takeoff (−X) → faces −X → MC yaw +90
    expect(rt.state.rotation.yaw).toBeCloseTo(90, 3);
  });

  it("parkour run-up: LAUNCHES a dist-4 jump at walk speed once a FULL run-up is built (boost clears it)", () => {
    const rt = createMockRuntime();
    // dist-4 gap: take-off x=0, void x=1,2,3, landing x=4, with a FULL run-up behind (x=-3..0). Live finding
    // (parkour_exp.py, ×6 runs): the charge only reaches walk speed (~0.153 — aiStep strips the sprint mult),
    // but the jump's sprint-jump BOOST carries ~4 blocks and clears dist-4 from the far edge. So walk speed
    // at the edge (≥ the cfg.nav.parkourTakeoffSpeed commitment floor) MUST launch — the old sprint-speed gate
    // wrongly refused a makeable jump. We drive the phases: BACKUP to the anchor → CHARGE → launch.
    for (let x = -3; x <= 0; x++) rt.setBlock(x, 63, 0, "minecraft:stone"); // full 3-cell run-up
    rt.setBlock(4, 63, 0, "minecraft:stone"); // landing
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });

    const pcfg = makeGerdaConfig({ nav: { parkour: true, parkourMaxGap: 3, sprint: true } });
    greedyStep(rt, pcfg, { x: 4, y: 64, z: 0 }); // tick 1: init the run-up — full runway → BACKUP
    expect(parkourSnapshot().active).toBe(true);
    expect(parkourSnapshot().phase).toBe("BACKUP");
    rt.setPos({ x: -2.5, y: 64, z: 0.5 }); // reached the retreat anchor (cell -3 centre)
    greedyStep(rt, pcfg, { x: 4, y: 64, z: 0 }); // tick 2: at the anchor → BACKUP_DONE → CHARGE
    expect(parkourSnapshot().phase).toBe("CHARGE");
    rt.setPos({ x: 0.78, y: 64, z: 0.5 }); // charged to the take-off far edge…
    rt.state.velocity = { x: 0.153, y: 0, z: 0 }; // …at walk speed (the live plateau, ≥ the 0.12 floor)
    const r = greedyStep(rt, pcfg, { x: 4, y: 64, z: 0 }); // tick 3: run-up owns the tick → launch
    expect(r).toBe("moving");
    expect(rt.state.keys["key.jump"]).toBe(true); // committed the jump — boost does the work
    expect(rt.state.jumpCount).toBe(1); // the REAL jumpFromGround fired
  });

  it("parkour run-up: REFUSES a dist-4 with no full run-up (bridges instead of walking off the lip)", () => {
    const rt = createMockRuntime();
    // dist-4 gap with NO solid ground behind the take-off (x=0) to build a run-up. Charging to the lip
    // would abort underpowered and the residual momentum would carry the bot off the edge before a bridge
    // could place (the abort-at-lip → fall bug). So the run-up must REFUSE up front: never activate, latch
    // parkourGaveUp, and leave the bot stationary so the planner re-plans a bridge. Give it filler so the
    // bridge can actually take over (else it just can't cross — still no fall, the point of the fix).
    rt.setBlock(0, 63, 0, "minecraft:stone"); // take-off only — nothing behind it
    rt.setBlock(4, 63, 0, "minecraft:stone"); // landing
    rt.state.slots.set(36, { id: "minecraft:cobblestone", count: 64, durabilityPct: 100 }); // held filler
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });

    const pcfg = makeGerdaConfig({ nav: { parkour: true, parkourMaxGap: 3, bridge: true } });
    const r = greedyStep(rt, pcfg, { x: 4, y: 64, z: 0 }); // tick 1: refuse → re-plan → bridge this tick
    expect(parkourSnapshot().active).toBe(false); // parkour never activated (no full run-up)
    expect(rt.state.keys["key.jump"]).toBe(false); // and definitely did NOT jump off the lip
    expect(rt.state.jumpCount).toBe(0);
    expect(r).toBe("moving"); // bridging / holding — crossing safely, never a fall
  });

  it("does not sprint toward a drop straight ahead (momentum slide-off guard)", () => {
    const rt = createMockRuntime();
    for (let x = 0; x <= 2; x++) rt.setBlock(x, 63, 0, "minecraft:stone"); // upper floor (stand y64)
    for (let x = 3; x <= 10; x++) rt.setBlock(x, 61, 0, "minecraft:stone"); // floor 2 lower → a drop
    rt.setPos({ x: 1.5, y: 64, z: 0.5 });

    // target is far (distance alone would sprint), but the cell straight ahead past `next` (x=3) is
    // a drop — sprinting risks momentum sliding the bot off the edge, so it must WALK.
    const r = greedyStep(rt, cfg, { x: 10, y: 62, z: 0 });
    expect(r).toBe("moving");
    expect(rt.state.keys["key.forward"]).toBe(true);
    expect(rt.state.keys["key.sprint"]).toBe(false);
  });

  it("does not sprint into a step-up", () => {
    const rt = createMockRuntime();
    rt.setBlock(0, 63, 0, "minecraft:stone"); // start floor (feet y=64)
    for (let x = 1; x <= 6; x++) rt.setBlock(x, 64, 0, "minecraft:stone"); // raised shelf
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });

    expect(greedyStep(rt, cfg, { x: 6, y: 65, z: 0 })).toBe("moving");
    expect(rt.state.keys["key.jump"]).toBe(true);
    expect(rt.state.keys["key.sprint"]).toBe(false); // step-up + sprint = overshoot risk
  });

  it("DOES sprint up a consistent staircase (sticky stair-sprint, cfg.nav.sprintStairs)", () => {
    const rt = createMockRuntime();
    rt.setBlock(0, 63, 0, "minecraft:stone"); // start floor (feet y=64)
    for (let x = 1; x <= 6; x++) rt.setBlock(x, 63 + x, 0, "minecraft:stone"); // staircase: stand y=64+x
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });

    // grounded on the first stair-step, the ascent CONTINUES (next two stair stands clear) → the latch
    // arms and sprint is held — unlike the single-step-onto-a-flat-shelf case above which must walk.
    const scfg = makeGerdaConfig({ nav: { sprint: true } }); // sprint is opt-in (default off — FOV-crash guard)
    expect(greedyStep(rt, scfg, { x: 6, y: 70, z: 0 })).toBe("moving");
    expect(rt.state.keys["key.jump"]).toBe(true);
    expect(rt.state.keys["key.sprint"]).toBe(true);
  });

  it("jumps to step up onto a +1 block", () => {
    const rt = createMockRuntime();
    rt.setBlock(0, 63, 0, "minecraft:stone"); // start floor (feet y=64)
    for (let x = 1; x <= 3; x++) rt.setBlock(x, 64, 0, "minecraft:stone"); // raised shelf (stand y=65)
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });

    // target far enough (>arrivalDist) that the first move is the step-up, not an instant arrive
    const r = greedyStep(rt, cfg, { x: 3, y: 65, z: 0 });
    expect(r).toBe("moving");
    expect(rt.state.keys["key.jump"]).toBe(true);
  });

  it("arrives within cfg.nav.gotoArrivalDist and releases keys", () => {
    const rt = createMockRuntime();
    corridor(rt, 5);
    rt.state.keys["key.forward"] = true; // pretend we were walking
    rt.setPos({ x: 4.5, y: 64, z: 0.5 });

    const r = greedyStep(rt, cfg, { x: 5, y: 64, z: 0 });
    expect(r).toBe("arrived");
    expect(rt.state.keys["key.forward"]).toBe(false);
  });

  it("xz column goal arrives ignoring Y; a radius goal at the floating Y does not", () => {
    const rt = createMockRuntime();
    corridor(rt, 5);
    const floating = { x: 5, y: 70, z: 0 }; // goal Y is 6 blocks up in the air (stale start-Y)

    // A radius goal (GoalNear) never fires — the Y gap keeps it > tolerance and the floating
    // cell is unreachable, so greedy does NOT arrive (here: blocked, the old baritone-fallback path).
    rt.setPos({ x: 5.5, y: 64, z: 0.5 }); // standing ON the column
    expect(greedyStep(rt, cfg, floating)).not.toBe("arrived");
    // A column goal (GoalXZ) ignores Y → arrived once the feet cell IS the column (the DESCEND then
    // owns digging down). Exact-column arrival (not a 2.5 radius) so we descend the RIGHT column.
    rt.setPos({ x: 5.5, y: 64, z: 0.5 });
    expect(greedyStep(rt, cfg, floating, { column: true, bestEffort: true })).toBe("arrived");
  });

  it("honors a tightened arrival tolerance (exact-block landing)", () => {
    const rt = createMockRuntime();
    corridor(rt, 5);
    rt.setPos({ x: 4.5, y: 64, z: 0.5 }); // 0.5 from target

    // default tolerance (2.5) would call this arrived…
    expect(greedyStep(rt, cfg, { x: 5, y: 64, z: 0 })).toBe("arrived");
    // …but a tight 0.3 keeps walking until it's right on the block
    rt.setPos({ x: 4.5, y: 64, z: 0.5 });
    expect(greedyStep(rt, cfg, { x: 5, y: 64, z: 0 }, { arrivalRadius: 0.3 })).toBe("moving");
  });

  it("micro-walks (not blocked) when standing in the goal cell but a tight arrival isn't met", () => {
    const rt = createMockRuntime();
    corridor(rt, 5);
    rt.setPos({ x: 5.0, y: 64, z: 0.5 }); // feet in goal cell x=5, but 0.5 from the target point

    // tight 0.3 tolerance: not yet "arrived" AND the planner has feet==goal (no next step) —
    // must keep walking toward the point, not block on the doorstep.
    const r = greedyStep(rt, cfg, { x: 5, y: 64, z: 0 }, { arrivalRadius: 0.3 });
    expect(r).toBe("moving");
    expect(rt.state.keys["key.forward"]).toBe(true);
    expect(rt.state.keys["key.sprint"]).toBe(false); // final settle is always a walk
  });

  it("blocks (no escalation push-through) when the goal is unreachable", () => {
    const rt = createMockRuntime();
    corridor(rt, 2); // floor ends at x=2; goal at x=5 is unreachable
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });

    const r = greedyStep(rt, cfg, { x: 5, y: 64, z: 0 });
    expect(r).toBe("blocked_no_path");
    expect(rt.state.keys["key.forward"]).toBe(false);
  });

  it("VETOES a step the stale plan calls safe but the live world turned to lava", () => {
    const rt = createMockRuntime();
    corridor(rt, 5);
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });

    // tick 1: caches the corridor (incl. the next cell) as air, and moves.
    expect(greedyStep(rt, cfg, { x: 5, y: 64, z: 0 })).toBe("moving");

    // lava flows into the immediate next cell — the plan (cached air) still routes through it,
    // but the live veto must catch it. Same tick so the cache stays fresh (TTL not elapsed).
    rt.setBlock(1, 64, 0, "minecraft:lava");
    const r = greedyStep(rt, cfg, { x: 5, y: 64, z: 0 });
    expect(r).toBe("blocked_hazard");
    expect(rt.state.keys["key.forward"]).toBe(false);
  });

  it("VETOES a parkour landing the live world turned into a void (mined-away floor)", () => {
    const rt = createMockRuntime();
    rt.setBlock(0, 63, 0, "minecraft:stone"); // take-off
    rt.setBlock(3, 63, 0, "minecraft:stone"); // landing floor — cached as standable
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    const pcfg = makeGerdaConfig({ nav: { parkour: true, parkourMaxGap: 3, sprint: true } });

    // tick 1: plan caches x=3 as a standable landing and starts the sprint-jump.
    expect(greedyStep(rt, pcfg, { x: 3, y: 64, z: 0 })).toBe("moving");

    // the landing floor vanishes (now a bottomless void) — the cached plan still routes onto x=3,
    // but the live void veto must catch it before we jump in. Same tick → cache stays fresh.
    rt.setBlock(3, 63, 0, "minecraft:air");
    const r = greedyStep(rt, pcfg, { x: 3, y: 64, z: 0 });
    expect(r).toBe("blocked_hazard");
    expect(rt.state.keys["key.forward"]).toBe(false);
  });

  it("REFUSES to walk into over-the-head water (the flooded-ravine drown trap)", () => {
    const rt = createMockRuntime();
    corridor(rt, 5);
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });

    // tick 1: caches the corridor as air/stone and moves.
    expect(greedyStep(rt, cfg, { x: 5, y: 64, z: 0 })).toBe("moving");

    // the only next cell floods head-deep (feet + head both water). Water is a plan-obstacle AND the
    // live submergesAt veto refuses it — either way the bot must NOT step in (it would drown). In a
    // 1-wide corridor with no detour that surfaces as blocked_no_path; the key point is it's blocked.
    rt.setBlock(1, 64, 0, "minecraft:water"); // feet
    rt.setBlock(1, 65, 0, "minecraft:water"); // head
    const r = greedyStep(rt, cfg, { x: 5, y: 64, z: 0 });
    expect(isBlocked(r)).toBe(true);
    expect(rt.state.keys["key.forward"]).toBe(false);
  });
});

// PLAN_STALE policy replan (planner-emitted move policy) — the executor dispatches on the planner's move POLICY, not on
// re-derived geometry. When a driver's LIVE precondition contradicts the committed policy (a parkour
// take-off refused, a ladder that vanished under a cached climb), the executor does NOT silently swap
// to a different driver: it returns PLAN_STALE, invalidates the route, and REPLANS from live truth in
// the same tick. These prove both halves: the divergence resolves to a fresh plan (plans bump), and it
// resolves to the CORRECT alternative (bridge / pillar), never a phantom drive of the stale policy.
describe("greedyStep PLAN_STALE policy replan", () => {
  beforeEach(() => resetGreedyNav());

  it("a refused parkour take-off REPLANS within the tick (typed replan, not a silent swap)", () => {
    const rt = createMockRuntime();
    rt.setBlock(0, 63, 0, "minecraft:stone"); // take-off only — no ground behind → no run-up
    rt.setBlock(4, 63, 0, "minecraft:stone"); // dist-4 landing
    rt.state.slots.set(HOTBAR, { id: "minecraft:cobblestone", count: 64, durabilityPct: 100 });
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    const pcfg = makeGerdaConfig({ nav: { parkour: true, parkourMaxGap: 3, bridge: true } });

    const r = greedyStep(rt, pcfg, { x: 4, y: 64, z: 0 });
    // The cold plan offered a parkour; initParkourRun REFUSED it (no run-up) → the executor returned
    // PLAN_STALE → invalidateRoute + an immediate replan (parkour now latched off → a bridge). TWO plans
    // ran in this ONE tick — proof the divergence resolved through a typed replan, not an inline swap.
    expect(navRouteSnapshot().plans).toBeGreaterThanOrEqual(2);
    expect(r).toBe("moving"); // crossing by bridge, safely
    expect(rt.state.keys["key.jump"]).toBe(false); // never launched off the lip
    expect(parkourSnapshot().active).toBe(false);
  });

  it("a ladderUp whose ladder VANISHED replans to a pillar for the SAME cell (no phantom climb)", () => {
    const rt = createMockRuntime();
    // A 2-rung ladder against a wall over a stone base, filler carried. The cold plan climbs the ladder
    // (a ladderUp is cheaper than a pillarUp for the same +1 cell), so the route caches a ladderUp policy.
    rt.setBlock(0, 63, 0, "minecraft:stone"); // base under the column (a pillar can climb off it)
    rt.setBlock(0, 64, 0, "minecraft:ladder"); // feet rung (climbable)
    rt.setBlock(1, 64, 0, "minecraft:stone"); // backing wall → ladder facing
    rt.setBlock(0, 65, 0, "minecraft:ladder"); // rung above → the ladderUp target (= the goal cell)
    rt.setBlock(1, 65, 0, "minecraft:stone");
    rt.setBlock(0, 66, 0, "minecraft:air"); // head clearance (ladder top-out AND pillar head)
    rt.state.slots.set(HOTBAR, { id: "minecraft:cobblestone", count: 64, durabilityPct: 100 });
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    const lpcfg = makeGerdaConfig({ nav: { ladder: true, pillar: true } });
    const goal = { x: 0, y: 65, z: 0 };

    // tick 1: cold plan routes a ladderUp to (0,65,0) and drives the climb — the cache now holds it.
    expect(greedyStep(rt, lpcfg, goal, { arrivalRadius: 0.5 })).toBe("moving");
    const plansAfter1 = navRouteSnapshot().plans;

    // BOTH ladder rungs are mined away. (0,65,0) stays REACHABLE — a pillarUp spans it — so the route's
    // cheap edge-check passes and the STALE ladderUp policy survives into dispatch, where climbableAt now
    // fails at both the target and the feet → PLAN_STALE → invalidateRoute → replan → a pillarUp instead.
    rt.setBlock(0, 64, 0, "minecraft:air"); // feet rung gone (bot now rests on the stone base)
    rt.setBlock(0, 65, 0, "minecraft:air"); // target rung gone
    const r = greedyStep(rt, lpcfg, goal, { arrivalRadius: 0.5 });
    expect(r).toBe("moving"); // did NOT silently drive a phantom ladder (that would climb into air)
    expect(navRouteSnapshot().plans).toBeGreaterThan(plansAfter1); // the divergence forced a fresh plan
  });
});

describe("greedyStep pillar-up", () => {
  beforeEach(() => resetGreedyNav());

  /** A clear sheer column at x=z=0: stone floor at 63, air 64..70 — only a pillar climbs it. */
  function column(rt: MockRuntime): void {
    rt.setBlock(0, 63, 0, "minecraft:stone");
    for (let y = 64; y <= 70; y++) rt.setBlock(0, y, 0, "minecraft:air");
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
  }

  it("drives a jump-place cycle toward a sheer overhead goal when filler is carried", () => {
    const rt = createMockRuntime();
    column(rt);
    rt.state.slots.set(HOTBAR, { id: "minecraft:cobblestone", count: 64, durabilityPct: 100 });
    const pcfg = makeGerdaConfig({ nav: { pillar: true } });
    const tgt = { x: 0, y: 67, z: 0 }; // 3 straight up — beyond a tight arrival radius

    // CENTER (already on the column centre) → JUMP (baseY captured), no jump key yet this tick
    expect(greedyStep(rt, pcfg, tgt, { arrivalRadius: 0.5 })).toBe("moving");
    // JUMP: grounded → press jump → PLACE
    greedyStep(rt, pcfg, tgt, { arrivalRadius: 0.5 });
    expect(rt.state.keys["key.jump"]).toBe(true);

    // rising (vy > 0): the apex gate holds the place even though the feet cleared the cell
    rt.state.onGround = false;
    rt.state.velocity = { x: 0, y: 0.2, z: 0 };
    rt.setPos({ x: 0.5, y: 65.2, z: 0.5 });
    greedyStep(rt, pcfg, tgt, { arrivalRadius: 0.5 });
    expect(rt.state.blocks.get(encodePos(0, 64, 0))).toBe("minecraft:air"); // not placed mid-rise

    // at the apex (vy ≤ 0): the filler lands under the original feet (placed on the 63-block's top)
    rt.state.velocity = { x: 0, y: -0.05, z: 0 };
    greedyStep(rt, pcfg, tgt, { arrivalRadius: 0.5 });
    expect(rt.state.blocks.get(encodePos(0, 64, 0))).toBe("minecraft:cobblestone");
  });

  it("blocks when a pillar is the only way up but the bag has no filler", () => {
    const rt = createMockRuntime();
    column(rt); // no filler set
    const pcfg = makeGerdaConfig({ nav: { pillar: true } });
    const r = greedyStep(rt, pcfg, { x: 0, y: 67, z: 0 }, { arrivalRadius: 0.5 });
    expect(r).toBe("blocked_no_path"); // canPillar false → planner offers no rise → no route up
  });
});

describe("greedyStep mine-drive", () => {
  beforeEach(() => resetGreedyNav());

  const mcfg = makeGerdaConfig({ nav: { mine: true } });

  /** Floor at y63 for x in [0..len], plus a 3-tall solid wall at x=1 (the only blocker). 3-tall, not
   *  1, so TUNNELING (mineTraverse, 2 breaks) is cheaper than climbing over it (mineAscend would also
   *  break the head above the wall) — the planner picks the straight-ahead dig the test asserts. */
  function walledCorridor(rt: MockRuntime, len: number): void {
    for (let x = 0; x <= len; x++) rt.setBlock(x, 63, 0, "minecraft:stone");
    for (let y = 64; y <= 66; y++) rt.setBlock(1, y, 0, "minecraft:stone");
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
  }

  it("breaks a solid block in the path instead of blocking, when cfg.nav.mine is on", () => {
    const rt = createMockRuntime();
    walledCorridor(rt, 3);

    const r = greedyStep(rt, mcfg, { x: 3, y: 64, z: 0 });
    expect(r).toBe("moving");
    expect(rt.state.keys["key.forward"]).toBe(false); // stands still to break, never walks into the wall
    expect(rt.state.mineTarget).toEqual({ x: 1, y: 64, z: 0 }); // aims the shared breaker at the wall feet
  });

  it("does not mine the wall when cfg.nav.mine is off (the gate) — blocks exactly as before", () => {
    const rt = createMockRuntime();
    walledCorridor(rt, 3);
    // cfg.nav.mine off → the wall is impassable, no mine-move, no route → blocked (the gate holds)
    const offCfg = makeGerdaConfig({ nav: { mine: false } });
    expect(greedyStep(rt, offCfg, { x: 3, y: 64, z: 0 })).toBe("blocked_no_path");
  });

  it("advances to the head cell once the feet cell is broken", () => {
    const rt = createMockRuntime();
    walledCorridor(rt, 3);
    const tgt = { x: 3, y: 64, z: 0 };

    greedyStep(rt, mcfg, tgt); // AIM the feet cell
    rt.state.tick = 6;
    greedyStep(rt, mcfg, tgt); // AIM → BREAK (past cfg.nav.mineAimTicks)
    rt.state.tick = 7;
    greedyStep(rt, mcfg, tgt); // issues breakAsync
    rt.flushBreak(); // resolve it → feet cell becomes air
    expect(rt.state.blocks.get(encodePos(1, 64, 0))).toBe("minecraft:air");

    rt.state.tick = 8;
    greedyStep(rt, mcfg, tgt); // feet clear → the head is now the blocker
    expect(rt.state.mineTarget).toEqual({ x: 1, y: 65, z: 0 });
  });

  it("walks normally when cfg.nav.mine is on but nothing is in the way (empty break set)", () => {
    const rt = createMockRuntime();
    corridor(rt, 3); // clear floor, no wall
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });

    const r = greedyStep(rt, mcfg, { x: 3, y: 64, z: 0 });
    expect(r).toBe("moving");
    expect(rt.state.keys["key.forward"]).toBe(true); // open path → the walk driver, not the breaker
  });
});

describe("greedyStep bridge-drive", () => {
  beforeEach(() => resetGreedyNav());

  const bcfg = makeGerdaConfig({ nav: { bridge: true } });

  /** A WIDE void (x=1..4, 4 cells) too wide to parkour: floor at x=0 (start) and a long landing
   *  x=5..10, nothing between. Forces a bridge chain; the far goal (x=9) is well beyond arrival. */
  function gappedCorridor(rt: MockRuntime): void {
    rt.setBlock(0, 63, 0, "minecraft:stone");
    for (let x = 5; x <= 10; x++) rt.setBlock(x, 63, 0, "minecraft:stone");
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
  }
  const GOAL = { x: 9, y: 64, z: 0 };

  it("lays a floor block under the gap (standing still) when filler is carried", () => {
    const rt = createMockRuntime();
    gappedCorridor(rt);
    rt.state.slots.set(HOTBAR, { id: "minecraft:cobblestone", count: 64, durabilityPct: 100 });

    const r = greedyStep(rt, bcfg, GOAL);
    expect(r).toBe("moving");
    expect(rt.state.keys["key.forward"]).toBe(false); // placing, not walking into the gap
    expect(rt.state.keys["key.sprint"]).toBe(false); // never sprint while bridging
    // placeBlock landed against the floor under the feet: the void floor cell (1,63,0) is now filler
    expect(rt.state.blocks.get(encodePos(1, 63, 0))).toBe("minecraft:cobblestone");
  });

  it("blocks (no filler) when bridging is the only route and the bag is empty", () => {
    const rt = createMockRuntime();
    gappedCorridor(rt); // no filler → canBridge false → planner offers no crossing → no route
    expect(greedyStep(rt, bcfg, GOAL)).toBe("blocked_no_path");
  });

  it("does not bridge when cfg.nav.bridge is off (the gate) — the gap is uncrossable", () => {
    const rt = createMockRuntime();
    gappedCorridor(rt);
    rt.state.slots.set(HOTBAR, { id: "minecraft:cobblestone", count: 64, durabilityPct: 100 });
    // cfg.nav.bridge OFF → no bridge-move, no parkour → the void blocks (even with filler in the bag)
    const offCfg = makeGerdaConfig({ nav: { bridge: false } });
    expect(greedyStep(rt, offCfg, GOAL)).toBe("blocked_no_path");
  });

  it("LOW-FILLER guard: below cfg.nav.fillerMin it won't START a bridge (no mid-void strand)", () => {
    const rt = createMockRuntime();
    gappedCorridor(rt);
    // Only 2 filler in the bag, below cfg.nav.fillerMin(4): the 4-cell gap needs more than the bag can
    // finish, so the planner must NOT begin a place-chain it can't complete (which would leave the bot
    // stranded on a stub over the void). It blocks → the navigation layer escalates instead.
    const lowCfg = makeGerdaConfig({ nav: { bridge: true, fillerMin: 4 } });
    rt.state.slots.set(HOTBAR, { id: "minecraft:cobblestone", count: 2, durabilityPct: 100 });
    expect(greedyStep(rt, lowCfg, GOAL)).toBe("blocked_no_path");
    // …and with enough filler (≥ cfg.nav.fillerMin) the SAME gap bridges (gate is the count, not >0).
    resetGreedyNav();
    rt.state.slots.set(HOTBAR, { id: "minecraft:cobblestone", count: 8, durabilityPct: 100 });
    expect(greedyStep(rt, lowCfg, GOAL)).toBe("moving");
    expect(rt.state.blocks.get(encodePos(1, 63, 0))).toBe("minecraft:cobblestone");
  });

  it("walks normally once the floor is present (no gap → the walk driver)", () => {
    const rt = createMockRuntime();
    gappedCorridor(rt);
    rt.setBlock(1, 63, 0, "minecraft:stone"); // gap already filled → nothing to place
    rt.state.slots.set(HOTBAR, { id: "minecraft:cobblestone", count: 64, durabilityPct: 100 });

    const r = greedyStep(rt, bcfg, GOAL);
    expect(r).toBe("moving");
    expect(rt.state.keys["key.forward"]).toBe(true); // floor present → walk, not place
    // …but x=1 is a bridge tip (x=2 still a void within 2 cells) → no sprint, so momentum can't
    // carry us off the short bridge before the next floor cell is laid.
    expect(rt.state.keys["key.sprint"]).toBe(false);
  });

  it("does NOT sprint onto a short bridge tip (2-cell runway gate)", () => {
    const rt = createMockRuntime();
    gappedCorridor(rt);
    rt.setBlock(1, 63, 0, "minecraft:stone"); // x=1 floored, but x=2..4 still void
    rt.setBlock(2, 63, 0, "minecraft:stone"); // x=2 floored too — one-cell runway looks "clear"…
    rt.state.slots.set(HOTBAR, { id: "minecraft:cobblestone", count: 64, durabilityPct: 100 });

    const r = greedyStep(rt, bcfg, GOAL);
    expect(r).toBe("moving");
    // walking onto x=1: cell+1 (x=2) is floored but cell+2 (x=3) is a void → deeper runway gate
    // suppresses sprint, keeping the bot at walk speed where place-then-step keeps up.
    expect(rt.state.keys["key.sprint"]).toBe(false);
  });

  it("DOES sprint on a long clear runway (2 cells ahead floored)", () => {
    const rt = createMockRuntime();
    corridor(rt, 8); // solid floor all the way → deep runway clear
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    rt.state.slots.set(HOTBAR, { id: "minecraft:cobblestone", count: 64, durabilityPct: 100 });

    const scfg = makeGerdaConfig({ nav: { bridge: true, sprint: true } }); // sprint opt-in (default off)
    const r = greedyStep(rt, scfg, { x: 7, y: 64, z: 0 });
    expect(r).toBe("moving");
    expect(rt.state.keys["key.sprint"]).toBe(true); // open runway → sprint
  });
});

// SURFACE-DESCENT BRIDGE NO-SUPPORT: on a snowy/sprinted descent the planner can offer a
// same-level bridgePlace from a cell whose floor the reader reports non-standable — snow is
// passable-not-standable in our model, and mid-fall the floating `feet` cell reads as void, as can a
// stale world-view cache. Neither is a true "can't bridge": AIRBORNE we ride the fall out (return
// "moving"), ON THE GROUND we're perched on a real surface the reader can't classify and defer to the
// walk driver (return null). The driver must never emit a spurious blocked_no_path here — that was the
// deterministic greedy_drive surface-descent block, root-caused in-game to bridge.nosupport while
// sprint-falling through a snow valley at x207 (onGround flickers false across the drop).
describe("driveBridgeStep surface-descent no-support", () => {
  beforeEach(() => resetGreedyNav());
  const bcfg = makeGerdaConfig({ nav: { bridge: true } });

  // feet (2,5,0): floor (2,4,0) is SNOW (passable-but-not-standable) → the reader sees "no support under
  // our feet" though the bot rests ON / falls past it. next (3,5,0) is open with an open floor (3,4,0)
  // too, so the driver clears its floor-present early return and reaches the support check (under test).
  function perched(rt: MockRuntime): { feet: Vec3; next: Vec3 } {
    rt.setBlock(2, 4, 0, "minecraft:snow");
    rt.setPos({ x: 2.5, y: 5, z: 0.5 });
    return { feet: { x: 2, y: 5, z: 0 }, next: { x: 3, y: 5, z: 0 } };
  }

  it("airborne (mid sprint-descent) → HOLDS the heading (moving), never the false block", () => {
    const rt = createMockRuntime();
    const { feet, next } = perched(rt);
    rt.state.onGround = false; // a transient floating feet cell sampled mid-fall — ride it out
    expect(driveBridgeStep(rt, bcfg, feet, next)).toBe("moving");
    expect(navRouteSnapshot().lastBlock).toBe(""); // no block recorded — held through the fall
  });

  it("onGround perched on snow → falls through to the walk driver (null), never blocks", () => {
    const rt = createMockRuntime();
    const { feet, next } = perched(rt);
    rt.state.onGround = true; // physically supported by the snow the reader can't classify as a surface
    expect(driveBridgeStep(rt, bcfg, feet, next)).toBeNull();
    expect(navRouteSnapshot().lastBlock).toBe(""); // no block recorded — we deferred to the walk driver
  });
});

// Commit-to-choice (anti-oscillation): once the executor commits to a `next` cell it keeps driving
// toward it even when a fresh plan would route elsewhere (an equal-cost flip / a backward step from a
// supported ledge edge), as long as the cell stays walkable + strictly closer to the goal.
describe("greedyStep commit-to-choice", () => {
  beforeEach(() => resetGreedyNav());
  const noMine = makeGerdaConfig({ nav: { mine: false } }); // isolate the walk driver from mine-down

  /** A 1-wide drop ledge: feet floor at (0,63,0); column x=1 open down to a floor at (1,60,0), so a
   *  3-block dropDownSafe lands at (1,61,0). The supported-edge cell (1,64) has NO forward route to the
   *  landing — the plan can only go BACKWARD to (0,64) — which is exactly the teeter trap. */
  function dropLedge(rt: MockRuntime): void {
    rt.setBlock(0, 63, 0, "minecraft:stone"); // the ledge the bot stands on
    rt.setBlock(1, 60, 0, "minecraft:stone"); // the shaft floor 3 below, landing = (1,61,0)
  }
  const LANDING = { x: 1, y: 61, z: 0 };

  it("commits to a forward drop landing and faces it (east)", () => {
    const rt = createMockRuntime();
    dropLedge(rt);
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    expect(greedyStep(rt, noMine, LANDING)).toBe("moving");
    expect(rt.state.rotation.yaw).toBeCloseTo(-90, 1); // +X / east, toward the drop column
    expect(rt.state.keys["key.forward"]).toBe(true);
  });

  it("HOLDS the commitment off the supported edge — keeps driving the landing, not routing back", () => {
    const rt = createMockRuntime();
    dropLedge(rt);
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    greedyStep(rt, noMine, LANDING); // tick 1: commit to (1,61), facing east
    // physics nudged the bot into the supported edge cell (feet-cell x=1, still on block-0's lip)
    rt.setPos({ x: 1.05, y: 64, z: 0.5 });
    expect(greedyStep(rt, noMine, LANDING)).toBe("moving"); // tick 2: same goal, commitment stands
    expect(rt.state.rotation.yaw).toBeCloseTo(-90, 1); // STILL east (off the ledge) — not reversed
    expect(rt.state.keys["key.forward"]).toBe(true);
  });

  it("WITHOUT a commitment the same edge cell routes BACKWARD (the teeter it fixes)", () => {
    const rt = createMockRuntime();
    dropLedge(rt);
    rt.setPos({ x: 1.05, y: 64, z: 0.5 }); // start fresh on the edge cell — no prior commitment
    expect(greedyStep(rt, noMine, LANDING)).toBe("moving");
    expect(rt.state.rotation.yaw).toBeCloseTo(90, 1); // -X / WEST — steps back toward (0,64), the flip
  });

  it("RELEASES the commitment on arrival at the committed cell", () => {
    const rt = createMockRuntime();
    rt.setBlock(0, 63, 0, "minecraft:stone");
    for (let x = 1; x <= 4; x++) rt.setBlock(x, 63, 0, "minecraft:stone"); // flat corridor east
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    greedyStep(rt, noMine, { x: 4, y: 64, z: 0 }); // commit to (1,64), facing east
    rt.setPos({ x: 1.5, y: 64, z: 0.5 }); // arrived at the committed cell → recommit to the next step
    expect(greedyStep(rt, noMine, { x: 4, y: 64, z: 0 })).toBe("moving");
    expect(rt.state.rotation.yaw).toBeCloseTo(-90, 1); // still progressing east toward (2,64) — no stall
  });

  it("DROPS a stuck commitment after cfg.nav.commitTimeoutTicks (never wedges)", () => {
    const rt = createMockRuntime();
    const timed = makeGerdaConfig({ nav: { mine: false, commitTimeoutTicks: 3 } });
    dropLedge(rt);
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    greedyStep(rt, timed, LANDING); // commit to (1,61) at tick 0
    rt.setPos({ x: 1.05, y: 64, z: 0.5 }); // stuck on the edge cell
    rt.state.tick = 5; // age the commit past the 3-tick timeout
    greedyStep(rt, timed, LANDING);
    expect(rt.state.rotation.yaw).toBeCloseTo(90, 1); // commitment expired → fresh plan routes back west
  });
});

describe("greedyRelease", () => {
  it("clears the movement keys", () => {
    const rt = createMockRuntime();
    rt.state.keys["key.forward"] = true;
    rt.state.keys["key.jump"] = true;
    rt.state.keys["key.sprint"] = true;
    greedyRelease(rt);
    expect(rt.state.keys["key.forward"]).toBe(false);
    expect(rt.state.keys["key.jump"]).toBe(false);
    expect(rt.state.keys["key.sprint"]).toBe(false);
  });
});

// Incremental replan — the cache that removes the per-tick A* storm behind the surface-traversal gap.
// A full plan ran EVERY tick toward a distant goal = the 5000-node cap per tick (each cold cell a live
// getBlock) → worker-killing read storm. Now the route is planned once and FOLLOWED, replanned only on
// real invalidation. These tests count plans vs follows over a simulated walk (the mock doesn't move the
// bot — we setPos it one cell per tick along the corridor, the production cadence on flat ground).
describe("greedyStep incremental replan (route cache)", () => {
  beforeEach(() => resetGreedyNav());

  it("plans ONCE for a complete route, then follows the cache the rest of the way", () => {
    const rt = createMockRuntime();
    corridor(rt, 20);
    for (let x = 0; x <= 16; x++) {
      rt.state.tick = x;
      rt.setPos({ x: x + 0.5, y: 64, z: 0.5 });
      expect(greedyStep(rt, cfg, { x: 20, y: 64, z: 0 })).toBe("moving");
    }
    const snap = navRouteSnapshot();
    // The single initial plan reaches the goal (complete) → every later tick is a cache follow, NOT a
    // fresh A*. This is the whole fix: O(1) per tick while traversing instead of O(maxExpansions).
    expect(snap.plans).toBe(1);
    expect(snap.follows).toBeGreaterThanOrEqual(14);
  });

  it("forces a replan when the goal changes (a new goalKey can't reuse the cache)", () => {
    const rt = createMockRuntime();
    corridor(rt, 20);
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    rt.state.tick = 0;
    greedyStep(rt, cfg, { x: 10, y: 64, z: 0 }); // plan #1
    rt.state.tick = 1;
    greedyStep(rt, cfg, { x: 10, y: 64, z: 0 }); // same goal, on-path → follow
    expect(navRouteSnapshot().plans).toBe(1);
    rt.state.tick = 2;
    greedyStep(rt, cfg, { x: 18, y: 64, z: 0 }); // DIFFERENT goal → forced replan
    expect(navRouteSnapshot().plans).toBe(2);
  });

  it("forces a replan when the bot drifts off the cached path", () => {
    const rt = createMockRuntime();
    corridor(rt, 20);
    for (let z = -2; z <= 2; z++) rt.setBlock(0, 63, z, "minecraft:stone"); // a standable drift cell
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    rt.state.tick = 0;
    greedyStep(rt, cfg, { x: 12, y: 64, z: 0 }); // plan #1 along z=0
    expect(navRouteSnapshot().plans).toBe(1);
    rt.state.tick = 1;
    rt.setPos({ x: 0.5, y: 64, z: 2.5 }); // teleported OFF the cached path (z=2, not on the route)
    greedyStep(rt, cfg, { x: 12, y: 64, z: 0 });
    expect(navRouteSnapshot().plans).toBe(2); // drift detected → forced replan
  });

  it("horizon-bounds the first plan to a distant goal (a segment, not the full distance)", () => {
    const rt = createMockRuntime();
    corridor(rt, 45);
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    rt.state.tick = 0;
    greedyStep(rt, cfg, { x: 40, y: 64, z: 0 }); // 40 away > cfg.nav.horizonBlocks(24)
    const snap = navRouteSnapshot();
    // The plan aimed at a ~24-block horizon sub-goal, so the cached route is bounded — NOT the full
    // 40-cell path. This keeps the first (cold-cache) plan's reads local (no multi-second worker freeze).
    expect(snap.cachedLen).toBeGreaterThan(20);
    expect(snap.cachedLen).toBeLessThan(30);
  });

  it("reaches a distant goal in segments (extend-replan re-projects the horizon)", () => {
    const rt = createMockRuntime();
    corridor(rt, 45);
    let arrived = false;
    for (let x = 0; x <= 40 && !arrived; x++) {
      rt.state.tick = x * 2; // clear the replan cooldown at the segment seams
      rt.setPos({ x: x + 0.5, y: 64, z: 0.5 });
      arrived = greedyStep(rt, cfg, { x: 40, y: 64, z: 0 }) === "arrived";
    }
    expect(arrived).toBe(true);
    const snap = navRouteSnapshot();
    // A 40-block goal beyond the 24 horizon is reached in ≥2 segments — still ≪ one plan per tick.
    expect(snap.plans).toBeGreaterThanOrEqual(2);
    expect(snap.plans).toBeLessThan(8);
  });

  it("holds the cooldown: a consumed best-effort route does NOT replan every tick", () => {
    const rt = createMockRuntime();
    // A short stub of floor then a void: the goal across the void is unreachable on foot, so the plan
    // is a best-effort partial. Standing at its end, greedy must NOT re-run A* every tick (the storm).
    for (let x = 0; x <= 3; x++) rt.setBlock(x, 63, 0, "minecraft:stone");
    rt.setPos({ x: 3.5, y: 64, z: 0.5 });
    const noReach = makeGerdaConfig({ nav: { bridge: false, parkour: false, mine: false } });
    let plansAfterFirst = 0;
    for (let t = 0; t < 6; t++) {
      rt.state.tick = t;
      greedyStep(rt, noReach, { x: 30, y: 64, z: 0 });
      if (t === 0) plansAfterFirst = navRouteSnapshot().plans;
    }
    // Over 6 consecutive ticks at the strand point, replans are cooldown-gated (cfg.nav.replanTicks=10), so
    // the per-tick 5000-node storm is gone — far fewer than one plan per tick.
    expect(navRouteSnapshot().plans).toBeLessThanOrEqual(2);
    expect(plansAfterFirst).toBe(1);
  });
});

// AIRBORNE-HOLD — the fix for the per-tick surface-descent block (root-caused live: greedyStep
// replans from a mid-fall FLOATING floorVec cell, which intermittently has no route → a SPURIOUS
// blocked_no_path that fires reliably at 20 Hz but not when single-stepped slowly because the bot lands
// between samples). While !onGround the executor must HOLD the committed heading, not block.
describe("greedyStep airborne-hold", () => {
  beforeEach(() => resetGreedyNav());

  it("mid-fall with no route from the floating cell HOLDS (moving), not a spurious block", () => {
    const rt = createMockRuntime();
    // valley floor far below; the bot is sampled MID-FALL at a floating cell whose floorVec has no
    // standable floor under it (drop to the floor exceeds maxDrop), so the planner finds no route FROM
    // the transient cell — exactly the per-tick descent condition that produced blocked_no_path live.
    for (let x = 0; x <= 12; x++) rt.setBlock(x, 50, 0, "minecraft:stone");
    rt.setPos({ x: 5.4, y: 56, z: 0.5 }); // floating ~6 above the floor (> cfg.nav.maxDrop=4)
    rt.state.onGround = false; // FALLING
    rt.state.keys["key.forward"] = true; // asserted by driveWalkStep when we stepped off the ledge

    const r = greedyStep(rt, cfg, { x: 10, y: 51, z: 0 });
    expect(r).toBe("moving"); // held, NOT blocked_no_path
    expect(rt.state.keys["key.forward"]).toBe(true); // heading still held — greedyRelease did NOT run
  });

  it("GROUNDED with no route still blocks — the hold does not mask a real dead end", () => {
    const rt = createMockRuntime();
    // a lone pillar in a void deeper than maxDrop: standing on it, no walkable neighbour, no safe drop.
    rt.setBlock(5, 50, 0, "minecraft:stone");
    rt.setPos({ x: 5.5, y: 51, z: 0.5 }); // standing ON the pillar top
    rt.state.onGround = true; // GROUNDED — the airborne-hold must not engage
    rt.state.keys["key.forward"] = true;

    const r = greedyStep(rt, cfg, { x: 12, y: 51, z: 0 });
    expect(r).toBe("blocked_no_path"); // a real block still surfaces
    expect(rt.state.keys["key.forward"]).toBe(false); // greedyRelease ran
  });
});

// — D* Lite engine (cfg.nav.dStar) ——————————————————————————————————————————————————————————————————
// The incremental replanner behind the SAME greedyStep next-cell contract. Correctness of the search
// itself is proven exhaustively in dstar.property.test.ts (vs the true optimum over 1500 terrains);
// here we prove the INTEGRATION: greedyStep drives with it, it stays incremental (built once, re-rooted
// per tick — not a fresh A* each tick), and it reaches the bounded-move-set terrain A* reaches.
describe("greedyStep — D* Lite engine (cfg.nav.dStar)", () => {
  const dcfg = makeGerdaConfig({ nav: { dStar: true } });
  beforeEach(() => resetGreedyNav());

  it("drives a flat corridor to arrival, built ONCE then re-rooted per tick (plans ≪ follows)", () => {
    const rt = createMockRuntime();
    corridor(rt, 12);
    // Walk the bot cell-by-cell along the corridor (an on-path drive), one greedyStep per cell.
    for (let x = 0; x <= 9; x++) {
      rt.setPos({ x: x + 0.5, y: 64, z: 0.5 });
      expect(greedyStep(rt, dcfg, { x: 12, y: 64, z: 0 })).toBe("moving");
      expect(rt.state.keys["key.forward"]).toBe(true);
    }
    const snap = navRouteSnapshot();
    expect(snap.plans).toBe(1); // the searcher was BUILT once and never rebuilt (no per-tick A*)
    expect(snap.follows).toBeGreaterThanOrEqual(8); // every other tick re-rooted the SAME tree
    // arrival once inside the tolerance
    rt.setPos({ x: 11.6, y: 64, z: 0.5 });
    expect(greedyStep(rt, dcfg, { x: 12, y: 64, z: 0 })).toBe("arrived");
  });

  it("descends a drop without blocking (reaches what A* reaches on the bounded set)", () => {
    const rt = createMockRuntime();
    for (let x = 0; x <= 2; x++) rt.setBlock(x, 63, 0, "minecraft:stone"); // upper floor (stand y64)
    for (let x = 3; x <= 10; x++) rt.setBlock(x, 61, 0, "minecraft:stone"); // a 2-block drop, then flat
    rt.setPos({ x: 1.5, y: 64, z: 0.5 });
    const r = greedyStep(rt, dcfg, { x: 10, y: 62, z: 0 });
    expect(r).toBe("moving"); // NOT blocked — the drop is a bounded move D* Lite plans through
    expect(rt.state.keys["key.forward"]).toBe(true);
  });

  it("climbs a staircase under D* Lite (stepUp is in the bounded set)", () => {
    const rt = createMockRuntime();
    rt.setBlock(0, 63, 0, "minecraft:stone");
    for (let x = 1; x <= 6; x++) rt.setBlock(x, 63 + x, 0, "minecraft:stone"); // staircase, stand y=64+x
    rt.setPos({ x: 0.5, y: 64, z: 0.5 });
    expect(greedyStep(rt, dcfg, { x: 6, y: 70, z: 0 })).toBe("moving");
    expect(rt.state.keys["key.jump"]).toBe(true); // a step-up → jump asserted
  });

  it("blocks on a genuine dead end (a pillar in a too-deep void), like A*", () => {
    const rt = createMockRuntime();
    rt.setBlock(5, 50, 0, "minecraft:stone");
    rt.setPos({ x: 5.5, y: 51, z: 0.5 });
    rt.state.onGround = true;
    rt.state.keys["key.forward"] = true;
    expect(greedyStep(rt, dcfg, { x: 12, y: 51, z: 0 })).toBe("blocked_no_path");
  });
});

describe("horizonSubGoal — elevation-aware horizon projection", () => {
  const RADIUS = 2.5;

  it("a far surface leg projects an elevation-aware GoalNear that penalises a deep descent", () => {
    // Roughly-level leg (start y105, target y103) 56 blocks away — the live valley-dive case. The
    // sub-goal sits on the feet→target line at the interpolated elevation (~104), so the octile+level
    // heuristic must rank a deep-valley cell FAR worse than a near-line cell. A Y-blind GoalXZ would
    // rank them EQUAL (its heuristic ignores Y) — exactly the bug that let the planner dive downhill.
    const feet: Vec3 = { x: 42, y: 105, z: 40 };
    const target: Vec3 = { x: 98, y: 103, z: 40 };
    const g = horizonSubGoal(feet, target, 24, false, RADIUS);

    const onLine: Vec3 = { x: 50, y: 104, z: 40 }; // near the interpolated elevation
    const inValley: Vec3 = { x: 50, y: 58, z: 40 }; // 46 blocks below the line — the dive
    expect(g.heuristic(inValley)).toBeGreaterThan(g.heuristic(onLine) + 30); // level cost punishes it
  });

  it("a column/drill leg keeps a Y-blind GoalXZ (the drill owns Y)", () => {
    const feet: Vec3 = { x: 0, y: 70, z: 0 };
    const target: Vec3 = { x: 40, y: 10, z: 0 }; // far XZ, deep target
    const g = horizonSubGoal(feet, target, 24, true, RADIUS);
    // GoalXZ ignores Y: two cells at the SAME column but wildly different Y are equally good.
    expect(g.heuristic({ x: 12, y: 70, z: 0 })).toBe(g.heuristic({ x: 12, y: 10, z: 0 }));
  });

  it("projects the sub-goal onto the feet→target line at the horizon distance", () => {
    // Straight +x leg: the sub-goal lands ~cfg.nav.horizonBlocks ahead in x, same z, interpolated y.
    const feet: Vec3 = { x: 0, y: 80, z: 0 };
    const target: Vec3 = { x: 100, y: 100, z: 0 }; // +20 over 100 → +0.2/block
    const g = horizonSubGoal(feet, target, 24, false, RADIUS);
    // The exact projected cell is the GoalNear centre: heuristic there is 0 (octile+level both 0).
    expect(g.heuristic({ x: 24, y: 85, z: 0 })).toBeCloseTo(0, 6); // x≈24, y≈80+0.2*24≈85
  });
});
