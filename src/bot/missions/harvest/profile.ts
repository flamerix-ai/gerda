import type { Config } from "@/shared/config/schema";
// HarvestProfile — the per-mission deltas that turn the shared scan→goto→break loop into
// either ore-mining or wood-chopping. `mine` and `chop` are the SAME behaviour (spiral for
// an exposed target block, walk to it, break it, drain the local cluster, repeat) differing
// only in: the target predicate, the scan extents, whether to escalate into dense VEIN mode,
// the origin-distance scoring bias, and a few log/telemetry labels. Those all live here so
// scan/mine stay one implementation instead of two near-identical forks.
import { oreMatchesGroup } from "@/shared/domain/ore-groups";
import { isOre } from "@/shared/domain/scan";
import { isLog } from "@/shared/domain/wood";

export interface HarvestProfile {
  /** Short label for logs/reasons (e.g. "ore", "log"). */
  readonly label: string;
  /** Journal event name emitted when a target is found ("ORE_FOUND" / "LOG_FOUND"). */
  readonly findEvent: string;
  /** Journal event + transition reason when the scan exhausts all cycles. */
  readonly exhaustEvent: string;
  readonly exhaustReason: string;
  /** Whether this block id is a harvest target (bound to the active config). */
  isTarget(id: string): boolean;
  readonly scanRadius: number;
  readonly scanYRange: number;
  /** Radius of the local refill cube collected around a just-broken cell. */
  readonly veinRadius: number;
  /** Radius of the dense VEIN-mode spiral (only used when escalateToVein). */
  readonly veinScanRadius: number;
  /** Distance-from-origin penalty added to the find score (work outward vs tunnel). */
  readonly originBias: number;
  /** Escalate SPIRAL→VEIN on the first find (ore clusters); false = spiral-only (trees). */
  readonly escalateToVein: boolean;
  /** Clear the scanned-cell cache at the end of each spiral cycle (re-scan even if
   *  stationary). Ore keeps the cache (the bot moves as it mines); wood clears it. */
  readonly clearCacheOnCycle: boolean;
  /** Emit the `oreFound` bus event (telemetry counts ore only — wood would skew it). */
  readonly emitOreFound: boolean;
}

export function oreProfile(cfg: Config): HarvestProfile {
  return {
    label: "ore",
    findEvent: "ORE_FOUND",
    exhaustEvent: "SCAN_EXHAUSTED",
    exhaustReason: "max scan cycles",
    isTarget: (id) => isOre(id, cfg),
    scanRadius: cfg.scan.radius,
    scanYRange: cfg.scan.yRange,
    veinRadius: cfg.scan.veinStepRadius,
    veinScanRadius: cfg.scan.veinRadius,
    originBias: cfg.scan.originBias,
    escalateToVein: true,
    clearCacheOnCycle: false,
    emitOreFound: true,
  };
}

/** The drill's harvest profile: ore behaviour, but SHAFT-LOCAL. A drill mines the vein it
 *  drilled down to ("dig the rest") — not every ore in the region. The default radius-32 ore
 *  SCAN would, once the shaft vein is drained, chase ore blocks away through solid rock →
 *  unreachable from a 1-wide shaft → blocked → ERROR. Clamp SCAN to the shaft's immediate reach;
 *  the MINE vein-follow (veinRadius refill) still drains the whole CONNECTED cluster regardless,
 *  so this only stops the re-scan from wandering. (The skip-on-block backstop in navigation handles
 *  any residual unreachable cell within the small radius.) When `ore` is given (the drill's `ore=`
 *  param) the target predicate is SCOPED to that ore group — so a drill sent for gold ignores the
 *  magnetite/copper it passes and only mines gold (else on an ore-rich surface it chases every ore
 *  it grazes instead of drilling its vein). */
export function drillProfile(cfg: Config, ore?: string): HarvestProfile {
  const base = oreProfile(cfg);
  const group = ore?.trim();
  return {
    ...base,
    isTarget: group ? (id) => base.isTarget(id) && oreMatchesGroup(id, group) : base.isTarget,
    scanRadius: cfg.drill.scanRadius,
    scanYRange: cfg.drill.scanRadius,
    veinScanRadius: cfg.drill.veinRadius, // wider than the descent scan → follows a vein across a thin void
  };
}

export function woodProfile(cfg: Config): HarvestProfile {
  return {
    label: "log",
    findEvent: "LOG_FOUND",
    exhaustEvent: "CHOP_SCAN_EXHAUSTED",
    exhaustReason: "no trees found",
    isTarget: (id) => isLog(id, cfg),
    scanRadius: cfg.chop.scanRadius,
    scanYRange: cfg.chop.scanYRange,
    veinRadius: cfg.chop.veinRadius,
    veinScanRadius: cfg.chop.veinRadius,
    originBias: 0,
    escalateToVein: false,
    clearCacheOnCycle: true,
    emitOreFound: false,
  };
}
