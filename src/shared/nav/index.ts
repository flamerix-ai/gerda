// biome's noBarrelFile is turned OFF for this one file (biome.json overrides) — the barrel is
// deliberate, and the cost the rule guards against does not exist here. noBarrelFile targets bundlers
// that pull a whole module graph in from one re-export; we ship ONE tsup IIFE with tree-shaking, so
// the barrel costs nothing at runtime. What it buys is the tier seam: capabilities/missions depend on
// `@/shared/nav`, not on the internal split, so the executor can be re-cut (as it has been in this very
// refactor) without touching a single call site. It is a file-level rule, so a per-line
// `biome-ignore` cannot express this — hence the config override rather than a comment.
//
// The navigator's public surface — what missions/capabilities import as `@/shared/nav`.
// The greedy executor is split by concern (core / supply / descent / route / ladder / pillar /
// parkour / executor) with this barrel re-exporting exactly the surface the old single-file
// greedy-nav exposed; the shared break/place routines live beside it (`@/shared/nav/break-cell`,
// `@/shared/nav/place-cell`) and the engine-selection slice at `@/shared/nav/engine`.
export { type GreedyStep, greedyRelease, isBlocked, liveReader } from "@/shared/nav/core";
export { descentBeyondBudget } from "@/shared/nav/descent";
export {
  type GreedyOpts,
  driveBridgeStep,
  greedyStep,
  horizonSubGoal,
  resetGreedyNav,
} from "@/shared/nav/executor";
export {
  type ParkourTracePoint,
  parkourSnapshot,
  parkourTraceClear,
  parkourTraceDump,
} from "@/shared/nav/parkour";
export { endPillarAscent } from "@/shared/nav/pillar";
export {
  navGreedyCalledOn,
  navRouteProgress,
  navRouteSnapshot,
  navSearchPending,
  navSearchResumed,
  navStepIsStationaryWork,
} from "@/shared/nav/route";
export { type FillerStatus, fillerStatus, peerAvoidColumns } from "@/shared/nav/supply";
