import { encodePos, sameCell } from "@/core/prim/pos";
import type { Runtime } from "@/core/runtime/Runtime";
import type { Vec3 } from "@/core/runtime/types";
// — Route serving ("plan on cache, act on truth") ———————————————————————————————————————————————
// The layer that answers "what cell do I drive toward this tick?" without re-searching the world
// every tick: one persistent world-view cache, a cached A* route followed cell-by-cell, the
// persistent D* Lite searcher (the two engines share the same next-cell contract), and the
// commit-to-choice hysteresis that stops equal-cost plan flips from oscillating the bot. The
// executor supplies the plan/edge thunks and drives whatever cell comes back; the immediate step
// is still live-vetoed downstream, so nothing cached here can hide a hazard.
import type { Config } from "@/shared/config/schema";
import { DStarLite, type DStarPath, engageable } from "@/shared/domain/dstar";
import type { Goal } from "@/shared/domain/goal";
import { type MoveKind, neighbors } from "@/shared/domain/movement-types";
import type { CostContext, PathKind, PlanResult, PlannerOpts } from "@/shared/domain/planner";
import { smoothPath } from "@/shared/domain/planner";
import type { BlockReader } from "@/shared/domain/senses";
import { walkableAt } from "@/shared/domain/senses";
import { createWorldView } from "@/shared/domain/world-view";
import { type GreedyStep, type NextStep, liveReader } from "@/shared/nav/core";

// One persistent planning cache (plan-on-cache). The step-hazard veto reads the live world
// directly, so a stale cell here can never hide a fresh hazard. Reset on dimension change /
// a fresh mission via resetGreedyNav().
let worldView = createWorldView();

/** The world-view caching reader over the live world — the ONE reader every plan/edge check uses,
 *  so the search and its validity checks see the same cells. */
export function navCachingReader(rt: Runtime, cfg: Config): BlockReader {
  return worldView.cachingReader(liveReader(rt), rt.tick(), cfg.nav.worldViewTtlTicks);
}

// — Commit-to-choice ————————————————————————————————————————————————————————————————————————————
// The planner is pure: an equal-cost tie (two L-orderings to a diagonal goal; the supported-edge cell
// of a 1-wide drop ledge, which only routes BACKWARD) makes path[1] FLIP tick-to-tick, so the bot
// faces one way then the other and oscillates in place. The fix is executor-side hysteresis: once we
// commit to a `next` cell, keep driving it as long as it stays live-walkable AND strictly reduces the
// goal heuristic, ignoring an equal-cost alternative from a fresh plan. A timeout force-drops a stuck
// commit so it can never wedge. Cleared on arrival at the cell or a goal change (resetGreedyNav too).
interface CommitRun {
  next: NextStep | null;
  goalKey: string | null;
  sinceTick: number;
}
const freshCommitRun = (): CommitRun => ({ next: null, goalKey: null, sinceTick: 0 });
let commitRun: CommitRun = freshCommitRun();

/** Reconcile the fresh plan's first step with a standing commitment. Returns the cell+policy to drive
 *  this tick: the committed step when it still holds (live-walkable, strictly closer to the goal, not
 *  yet reached, not timed out), else the fresh `planned` (re-committing to it). `planned` may be
 *  undefined (the plan found no step from here) — a held commitment still drives, which is what carries
 *  the bot off a 1-wide ledge whose top cell has no forward edge. The committed KIND rides along so the
 *  executor dispatches on it (a held commitment is always a SHORT walk/step/drop — see the hypot gate). */
export function commitNext(
  rt: Runtime,
  cfg: Config,
  feet: Vec3,
  goal: Goal,
  goalKey: string,
  planned: NextStep | undefined,
  tick: number,
): NextStep | undefined {
  const prior = commitRun.goalKey === goalKey ? commitRun.next : null;
  const held =
    prior !== null &&
    !sameCell(prior.cell, feet) && // reached it → let the fresh plan lead from here
    // Only a SHORT step (walk / step / drop). A far parkour landing (> cfg.nav.parkourMinCells) has its own
    // run-up latch and MUST follow the fresh plan — holding it here would defeat the parkourGaveUp→bridge fallback.
    Math.hypot(prior.cell.x - feet.x, prior.cell.z - feet.z) <= cfg.nav.parkourMinCells &&
    tick - commitRun.sinceTick <= cfg.nav.commitTimeoutTicks &&
    walkableAt(liveReader(rt), prior.cell) && // act-on-truth: the landing is still real
    goal.heuristic(prior.cell) < goal.heuristic(feet); // still strictly toward the goal, never a detour
  const chosen = held && prior ? prior : planned; // `held` implies prior≠null; the && narrows it
  // (Re)commit whenever the chosen cell changes; keep the same sinceTick while a commitment persists
  // so the timeout measures the WHOLE stuck stretch, not just the last identical tick.
  if (!chosen) {
    commitRun = freshCommitRun();
  } else if (
    commitRun.goalKey !== goalKey ||
    commitRun.next === null ||
    !sameCell(commitRun.next.cell, chosen.cell)
  ) {
    commitRun = { next: chosen, goalKey, sinceTick: tick };
  }
  return chosen;
}

// — Incremental replan ("plan on cache, act on truth") ——————————————————————————————————————————————
// A* is O(maxExpansions); re-running it from `feet` EVERY tick toward a distant/blocked GoalXZ burns
// the full 5000-node cap per tick, each cold cell a live getBlock — the read storm that hitches the
// game and kills the worker (the surface-traversal gap). Instead we cache the planned route and FOLLOW
// it cell-by-cell, replanning only when the route is invalidated or runs low. The immediate step is
// still live-vetoed downstream (driveWalkStep's stepIsHazardous), so a stale cache can't hide a hazard.
interface RouteCache {
  goalKey: string | null;
  path: Vec3[];
  kinds: PathKind[]; // parallel to path — the move policy that arrived at each cell
  planTick: number;
  complete: boolean; // the cached path reaches the goal (vs a best-effort partial that needs extending)
  reached: number; // furthest path index the feet have stood on (route-progress high-water)
}
const freshRouteCache = (): RouteCache => ({
  goalKey: null,
  path: [],
  kinds: [],
  planTick: -1,
  complete: false,
  reached: 0,
});
let routeCache: RouteCache = freshRouteCache();

// — Route progress (goto-approach) ——————————————————————————————————————————————————————————————————
// Cells the feet have advanced ALONG the route being followed. Distance-to-goal is not progress — a
// route round a ravine or lake leads AWAY first — but shortening the planned route is. A*: +k when the
// feet stand on a cached-route cell k indices beyond the furthest they stood on (`reached`); a fresh
// plan starts at the feet (path[0]), so a replan neither credits nor regresses. D*: the searcher
// re-extracts from the feet each tick, so +k when its raw path to the goal is k cells shorter than
// its best since build (creditShorterRoute); before the searcher converges there is no optimal path,
// so each one-step anytime cell credits one cell the FIRST time it is stood on under that searcher
// (creditAnytimeCell). Under one route or searcher, shuffling back and forth never re-earns a cell
// already credited, and a step off the route earns nothing. Known limits, both capped by
// cfg.nav.gotoTimeoutTicks: (1) drifting OFF the A* route forces a replan from there, which re-baselines the
// high-water, so the walk back onto the old line is credited again — a loop of it needs a fresh
// off-route cell every cycle; (2) a PLAN_STALE (invalidateRoute → freshDStarCache; resetRoutes
// likewise) drops the D* searcher together with its `anytimeCredited` set, so an anytime cell
// already credited can earn one more credit per PLAN_STALE cycle.
// Monotonic for the process lifetime: nothing resets it, so a mid-leg resetGreedyNav can never
// strand the watchdog's best-ever value.
let routeAdvanced = 0;
/** Monotonic count of cells advanced along the followed route (the goto-approach signature). */
export function navRouteProgress(): number {
  return routeAdvanced;
}
/** Credit the feet standing on `path[idx]` against the route's high-water `reached`; returns the new
 *  high-water. `idx < 0` (off the route) or a cell at/behind the high-water credits nothing. */
function creditAdvance(idx: number, reached: number): number {
  if (idx <= reached) return reached;
  routeAdvanced += idx - reached;
  return idx;
}

// Counters for the nav-route test/telemetry: how many ticks ran a full plan vs followed the cache.
let navPlans = 0;
let navFollows = 0;
// Diagnostic: which block-return site fired last (set right before every blocked_* return below).
// Surfaced in navRouteSnapshot so nav-probe can log WHERE a deterministic block comes from.
let navLastBlock = "";
export const blk = (site: string, kind: "blocked_no_path" | "blocked_hazard"): GreedyStep => {
  navLastBlock = `${site}:${kind}`;
  return kind;
};
// Diagnostic: the BRANCH greedyStep handed the tick to + the cell it drove toward (the actual
// `next` the drive picked from the cachingReader route — NOT a one-off liveReader probe). Surfaced
// in navRouteSnapshot so nav-probe can log WHY a leg loops: a fixed branch+next that never advances
// is the cached-reader-vs-live-world divergence (e.g. a cold cell read as solid → an expensive mine
// move wins over the real cheap drop/walk). Distinct from navLastBlock (deterministic block sites).
let navLastStep: { branch: string; next: Vec3 | null; feet: Vec3 | null } = {
  branch: "",
  next: null,
  feet: null,
};
// Freshness of navLastStep, for a per-TICK reader (the goto-approach exemption): greedyStep opens a
// call on entry (bumping the epoch, recording the runtime tick) and step() stamps the call it ran in.
// A branch is fresh only when the LAST call stamped it AND that call ran on the tick being asked
// about — so neither a later no-step return in the same tick (hold / airborne / continuation) nor a
// tick with no greedyStep call at all (a guard short-circuited the handler) reuses a stale branch.
let navCallEpoch = 0;
let navCallTick = -1;
let navStepEpoch = -1;
export function beginGreedyCall(tick: number): void {
  navCallEpoch++;
  navCallTick = tick;
}
export const step = (branch: string, feet: Vec3, next: Vec3, ret: GreedyStep): GreedyStep => {
  navLastStep = { branch, feet, next };
  navStepEpoch = navCallEpoch;
  return ret;
};
// Branches that work IN PLACE (break / place / climb) — legitimately no approach gain for many ticks.
const STATIONARY_WORK: ReadonlySet<string> = new Set([
  "mine",
  "mineDown",
  "pillar",
  "ladder",
  "bridge",
]);
/** A greedyStep call ran on runtime tick `tick`. False on a tick a guard or reflex short-circuited
 *  the handler (swim-out holding jump, a hold): greedy owned no part of that tick. */
export function navGreedyCalledOn(tick: number): boolean {
  return navCallTick === tick;
}
/** On runtime tick `tick`, the last greedyStep call ran THIS tick and drove a stationary-work branch.
 *  False on a tick with no greedyStep call, and when that call returned without a step. */
export function navStepIsStationaryWork(tick: number): boolean {
  return (
    navCallTick === tick && navStepEpoch === navCallEpoch && STATIONARY_WORK.has(navLastStep.branch)
  );
}

// — D* Lite incremental route (cfg.nav.dStar) ——————————————————————————————————————————————————————
// A persistent goal-rooted searcher that survives across ticks: built once per leg, re-rooted to the
// moving feet each tick (cheap repair, not a fresh A*), and rebuilt only when the goal changes or the
// LIVE next edge no longer exists under the bot. Parallels routeCache; the rest of greedyStep is
// unchanged because dstarNext returns the same `Vec3 | undefined` next-cell contract as routeNext.
interface DStarCache {
  goalKey: string | null;
  searcher: DStarLite | null;
  pathLen: number; // last extracted path length, surfaced via navRouteSnapshot
  // Route progress. The searcher re-extracts from the feet every tick, so there is no persistent path
  // to index into: progress is the RAW optimal path (feet → goal) getting shorter than it has been
  // since this searcher was built (a re-root onto the next path cell shortens it by one).
  bestLen: number;
  // The one-step anytime route last driven before convergence (no optimal path to measure yet):
  // standing on it next call credits one cell — once per cell per searcher (`anytimeCredited`, keyed
  // by encodePos), so an A↔B shuffle cannot re-earn it every cycle.
  anytimeCell: Vec3 | null;
  anytimeCredited: Set<string>;
}
const freshDStarCache = (): DStarCache => ({
  goalKey: null,
  searcher: null,
  pathLen: 0,
  bestLen: Number.POSITIVE_INFINITY,
  anytimeCell: null,
  anytimeCredited: new Set(),
});
let dstarCache: DStarCache = freshDStarCache();

/** Drop the world-view cache, both route engines' caches, the commit hysteresis and the diag
 *  counters — the route-layer half of resetGreedyNav (dimension change / fresh nav). The monotonic
 *  route-progress count is deliberately kept (see navRouteProgress). */
export function resetRoutes(): void {
  worldView = createWorldView();
  commitRun = freshCommitRun();
  routeCache = freshRouteCache();
  dstarCache = freshDStarCache();
  navPlans = 0;
  navFollows = 0;
  navLastBlock = "";
  navLastStep = { branch: "", next: null, feet: null };
}

/** Invalidate the cached route on a PLAN_STALE: the executor's live precondition contradicted
 *  the planner's policy (a ladder appeared/vanished under the bot, a parkour take-off was refused), so
 *  the cached step is untrustworthy. Drop BOTH engines' caches, the standing commitment (never hold a
 *  stale choice through a divergence), AND the world-view cache — the immediate replan MUST read live
 *  truth (a lagged cache is exactly what produced the contradiction). Counters are preserved (telemetry
 *  spans the whole leg). Narrower than resetRoutes: it keeps the pillar/parkour machines + diag state. */
export function invalidateRoute(): void {
  worldView = createWorldView();
  commitRun = freshCommitRun();
  routeCache = freshRouteCache();
  dstarCache = freshDStarCache();
}

/** Plans vs cache-follows since the last reset — a test/telemetry probe proving the per-tick A* storm
 *  is gone (plans ≪ follows on a clean traversal). `dstarConverged`: whether the live D* searcher has
 *  converged (null = no searcher installed), so a pre-convergence fixture can prove it stayed so. */
export function navRouteSnapshot(): {
  plans: number;
  follows: number;
  cachedLen: number;
  lastBlock: string;
  lastStep: { branch: string; next: Vec3 | null; feet: Vec3 | null };
  dstarConverged: boolean | null;
} {
  return {
    plans: navPlans,
    follows: navFollows,
    cachedLen: dstarCache.searcher ? dstarCache.pathLen : routeCache.path.length,
    lastBlock: navLastBlock,
    lastStep: navLastStep,
    dstarConverged: dstarCache.searcher ? dstarCache.searcher.converged() : null,
  };
}

/** The next cell to drive toward, served from the cached route when valid, else from a fresh plan.
 *  `replan` runs a full A*; `edgeValid` does a cheap single-cell neighbor check (NOT a search) to
 *  confirm the cached step still exists under the live world — both are thunks so the expensive search
 *  fires ONLY on a real replan. Returns undefined when the route is consumed mid-cooldown (commitNext
 *  then holds / micro-walks). */
export function routeNext(
  rt: Runtime,
  cfg: Config,
  feet: Vec3,
  goal: Goal,
  goalKey: string,
  plan: { replan: () => PlanResult | null; edgeValid: (from: Vec3, to: Vec3) => boolean },
): NextStep | undefined {
  const tick = rt.tick();
  const onGoal = routeCache.goalKey === goalKey;
  const idx = onGoal ? routeCache.path.findIndex((c) => sameCell(c, feet)) : -1;
  routeCache.reached = creditAdvance(idx, routeCache.reached);
  const aheadOk = idx >= 0 && idx + 1 < routeCache.path.length;
  const nextStep = aheadOk ? cachedStepAt(idx + 1) : undefined;
  const nextCell = nextStep?.cell;

  // FORCED replan (bypasses the cooldown): a new goal, the bot drifted off the cached path, or the
  // cached next edge no longer exists (terrain changed under us). The edge check is mine/bridge/pillar
  // aware — it accepts a planned solid/void next those moves act on, so it only fires on a REAL change.
  const drifted = onGoal && idx < 0 && routeCache.path.length > 0;
  const nextStale = nextCell !== undefined && !plan.edgeValid(feet, nextCell);
  const forced = !onGoal || drifted || nextStale;

  // VOLUNTARY extend-replan: a best-effort (incomplete) route running within `cfg.nav.replanLookahead` cells
  // of its end — but only after the cooldown, so a genuinely blocked goal escalates instead of spinning.
  const remaining = idx >= 0 ? routeCache.path.length - 1 - idx : 0;
  const cooled = tick - routeCache.planTick >= cfg.nav.replanTicks;
  const lowAndReady =
    aheadOk && !routeCache.complete && remaining <= cfg.nav.replanLookahead && cooled;
  // CONSUMED a partial route: the cache ran dry short of the goal — replan to push further, cooldown-gated.
  const consumedPartial = onGoal && !aheadOk && !routeCache.complete && cooled;

  if (forced || lowAndReady || consumedPartial) {
    const result = plan.replan();
    navPlans++;
    const last = result && result.path.length > 0 ? result.path[result.path.length - 1] : undefined;
    routeCache = {
      goalKey,
      path: result?.path ?? [],
      kinds: result?.kinds ?? [],
      planTick: tick,
      complete: last !== undefined && goal.isInGoal(last),
      reached: 0, // planned from the feet: path[0] is where they stand
    };
    if (!result || result.path.length < 2) return undefined;
    const cell = result.path[1];
    return cell ? { cell, kind: kindOf(result.kinds, 1) } : undefined;
  }
  navFollows++;
  return nextStep; // may be undefined (consumed, in cooldown) → commitNext holds the prior commitment
}

/** The cached route's step at index `i` (cell + its move policy) — parallel-array read. */
function cachedStepAt(i: number): NextStep | undefined {
  const cell = routeCache.path[i];
  if (!cell) return undefined;
  return { cell, kind: kindOf(routeCache.kinds, i) };
}

/** The MoveKind at index `i` of a parallel kinds array, defaulting to `traverse` for a missing/`"start"`
 *  entry (a next-step is never the start cell, so this default is a defensive floor, not a real case). */
function kindOf(kinds: PathKind[], i: number): MoveKind {
  const k = kinds[i];
  return k && k !== "start" ? k : "traverse";
}

/** The next cell from the persistent D* Lite searcher (cfg.nav.dStar). Same return contract as
 *  routeNext (next cell, or undefined when blocked → commitNext holds / greedyStep escalates). Builds
 *  the searcher on a goal change or when the live next-edge went stale, else re-roots it to `feet` (a
 *  cheap repair) and re-extracts. Roots at the REAL goal cell (no horizon bound — D* Lite's reason for
 *  being is a cheap whole-traverse-ahead). Parkour is disabled in its move set: a parkour predecessor
 *  spans `maxParkour` cells, blowing up the reverse-enumeration box; the bounded walk/step/drop/diagonal
 *  set keeps predecessors local. Caller guarantees engageable(planOpts) (no filler/mine moves). */
export function dstarNext(
  rt: Runtime,
  cfg: Config,
  feet: Vec3,
  goalCell: Vec3,
  goalKey: string,
  planOpts: PlannerOpts,
  cost: CostContext,
): NextStep | undefined {
  const freshReader = (): BlockReader => navCachingReader(rt, cfg);
  const dstarOpts: PlannerOpts = { ...planOpts, parkour: false };
  const anytimeCell = dstarCache.goalKey === goalKey ? dstarCache.anytimeCell : null;
  if (anytimeCell && sameCell(anytimeCell, feet)) creditAnytimeCell(anytimeCell);
  dstarCache.anytimeCell = null;

  // The cached next edge must still exist under the LIVE world; if the bot is off the tree or the
  // edge changed, rebuild (bounds staleness from the searcher's build-time reader snapshot).
  const sameGoal = dstarCache.goalKey === goalKey && dstarCache.searcher !== null;
  if (sameGoal && dstarCache.searcher) {
    dstarCache.searcher.setStart(feet);
    navFollows++;
  } else {
    if (!engageable(dstarOpts)) return undefined;
    buildDStarCache(rt, cfg, feet, goalCell, goalKey, dstarOpts, cost);
  }
  const searcher = dstarCache.searcher;
  if (!searcher) return undefined;

  const raw: DStarPath | null = searcher.extractPath();
  if (!raw || raw.path.length < 2) {
    dstarCache.pathLen = raw ? raw.path.length : 0;
    const reactive = anytimeStep(searcher, freshReader, feet, dstarOpts);
    dstarCache.anytimeCell = reactive?.cell ?? null;
    return reactive;
  }
  creditShorterRoute(raw.path.length);
  const smoothed = smoothedPath(cfg, freshReader(), raw);
  dstarCache.pathLen = smoothed.path.length;
  const next = smoothed.path[1];
  // Liveness: if the chosen next edge no longer exists live (terrain shifted under the snapshot),
  // rebuild ONCE this tick so we never drive a stale step (the per-step hazard veto still guards).
  if (next && !edgeLive(freshReader(), feet, dstarOpts, next)) {
    return rebuiltFirstStep(rt, cfg, feet, goalCell, goalKey, dstarOpts, cost);
  }
  return next ? { cell: next, kind: kindOf(smoothed.kinds, 1) } : undefined;
}

/** Build a fresh D* Lite searcher for `goalCell` and INSTALL it as the module's cache (counting a
 *  plan). The single construction site for the cache, so a build and a mid-tick rebuild can never
 *  drift apart in reader freshness or step budget. */
function buildDStarCache(
  rt: Runtime,
  cfg: Config,
  feet: Vec3,
  goalCell: Vec3,
  goalKey: string,
  dstarOpts: PlannerOpts,
  cost: CostContext,
): DStarLite | null {
  dstarCache = {
    goalKey,
    searcher: new DStarLite(
      navCachingReader(rt, cfg),
      feet,
      goalCell,
      dstarOpts,
      cost,
      cfg.nav.dStarStepPops,
    ),
    pathLen: 0,
    bestLen: Number.POSITIVE_INFINITY,
    anytimeCell: null,
    anytimeCredited: new Set(),
  };
  navPlans++;
  return dstarCache.searcher;
}

/** D* route progress: credit the raw optimal path to the goal (`len` cells) for every cell it is
 *  shorter than the best since the searcher was built. The first extraction only sets the baseline. */
function creditShorterRoute(len: number): void {
  if (len >= dstarCache.bestLen) return;
  if (Number.isFinite(dstarCache.bestLen)) routeAdvanced += dstarCache.bestLen - len;
  dstarCache.bestLen = len;
}

/** D* anytime progress: the feet stand on the one-step anytime cell driven last call. Credit one
 *  cell, but only the first time that cell is reached under the current searcher: pre-convergence
 *  the anytime step is reactive, so a shuffle re-targets the same two cells every cycle. */
function creditAnytimeCell(cell: Vec3): void {
  const key = encodePos(cell.x, cell.y, cell.z);
  if (dstarCache.anytimeCredited.has(key)) return;
  dstarCache.anytimeCredited.add(key);
  routeAdvanced++;
}

/** Decides what to drive when the searcher yielded NO usable path. Anytime: a budgeted
 *  search may not have reached the start yet. If it hasn't CONVERGED it's still computing — don't
 *  stall the bot; take a reactive best-effort step toward the goal so it walks WHILE the optimal tree
 *  finishes (this is the fix for the ~9 s cold freeze). Only a CONVERGED search with no path means
 *  the goal is genuinely unreachable → undefined, so commitNext holds and greedyStep escalates. */
function anytimeStep(
  searcher: DStarLite,
  freshReader: () => BlockReader,
  feet: Vec3,
  dstarOpts: PlannerOpts,
): NextStep | undefined {
  if (searcher.converged()) return undefined;
  // A reactive one-step fallback: resolve its policy from the matching live neighbor move (the
  // bounded D* set is walk/step/drop/diagonal/ladder — never mine/bridge/pillar).
  const step = searcher.bestEffortStep();
  if (!step) return undefined;
  const move = neighbors(freshReader(), feet, dstarOpts).find((m) => sameCell(m.to, step));
  return move ? { cell: step, kind: move.kind } : undefined;
}

/** The extracted path as the executor should follow it — smoothed when cfg.nav.smoothPath, else raw.
 *  Only the cells + their parallel move policies are carried; the D* cost is spent by this point. */
function smoothedPath(
  cfg: Config,
  reader: BlockReader,
  raw: DStarPath,
): { path: Vec3[]; kinds: PathKind[] } {
  return cfg.nav.smoothPath ? smoothPath(reader, raw.path, raw.kinds) : raw;
}

/** Does the move `next` still exist as a live neighbor of `feet` — i.e. is the planned edge real
 *  under the CURRENT world rather than the searcher's build-time snapshot? */
function edgeLive(reader: BlockReader, feet: Vec3, dstarOpts: PlannerOpts, next: Vec3): boolean {
  return neighbors(reader, feet, dstarOpts).some((m) => sameCell(m.to, next));
}

/** The stale-edge recovery: rebuild the searcher against the live world and re-extract its first
 *  step, so a terrain shift under the snapshot costs one replan rather than a stale drive. undefined
 *  when the rebuild finds no path (caller holds). */
function rebuiltFirstStep(
  rt: Runtime,
  cfg: Config,
  feet: Vec3,
  goalCell: Vec3,
  goalKey: string,
  dstarOpts: PlannerOpts,
  cost: CostContext,
): NextStep | undefined {
  const searcher = buildDStarCache(rt, cfg, feet, goalCell, goalKey, dstarOpts, cost);
  const rebuilt = searcher?.extractPath();
  if (!rebuilt || rebuilt.path.length < 2) return undefined;
  creditShorterRoute(rebuilt.path.length); // a fresh searcher: sets the baseline, credits nothing
  const rp = smoothedPath(cfg, navCachingReader(rt, cfg), rebuilt);
  dstarCache.pathLen = rp.path.length;
  const cell = rp.path[1];
  return cell ? { cell, kind: kindOf(rp.kinds, 1) } : undefined;
}
