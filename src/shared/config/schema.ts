import { ContractError } from "@/core/prim/invariant";
// Typed config — the SSOT for tunables. Replaces config.js (which had duplicate keys where the
// later definition silently won). This nests the flat schema into per-concern sub-objects
// (nav / drill / excavate / …) so a 180-key flat record reads as clusters; genuinely cross-cutting
// singletons (homeCommand, worldModelPath, teleportWaitTicks, hudInterval, …) stay at the top level.
// A pack profile overrides a subset at load time via makeConfig (a per-section merge, ONE level
// deep — see there).
//
// TIERS: this file is SHARED — it owns the Config TYPE and pack-NEUTRAL
// defaults, and it NEVER names a mod/item/block id. Every pack-specific value (ore ids, filler /
// junk / food items, recipes, base coords, container kinds, the home command) lives in the BOT
// tier at `src/bot/profile/pack.ts`, layered on by `makeGerdaConfig` (src/bot/profile/config.ts). The
// fields below still carry their type + doc comment; only their DEFAULT is empty here.
import type { ContainerKindRule } from "@/core/runtime/Runtime";
import type { Face, Vec3 } from "@/core/runtime/types";

/** One step of a craft chain: place `grid` (row-major, null = empty cell) and craft it
 *  `times`. 4-cell grids use the 2×2 player inventory; the chain's last step (≤9 cells)
 *  is crafted at a placed 3×3 table. */
export interface CraftChainStep {
  readonly grid: readonly (string | null)[];
  readonly times: number;
}

// ── ore targeting (pack profile overrides these) ──────────────────────────────────────────
export interface OreConfig {
  readonly ids: ReadonlySet<string>;
  readonly allowAll: boolean; // fall back to any "*_ore" id
  // Ore-group → minimum pickaxe harvest rank, DERIVED from the live pack's needs_*_tool block tags
  // (extract_ores_live.py writes `group_ranks` into ores_live.json) merged over the static
  // vanilla-ladder fallback in domain/tooling. Consumed by warnIfMissingTool (MISSION_TOOL_TIER).
  readonly minPickRank: Readonly<Record<string, number>>;
}

// ── ore SCAN (the mine mission's spiral search) ───────────────────────────────────────────
export interface ScanConfig {
  readonly radius: number;
  readonly yRange: number;
  readonly veinRadius: number;
  readonly veinStepRadius: number; // local refill cube around a just-broken vein block
  readonly maxBlocksPerTick: number;
  readonly maxCycles: number;
  /** Chunk-aware SCAN re-anchor distance (blocks). The spiral re-anchors at the live player pos each
   *  tick but its index persists, so a SCAN resumed this far from where the index last reset (after
   *  mining a vein, a teleport, goto_waypoint) skips the near rings around the new spot. When the bot
   *  has moved ≥ this from the anchor, the spiral index resets so the CURRENT pos's inner rings are
   *  searched first. Default 16 = one chunk. */
  readonly reanchorDist: number;
  // weight on "distance from the mining origin" when ranking ore finds, so the bot works outward
  // from where it started rather than chasing the globally-nearest vein
  readonly originBias: number;
}

// ── navigator — the greedy field-movement driver + GOTO leg + planner cache ─────
export interface NavConfig {
  readonly gotoArrivalDist: number;
  readonly gotoTimeoutTicks: number;
  /** GOTO progress-watchdog ("skip" missions): ticks without advancing one cell along the followed
   *  route → skip the target. Needs NOT exceed the in-place work budgets (3 cells ×
   *  mineAimTicks+mineBreakTimeoutTicks, a pillar/ladder climb): a greedy stationary-work tick is
   *  exempt, and a tick a guard/reflex owns (no greedy call) is paused — not counted, not a reset —
   *  so this times only the walk-without-advancing wedge. gotoTimeoutTicks caps the leg. */
  readonly gotoStallTicks: number;
  /** How often to re-issue the travel goal while moving (shared by navigation/loot/fetch). */
  readonly gotoReissueTicks: number;
  /** Fail-fast on a greedy "blocked": true → log loud + ERROR (visible, no silent self-heal);
   *  false → divert to RECOVER (teleport-out). Either way the block is logged loudly. */
  readonly blockedFailFast: boolean;
  /** TTL (ticks) a cached world-view block read stays fresh before a live re-fetch. The planner
   *  plans on this cache; the step-hazard veto ALWAYS reads live, so a stale cache never hides a
   *  fresh hazard. */
  readonly worldViewTtlTicks: number;
  /** Blocks the executor will plan to drop in one move, and the fall damage it tolerates. */
  readonly maxDrop: number;
  readonly maxFallDamage: number;
  /** COMMIT-TO-CHOICE: once the executor commits to a `next` cell it keeps driving toward it even
   *  if a fresh plan offers an equal-cost alternative — killing the tick-to-tick `next` flip that
   *  oscillates in place. Held only while the cell stays live-walkable AND strictly reduces the goal
   *  heuristic, force-dropped after this many ticks so a stuck commit can't wedge. */
  readonly commitTimeoutTicks: number;
  /** Guarded sprint: hold `key.sprint` only on a clear flat runway (≥2 same-level non-hazard cells
   *  ahead) and never within `sprintMinDist` of the target or onto a step/drop. The sprint flag is
   *  applied MAIN-thread via main.js (worker publishes mc_want_sprint) to dodge the FOV-race CME;
   *  edge-triggered. Parkour (opt-in) needs this ON to reach launch speed. */
  readonly sprint: boolean;
  readonly sprintMinDist: number;
  /** Sticky sprint-up a CONSISTENT ascending staircase (climb tuning): a multi-tick LATCH (arm on a
   *  grounded ascending step whose ascent continues, HOLD sprint through the arc, release on the
   *  final step / flat landing). A stateless "sprint a +1 step" rule flickers mid-arc and gains 0. */
  readonly sprintStairs: boolean;
  /** Parkour: plan a sprint-jump ACROSS a horizontal gap instead of dropping in
   *  and climbing back. `parkour` enables the move; `parkourMaxGap` caps the jump distance;
   *  `parkourPenaltyTicks` biases the planner toward a flat walk; the executor drives it with a
   *  RUN-UP (retreat up to `parkourRunupCells`, sprint back, fire once speed ≥ `parkourTakeoffSpeed`). */
  readonly parkour: boolean;
  readonly parkourMaxGap: number;
  readonly parkourPenaltyTicks: number;
  readonly parkourRunupCells: number;
  readonly parkourTakeoffSpeed: number;
  /** Abort a run-up that hasn't launched within this many ticks → "blocked_no_path". */
  readonly parkourStallTicks: number;
  /** Fraction across the take-off cell (0 = near edge, 1 = far lip) at/beyond which the executor
   *  fires the jump — launching at the lip clears the gap (jumping mid-cell wastes arc). */
  readonly parkourFarEdge: number;
  /** Horizontal cell-distance boundary separating a SHORT step (walk/step/drop/diagonal, ≤ this)
   *  from a far PARKOUR landing (> this). ONE value shared by the executor's parkour dispatch and
   *  the route-cache commit gate (used with opposite senses) so the two can never drift. */
  readonly parkourMinCells: number;
  /** Pillar-up as a NAVIGATION move: rise a block in place by jump-placing filler under
   *  the feet. `pillar` enables it (offered only with carried fillerBlocks); `pillarPenaltyTicks`
   *  is the per-block placement bias so a walk/step/stair route up always wins. */
  readonly pillar: boolean;
  readonly pillarPenaltyTicks: number;
  /** Failed pillar cycles (stalled jump / place that never raised the bot / centring that can't
   *  reach the column) before the pillar sub-machine gives up → blocked_no_path. */
  readonly pillarMaxAttempts: number;
  /** Mining as a NAVIGATION move: break a solid breakable cell to advance,
   *  folding the drill's DIG_TO staircase into the engine. `mine` enables the moves;
   *  `breakCostTicks` is the per-block break cost so an open walk route wins. */
  readonly mine: boolean;
  readonly breakCostTicks: number;
  /** Horizontal distance under which a break target counts as "straight above/below" → the
   *  vertical-aim setRotation(±90) path is used instead of lookAt (which degenerates overhead). */
  readonly breakVerticalEps: number;
  /** Bridging as a NAVIGATION move: cross a floor gap by laying filler under the
   *  next cell. `bridge` enables it; `bridgePenaltyTicks` biases toward a no-filler route;
   *  `bridgeMaxRun` bounds the A* frontier over a void (only start a bridge that reaches ground
   *  within this many cells) — CRITICAL search bound against a render-thread getBlock storm. */
  readonly bridge: boolean;
  readonly bridgePenaltyTicks: number;
  readonly bridgeMaxRun: number;
  /** PROACTIVE water-clutch descent — dive a fatal drop trusting the clutch reflex to place water
   *  at the bottom. `waterDrop` enables the move (bucket-gated); `waterDropMaxDrop` bounds the
   *  down-scan; `waterDropPenaltyTicks` biases toward a safe walk/drop route. */
  readonly waterDrop: boolean;
  readonly waterDropMaxDrop: number;
  readonly waterDropPenaltyTicks: number;
  /** LADDER climbing — ride an existing ladder/vine to reach a different level (non-destructive,
   *  spends nothing, applies only where a climbable already exists, so on by default). */
  readonly ladder: boolean;
  /** DESCENT RECOVERABILITY GUARD: `descentGuard` + `maxDescentBelowRim` (hard executor
   *  veto — refuse a descending step that sinks the bot > this + carried-filler blocks below the
   *  leg's rim while above the goal level) tame the "descent trap"; `descentPenaltyTicks` is the soft
   *  per-block-of-drop planner bias (amortized reversal cost). Ladder descents are exempt. */
  readonly descentGuard: boolean;
  readonly maxDescentBelowRim: number;
  readonly descentPenaltyTicks: number;
  /** When the descent guard vetoes a leg, record a persistent `ravine` HazardMarker; the mine SCAN
   *  then skips exposed ore within this radius of a recorded hazard (any kind). 0 disables the skip. */
  readonly ravineHazardRadius: number;
  /** PEER-AS-OBSTACLE: treat columns other players/bots stand in as impassable when
   *  planning. `peerObstacle` toggles it; `peerRadius` bounds which peers count; `peerClearance` is
   *  the Chebyshev radius blocked around each peer's feet. The explicit GOAL column is always exempt. */
  readonly peerObstacle: boolean;
  readonly peerRadius: number;
  readonly peerClearance: number;
  /** INCREMENTAL REPLAN — the executor caches the planned route and follows it cell-by-cell; a
   *  best-effort route triggers a VOLUNTARY extend-replan once within `replanLookahead` cells of its
   *  end, but no sooner than `replanTicks` since the last plan, so a blocked goal escalates rather
   *  than spinning A* per tick. */
  readonly replanTicks: number;
  readonly replanLookahead: number;
  /** CROSS-TICK A* — world reads one worker tick may spend on a route search before it yields; the
   *  search resumes next tick while the bot holds still, so no reflex waits on a whole search. */
  readonly planReadsPerTick: number;
  /** MOVING GOAL — cells (largest axis) a goal may move and still be the same goal: per call, a
   *  running route search is kept (its own goal is fixed at `PlanSearch` construction; the moved goal
   *  follows its route as a partial one, then searches); from the goal a cached route was planned for,
   *  the route stays followable as a partial one. A larger jump is a new goal: search and route drop. */
  readonly goalShiftCells: number;
  /** HORIZON-BOUNDED first plan — when the goal is farther than this (XZ), aim at a sub-goal
   *  projected that many blocks along the line toward it, bounding the first plan's cold reads to the
   *  local horizon (reached in segments via extend-replan). 0 disables. */
  readonly horizonBlocks: number;
  /** STRING-PULL — collapse A*'s equal-cost zigzag on flat runs to the straightest adjacent-cell
   *  line so the guarded sprint holds through a detour. Off → raw A* path. */
  readonly smoothPath: boolean;
  /** D* LITE incremental replanner — plan a point-goal leg over the bounded move set to
   *  the REAL goal ONCE and repair the goal-rooted tree per tick. Off → the A* + route-cache path. */
  readonly dStar: boolean;
  /** D* Lite ANYTIME budget — max vertex expansions per per-tick pass before yielding to act on a
   *  partial tree (the bot walks bestEffortStep meanwhile → no cold-start freeze). */
  readonly dStarStepPops: number;
  /** AUTO-engine distance threshold (blocks) — only consulted by `nav_engine auto`: a leg whose
   *  straight-line start→goal distance is ≥ this engages D* Lite; a shorter leg keeps A*. */
  readonly autoDStarDist: number;
  /** LOW-FILLER GUARD — offer pillar/bridge only when the bag carries at least this many filler
   *  blocks, so a place-chain the bot can't finish never strands it mid-route. */
  readonly fillerMin: number;
  /** Cheap blocks the bot will pillar/bridge with, priority order (the junk a mining run accumulates).
   *  Shared by the navigator's pillar/bridge moves (nav/supply, nav/pillar, nav/place-cell). */
  readonly fillerBlocks: readonly string[];
  /** Pillar-up jump-place physics (PILLAR executor): `pillarApexMinY` = body-clearance floor (feet
   *  must rise ≥ this above base-Y); `pillarApexVy` = place once vertical velocity ≤ this (the apex);
   *  `pillarMaxCycles` = cap on rises per ore; `pillarCycleTimeoutTicks` = abandon a stalled cycle. */
  readonly pillarApexMinY: number;
  readonly pillarApexVy: number;
  readonly pillarMaxCycles: number;
  readonly pillarCycleTimeoutTicks: number;
  /** Bridge / wall-fill: `bridgeMaxCells` caps the filler cells laid toward one target;
   *  `placeTimeoutTicks` abandons a single cell-place that won't land → graceful skip. */
  readonly bridgeMaxCells: number;
  readonly placeTimeoutTicks: number;
  /** break-cell (the shared AIM→BREAK routine): `mineAimTicks` = aim settle before breaking;
   *  `mineBreakTimeoutTicks` = per-block break budget. */
  readonly mineAimTicks: number;
  readonly mineBreakTimeoutTicks: number;
}

// ── drill mission (prospect → drill-down → mine) + the DIG_TO 3D vein-chase ────────────────
export interface DrillConfig {
  readonly minY: number; // stop digging down here (near bedrock) → fail-loud if no vein
  readonly scanRadius: number; // cube radius checked for the exposed vein each descent step
  /** Dense vein-follow radius after hitting ore (decoupled from scanRadius) — larger so a vein split
   *  by a thin void is still followed (the in-engine bridge lays filler to reach the far ore). */
  readonly veinRadius: number;
  readonly maxFall: number; // refuse to break the floor if it opens a fall deeper than this
  readonly footprintHalfWidth: number; // half the player AABB width — dig every column the feet straddle
  readonly centerTol: number; // within ± this of block centre → footprint is a single column
  readonly centerMaxTicks: number; // give up centring after this and footprint-dig anyway
  readonly stallTicks: number; // feet.y frozen this long in DESCEND → loud DRILL_STALL→ERROR
  readonly horizonRadius: number; // before descending, mine exposed at-or-above ore within this radius first
  /** Surface-scatter skip: ignore exposed ore until the shaft is this many blocks below where it
   *  started (the prospector gives X/Z only, so drill past surface scatter to the buried band). */
  readonly surfaceSkip: number;
  readonly multiBand: boolean; // after excavating a band, keep descending to mine every band to minY
  readonly hazardRadius: number; // skip a cached vein within this of a recorded drowned column (0 = still record)
  /** Beyond-the-horizon veto: never target a cached vein further than this many blocks away (a stale
   *  cross-area marker is a walk no task TTL survives → noTarget/park). */
  readonly maxVeinDist: number;
  /** GOTO-stall skip: when the DESCEND step-1 walk-onto-the-column makes no progress toward a vein
   *  for this many consecutive ticks, give up on THAT vein (unreachable across a gap) → next-nearest.
   *  A tick that only resumes the walk's route search is not counted. */
  readonly approachBlockedTicks: number;
  readonly approachProgressEps: number; // blocks-closer per tick that counts as PROGRESS (reset the stall counter)
  /** Flooded-column watchdog: this many consecutive DESCEND ticks in water contact ⇒ the column is
   *  flooded (a surface-bob/flow trap), record it drowned and skip. */
  readonly waterContactTicks: number;
  /** 3D vein-chase (DIG_TO): cap the staircase/tunnel length to reach one offset/above ore cell
   *  (`digToMaxSteps`, greedy ARRIVALS); bail after `digToStallTicks` CONSECUTIVE no-progress ticks
   *  (an unreachable target would otherwise re-plan a heavy A* every tick → getBlock storm). */
  readonly digToMaxSteps: number;
  readonly digToStallTicks: number;
}

// ── EXCAVATE — strip-mine the prospected vein VOLUME ─────────────────────────────
export interface ExcavateConfig {
  readonly bandHeight: number; // how far below the first-ore depth the band extends
  readonly maxRadius: number; // clamp the vein footprint half-extent (columns)
  readonly rowSpacing: number; // Z-gap between corridors (gap = spacing−1, exposed from the side)
  readonly levelSpacing: number; // Y-gap between excavation levels
  readonly maxCells: number; // hard planned-cell budget (runaway backstop; truncation logged)
  /** Void-skip depth: skip a corridor stand-cell whose floor is air this many blocks down (a real
   *  void, not a 1-block step) — the excavate planner is pure geometry with no terrain awareness. */
  readonly voidProbe: number;
  /** Tick-based progress watchdog: no observable progress (cursor / grounded feet / break target)
   *  for this long → one rescue leg, then skip the cell. Must exceed nav.mineBreakTimeoutTicks. */
  readonly stallTicks: number;
  readonly rescueTicks: number; // continuous-drive rescue budget to climb/pillar back to the corridor cell
}

// ── search — the survey/coverage mission (serpentine grid + volumetric container scan) ─────
export interface SearchConfig {
  readonly scanRadius: number;
  readonly scanHeight: number; // ± from the stand Y — see upper/lower floors without a ladder
  readonly scanPerTick: number; // spread the cuboid read over ticks
  readonly gridStep: number; // spacing between stops (≤ 2·radius for overlap)
  readonly cols: number;
  readonly rows: number;
}

// ── chop-wood (tree felling) ──────────────────────────────────────────────────────────────
export interface ChopConfig {
  readonly logIds: ReadonlySet<string>;
  readonly allowAllLogs: boolean; // fall back to any "*_log"/"*_wood" id
  readonly scanRadius: number;
  readonly scanYRange: number; // taller than ore scan — trees grow up
  readonly veinRadius: number; // local cube to gather adjacent trunk/branch logs
}

// ── craft — manual grid placement (the recipe-book API is dead on Monifactory) ─────────────
export interface CraftConfig {
  readonly defaultChain: readonly CraftChainStep[];
  readonly stepTimeoutTicks: number; // a stuck sub-step (place/wait/take) → ERROR
  /** Re-fire cadence for effect-verified table interactions (place the table / open its GUI) —
   *  one useOnBlock "ok" only means DISPATCHED, so retry every this-many ticks until read-back
   *  verifies (bounded by stepTimeoutTicks). */
  readonly openRetryTicks: number;
}

/** How the mission decides an interaction actually took effect.
 *  - `consumed` — a held stack of the placed item dropped by ≥1 (frames, pedestals, displays that
 *    absorb the item). The default for frame/display profiles; worker-side (reads only the bag).
 *  - `none` — fire-and-forget: the right-click was dispatched, no readable effect asserted
 *    (levers, buttons, GUIs). The default for the generic profile.
 *  Extend by adding an arm in domain/interact + `verifyPlaced` + the profile that selects it (e.g.
 *  a future `block` mode = the target's face-offset cell became non-air). */
export type VerifyMode = "consumed" | "none";

/** A target-kind default, from config `interact.profiles`. `face` pins the interaction face for
 *  kinds that always sit one way (rare); omitted → the caller/geometry picks it (face toward the
 *  bot). Lives HERE, not in domain/interact, to break the config↔domain import cycle: `domain →
 *  config` is the direction that already exists (three domain files import `Config`), so interact
 *  follows it rather than fighting it. */
export interface InteractProfile {
  readonly verify: VerifyMode;
  readonly face?: Face;
}

// ── interact mission / interact_place primitive (right-click a held item onto a face/entity) ─
export interface InteractConfig {
  readonly reach: number; // stop GOTO this close to the target block before aiming (reach-ish)
  readonly timeoutTicks: number; // give up the whole interaction after this (GOTO + aim + verify)
  readonly graceTicks: number; // wait after useOnBlock for the server to apply it before verify
  readonly frameRadius: number; // frame profile: match the frame ENTITY within this of the target cell
  // Per-target-kind defaults — the verify-seam profiles (frame/display/generic).
  readonly profiles: Readonly<Record<string, InteractProfile>>;
}

// ── hunt mission (chase + melee a mob, loop until a kill-count, then loot via auto-pickup) ──
export interface HuntConfig {
  readonly targets: readonly string[]; // entity ids the bot may hunt
  readonly senseRadius: number; // world.mobs() sense distance (≤ main.js MOBS_RADIUS=32)
  readonly reach: number; // melee strike distance (vanilla reach ~3)
  readonly swingEvery: number; // ticks between attack swings (sword cooldown ≈ 12t)
  readonly chaseTimeoutTicks: number; // give up chasing ONE target after this
  readonly lootSettleTicks: number; // after a kill, linger so vanilla auto-pickup grabs drops
  readonly seekGraceTicks: number; // tolerate an empty mob snapshot this long before ending
}

// ── follow mission (trail a peer — player/bot — until stopped) ─────────────────
export interface FollowConfig {
  readonly senseRadius: number; // world.peers() sense distance (≤ main.js PEERS_RADIUS=48)
  readonly gap: number; // stop walking within this many blocks of the peer (trail, don't crowd)
  readonly resumeSlack: number; // resume only past gap+slack (hysteresis vs jitter)
  readonly lostWaitTicks: number; // tolerate the peer off-snapshot this long before FOLLOW_WAIT (never ends)
}

// ── loot ──────────────────────────────────────────────────────────────────────────────────
export interface LootConfig {
  readonly scanInterval: number;
  readonly scanRadius: number;
  readonly pickupDist: number;
  /** "Is the drop still there" radius for the verified-pickup check: a same-id item within this of
   *  the LOOT target counts as the (drifted) drop, keeping the phase alive. Must exceed pickupDist. */
  readonly verifyRadius: number;
  readonly timeoutTicks: number;
  /** Per-block break budget for mining the cap off a blocked chest (loot-run breakBlocked). Caps are
   *  often broken BY HAND (a loot bot carries no tools), so this is generous. */
  readonly capBreakTimeoutTicks: number;
}

// ── health / safety / reflexes ────────────────────────────────────────────────────────────
export interface SafetyConfig {
  readonly minHealth: number;
  // Proactive distress (vitals): react to SUSTAINED harm. If the bot loses ≥ distressDrop HP from
  // its recent peak within distressWindow ticks AND from ≥ distressMinEvents distinct damage ticks
  // (the anti-false-positive guard: a lone fall is ONE event → never trips) → bail to RECOVER early.
  readonly distressEnabled: boolean;
  readonly distressWindow: number;
  readonly distressDrop: number;
  readonly distressMinEvents: number;
  // RECOVER drowning-escape: hold jump to surface for ≤ this before giving up on a capped pocket.
  readonly surfaceMaxTicks: number;
  readonly toolDurabilityHardStop: number; // %; below → ERROR
  readonly toolDurabilitySwap: number; // %; below → swap or go home
  /** Phases where the tool reflex must NOT hot-swap — we're already at the chest, so a swap
   *  there fights the dump trip instead of rescuing it. Bot vocabulary, hence config data. */
  readonly toolSwapBlockedPhases: readonly string[];
  readonly stuckTicksThreshold: number;
  readonly stuckMovedEpsilon: number; // per-tick movement below this counts as "not moving"
  // Universal progress-contract DEFAULT backstop budget: a running work phase with no
  // explicit ProgressPolicy that hasn't moved its feet for this long is silently wedged → PAUSED
  // (loud). Generous — the phase's own timeout (goto/break/…) should fire first; this only bites
  // when that timeout is broken or missing (the exact bug class). Also the FOLLOW walk-stall budget.
  readonly phaseStallTicks: number;
  readonly airRecoverPct: number; // fraction of max breath at/under which the air reflex bails to RECOVER
  readonly lowFoodLevel: number; // hunger (0..20) at/under which the hunger reflex emits lowFood
  // maintenance EAT: level to eat back up to, the per-meal timeout, ticks between bites, allowed foods.
  readonly eatTargetFood: number;
  readonly eatTimeoutTicks: number;
  readonly eatBiteTicks: number;
  readonly foodItems: readonly string[];
  // RECOVER backoff: recoverMaxAttempts re-entries within recoverBackoffWindow ticks → ERROR + park.
  readonly recoverMaxAttempts: number;
  readonly recoverBackoffWindow: number;
  // RECOVER homeCommand sends in a row that moved the bot less than teleportMinMoveBlocks while it
  // stood that far from its recorded home, or had none recorded (no home set, "Unknown
  // destination!"), before the bot stops sending it. homeRearmTicks later it sends again (a /home
  // cooldown looks the same as a missing home); a chat `home` re-arms it at once.
  readonly homeNoEffectLimit: number;
  readonly homeRearmTicks: number;
  // Respawn further than this from the death spot = displaced → park an active mission PAUSED.
  readonly respawnDisplacedDist: number;
  readonly voidY: number; // y below which the bot is falling into the void → RECOVER
  readonly hazardSubstrings: readonly string[]; // block-id substrings making a feet/eye block an immediate hazard
  readonly inputSettleTicks: number; // ticks to ignore movement input after the BOT last drove (any mission) — the residual of a released key latch
  readonly inputHoldTicks: number; // consecutive ticks of sustained input before the human reflex → PAUSED
  readonly driveHeldMaxTicks: number; // cap on how long a held drive key ALONE may keep the human reflex suppressed outside a movement phase (a latched key otherwise blinds it forever)
  // water-clutch reflex (emergency MLG fall-survival): place water on the floor below before impact,
  // then scoop the source back up. Water negates ALL fall damage, so there's no apex to track.
  readonly waterClutchEnabled: boolean;
  readonly waterClutchMinFall: number; // min drop (blocks) below worth clutching
  readonly waterClutchReach: number; // place once the floor is ≤ this many blocks below
  readonly waterClutchScanDepth: number; // how far straight down to scan for the landing floor
  readonly waterClutchFallVy: number; // velocity.y at/under which the bot counts as falling
  readonly waterClutchRetrieveTicks: number; // give up scooping the source back up after this
  // clamp (blocks) on leading the placement by horizontal velocity: water goes under the PREDICTED
  // landing column, not the current one — a walk-off's drift otherwise carries the bot past it
  readonly waterClutchLeadClamp: number;
  readonly waterBucketId: string; // full-bucket item id placed; empty bucket refills to this on scoop
  readonly emptyBucketId: string; // what the held bucket becomes when the place lands (the effect-verify signal)
  // swim-out reflex: when SUBMERGED but air is not yet critical, hold jump to float up in place.
  readonly swimOutEnabled: boolean;
  readonly swimOutMaxTicks: number; // give up (→ air reflex) after this many ticks WITHOUT gaining height
}

// ── inventory (junk-shed + dump trigger) ──────────────────────────────────────────────────
export interface InventoryConfig {
  readonly fullPct: number;
  readonly checkIntervalTicks: number; // between the mine mission's throttled junk-shed / fullness checks
  readonly dumpChestGraceTicks: number; // DUMP waits this long for a container screen before dropping junk on the floor
  readonly junkItems: readonly string[];
}

// ── sustain-loop economy (the autonomous mine→base→smelt→repeat plan, makeSustainCycle) ────
export interface SustainConfig {
  readonly basePos: Vec3; // the furnace bank middle the loop opens to load/collect
  readonly oreItem: string; // raw ore the bot mines + feeds the furnace (smelt input)
  readonly ingotItem: string; // the smelted output to collect each lap
  readonly fuelItem: string; // furnace fuel
  readonly mineCount: number; // ore broken per lap before returning to base
  readonly oreKind: string; // prospector vein "kind" to seek (PROSPECT_ORE_GROUPS key)
  // Restock-craft leg (#22): each lap, top up a small-parts stock. CONDITIONAL (craft want/min).
  readonly restockItem: string;
  readonly restockMin: number; // 0 = never craft
  readonly restockChain: readonly CraftChainStep[];
  // Tool replace leg (#23): keep a SPARE mining tool so the tool reflex always has a fresh backup.
  readonly toolItem: string;
  readonly toolMin: number; // 0 = never craft
  readonly toolChain: readonly CraftChainStep[];
  // Storage-network unload leg: deposit surplus into the base storage each lap. [] disables.
  readonly storeItems: readonly string[];
}

// ── telemetry (game KPIs → HTTP push of Prometheus exposition text → VictoriaMetrics) ──────
export interface TelemetryConfig {
  readonly pushUrl: string | null; // VM import endpoint; null = telemetry off
  readonly interval: number; // ticks between pushes
  readonly prefix: string; // metric-name prefix (e.g. "miner_")
}

// ── in-game chat commands (`!<bot|all> <verb> [args…]` typed by a player) ──────────────────
export interface ChatConfig {
  /** Player names allowed to issue chat commands, matched EXACTLY (case-sensitive: a lookalike
   *  name is refused, never admitted). Fail-CLOSED: an EMPTY list means NOBODY — the capability
   *  is inert and chat commands are off, which is what ships. The single entry `"*"` is the
   *  explicit escape hatch that opens it to anyone.
   *  NOT an auth boundary: the server runs offline-mode, so a chat name proves nothing about who
   *  typed it — this list keeps bystanders (and peer bots) from steering the bot, it does not
   *  stop someone who logs in under an operator's name. */
  readonly trustedPlayers: readonly string[];
  /** Chat lines heard but not yet handled. RecvMessage fires on the jsMacros LISTENER thread,
   *  so the listener only enqueues and the tick thread drains; a flood past this bound drops the
   *  OLDEST line (the queue can never grow without limit, and the newest command still lands). */
  readonly queueCapacity: number;
  /** Minimum ticks between two SPOKEN "not authorized" refusals to the same sender. One refusal
   *  is information; one per line is chat spam an untrusted player can aim at the server. */
  readonly denyReplyTicks: number;
  /** Prefix on every reply the bot speaks. Structural no-feedback-loop: a prefixed line cannot
   *  start with the command prefix, so no bot can re-parse another bot's answer as a command
   *  (asserted at capability init). NOT applied to the `home` teleport macro, which is a server
   *  command rather than a reply. */
  readonly replyPrefix: string;
  /** Bounds a chat `goto` coordinate must fall inside (vanilla world border / build limits).
   *  Number.isFinite alone let `goto 3e7 -9999 3e7` reach the navigator as a real target. */
  readonly maxCoordXZ: number;
  readonly minCoordY: number;
  readonly maxCoordY: number;
  /** Upper bound for a chat count argument (`chop 12`, `hunt 3`); the lower bound is always 1. */
  readonly maxCount: number;
}

export interface Config {
  readonly ore: OreConfig;
  readonly scan: ScanConfig;
  readonly nav: NavConfig;
  readonly drill: DrillConfig;
  readonly excavate: ExcavateConfig;
  readonly search: SearchConfig;
  readonly chop: ChopConfig;
  readonly craft: CraftConfig;
  readonly interact: InteractConfig;
  readonly hunt: HuntConfig;
  readonly follow: FollowConfig;
  readonly loot: LootConfig;
  readonly safety: SafetyConfig;
  readonly inventory: InventoryConfig;
  readonly sustain: SustainConfig;
  readonly telemetry: TelemetryConfig;
  readonly chat: ChatConfig;

  // ── cross-cutting singletons / below-threshold clusters (kept at the top level) ──
  /** VEIN-CLAIM deconfliction: skip a cached vein within this of a peer's hub-leased claim. */
  readonly fleetVeinClaimRadius: number;
  /** Generic container-open grace: ticks to wait for a container GUI (furnace/chest/barrel) to open
   *  after useOnBlock before ERROR. Shared by smelt/fetch/stash/storage/loot-run. */
  readonly containerOpenGraceTicks: number;
  readonly smeltWaitTimeoutTicks: number; // max ticks to wait for a smelt to finish before collecting
  readonly storageDepositGraceTicks: number; // ticks for a drawer deposit to settle (server sync) before re-try/ERROR
  readonly storageStandOffset: number; // blocks to stand in front of a drawer's face (front LOS for the slot raycast)
  /** PACK PROFILE: block-id → container-kind rules handed to the L0 facade at construction,
   *  matched in order. The taxonomy is generic; the mod ids are ours
   *  (tier seam: no mod ids outside the bot tier). */
  readonly containerKinds: readonly ContainerKindRule[];
  // per-tick decision tracing boot default (runtime-toggled by `trace`). OFF in prod.
  readonly traceTicks: boolean;
  readonly teleportWaitTicks: number;
  readonly homeCommand: string;
  readonly backCommand: string;
  readonly teleportMinMoveBlocks: number; // min horizontal blocks moved after /home|/back for the teleport to count
  readonly hudEnabled: boolean;
  readonly hudInterval: number; // ticks between overlay refreshes
  readonly worldModelPath: string; // unified, world-scoped knowledge store (mc_world.json)
  readonly persistInterval: number; // ticks between saves when state is dirty
  readonly journeyMapExport: boolean; // also write JourneyMap-format waypoint files
  readonly journeyMapDir: string | null; // dir for JM waypoint json (null = disabled)
  // Which mission to start automatically on boot (null = boot IDLE, await mission_start).
  readonly autoStartMission: string | null;
  readonly logLevel: "TRC" | "DBG" | "INFO" | "WARN" | "ERR";
  readonly fxDedupeTicks: number; // ticks to suppress a repeat of an identical (op,error) facade failure
}

/** Pack-NEUTRAL defaults: the shape and every tunable of the shipped bot, MINUS the pack-specific
 *  ids/tables/coords — those are empty here and supplied by `src/bot/profile/pack.ts` (see the header).
 *  `makeConfig()` alone therefore yields a config no bot can mine with; `makeGerdaConfig()` is
 *  the loaded one. */
export const DEFAULT_CONFIG: Config = {
  ore: {
    // ids / minPickRank: PACK DATA (generated ore registry + harvest ranks) → src/bot/profile/pack.ts.
    ids: new Set(),
    allowAll: true,
    minPickRank: {},
  },
  scan: {
    radius: 32,
    yRange: 4,
    veinRadius: 12,
    veinStepRadius: 4,
    maxBlocksPerTick: 50,
    maxCycles: 3,
    reanchorDist: 16, // chunk-aware: re-anchor the spiral index when moved ≥ one chunk from the last reset
    originBias: 0.25,
  },
  nav: {
    gotoArrivalDist: 2.5,
    gotoTimeoutTicks: 400,
    gotoStallTicks: 100, // 5s without advancing a route cell → skip (a plain walk advances one per ~5 t)
    gotoReissueTicks: 20,
    blockedFailFast: true, // greedy block → ERROR + loud log, no silent RECOVER (fail-loud)
    worldViewTtlTicks: 40, // 2s — the world only changes when we mine; veto stays live regardless
    maxDrop: 4,
    maxFallDamage: 0,
    commitTimeoutTicks: 30, // ~1.5s — long enough to cross a ledge, short enough to recover a stuck commit
    sprint: true, // sprint flag applied MAIN-thread via main.js (mc_want_sprint) → no FOV-race CME; edge-triggered
    sprintMinDist: 3, // walk the final ≤3 blocks → precise stop, no momentum overshoot
    sprintStairs: true, // sticky sprint-up a consistent staircase (climb tuning)
    parkour: true, // sprint-jump gaps instead of dropping in + climbing back
    parkourMaxGap: 3, // jump up to a 3-air-block gap (land 4 cells away, dist-4) = Baritone's sprint max
    parkourPenaltyTicks: 2, // small bias so a flat walk wins when one exists (Baritone jumpPenalty)
    parkourRunupCells: 3, // retreat up to 3 solid cells behind a takeoff to build a sprint run-up
    parkourTakeoffSpeed: 0.12, // min FORWARD-COMMITMENT speed at the takeoff edge (the launch sprint-jump boost carries ~4 blocks)
    parkourStallTicks: 40, // a run-up reaches takeoff+launch in well under 40 ticks; longer = wedged → bail
    parkourFarEdge: 0.7, // fire the jump at ≥0.7 across the take-off cell (the far lip) so the arc clears the gap
    parkourMinCells: 1.5, // ≤1.5 cells = a short step (commit-holdable); >1.5 = a far parkour landing (executor + route SSOT)
    pillar: true, // rise a sheer wall by jump-placing filler — a nav move, not a drill phase
    pillarPenaltyTicks: 20, // Baritone Settings.blockPlacementPenalty — pillars only when no climb exists
    pillarMaxAttempts: 3, // give up the pillar after 3 failed jump-place/centre cycles → blocked_no_path
    mine: true, // greedy mines through a planned mine-move (DIG_TO folded into the engine)
    breakCostTicks: 20, // per-block break cost (Baritone costOfBreaking) — a flat estimate; open walk wins
    breakVerticalEps: 0.35, // horiz dist under which a break target is "straight above/below" → vertical-aim path
    bridge: true, // greedy bridges a wide gap by laying filler (BRIDGE folded into the engine)
    bridgePenaltyTicks: 20, // Baritone Settings.blockPlacementPenalty — bridges only a gap too wide to parkour
    bridgeMaxRun: 6, // only start a bridge that reaches ground within 6 cells — bounds the A* frontier over a void
    waterDrop: true, // proactive water-clutch dive — live-verified e2e; bucket-gated
    waterDropMaxDrop: 48, // deepest shaft a planned dive will scan — water negates any fall; bounds the down-scan
    waterDropPenaltyTicks: 40, // bucket place+scoop cost bias — a safe walk/drop route wins whenever one exists
    ladder: true, // ride existing ladders/vines to reach another level — non-destructive, spends nothing
    descentGuard: true, // hard executor veto: never sink so far below the leg's rim that the bot can't climb back
    maxDescentBelowRim: 8, // free scramble allowance below the rim before the veto bites (+ carried filler)
    descentPenaltyTicks: 3, // soft per-block-of-drop planner bias (amortized reversal cost)
    ravineHazardRadius: 3, // mine SCAN skips exposed ore within 3 blocks of a recorded ravine/drown hazard
    peerObstacle: true, // plan around columns other players/bots stand in (no-op with no peers in range)
    peerRadius: 24, // only peers this close become plan obstacles (≤ main.js PEERS_RADIUS=48)
    peerClearance: 1, // block the 3×3 columns around each peer's feet
    replanTicks: 10, // ~0.5s cooldown between voluntary extend-replans — caps a blocked goal's A* to once/10t
    replanLookahead: 4, // extend a best-effort route once ≤4 cached cells remain (no stall at the seam)
    planReadsPerTick: 4000, // ~0.1 s live (I-4: 1.06M reads took ~25 s) before an A* search yields the tick
    goalShiftCells: 3, // a walking peer moves ~1 cell per 5 ticks; a new vein target jumps further
    horizonBlocks: 24, // bound the first plan to a 24-block horizon toward a distant goal → cold reads stay local
    smoothPath: true, // string-pull the planned route straight on flat runs → sprint holds through detours
    dStar: false, // incremental D* Lite replanner — off by default (A*+route-cache is the proven path)
    dStarStepPops: 256, // anytime budget: ≤256 D* expansions per tick, bot walks bestEffortStep meanwhile
    autoDStarDist: 48, // `nav_engine auto` threshold: legs ≥48 blocks engage D*; shorter keep A*
    fillerMin: 4, // need ≥4 filler to offer pillar/bridge — don't start a place-chain that strands the bot mid-route
    // PACK DATA (block ids) → src/bot/profile/pack.ts. Empty here = pillar/bridge never offered.
    fillerBlocks: [],
    pillarApexMinY: 1.0, // feet ≥1 block above base-Y → destination cell clear of the AABB
    pillarApexVy: 0.0, // place once vertical velocity ≤ 0 (the jump apex) — height maximal, falling
    pillarMaxCycles: 16, // never pillar more than 16 blocks for one ore (runaway backstop)
    pillarCycleTimeoutTicks: 30, // abandon a jump-place cycle that stalls >1.5s
    bridgeMaxCells: 16, // never lay more than 16 filler cells crossing one gap (runaway backstop)
    placeTimeoutTicks: 30, // abandon a single cell-place that won't land after ~1.5s → skip
    mineAimTicks: 5,
    mineBreakTimeoutTicks: 80,
  },
  drill: {
    minY: -60, // stop digging down at this Y (near bedrock) → fail-loud
    scanRadius: 2, // horizontal cube radius checked for the exposed vein each descent step
    veinRadius: 5, // dense vein-follow radius after hitting ore — spans a thin void (bridge crosses it)
    maxFall: 3, // refuse to break the floor if it opens a fall deeper than this (cave/void)
    footprintHalfWidth: 0.3, // vanilla player AABB is 0.6 wide → ±0.3 around the centre
    centerTol: 0.2, // within ±0.2 of block centre → footprint is a single column (clean shaft)
    centerMaxTicks: 20, // give up centring after 1s and footprint-dig (never hang on a wall)
    stallTicks: 120, // feet.y frozen >6s in DESCEND → loud DRILL_STALL→ERROR (silent-spin guard)
    horizonRadius: 4, // before descending, mine exposed at-or-above ore within this radius first
    surfaceSkip: 4, // ignore exposed ore until the shaft is ≥4 blocks below where it started
    multiBand: true, // after excavating a band, keep digging down to mine every further band to minY
    hazardRadius: 3, // skip a cached vein within 3 blocks of a recorded drowned column
    maxVeinDist: 300, // never hike to a vein beyond this — a prospector pass covers ~±150
    approachBlockedTicks: 60, // DESCEND step-1 walk makes no progress this long (3s) → vein unreachable → skip
    approachProgressEps: 0.15, // a step-1 tick must get ≥0.15 blocks closer to the column to count as progress
    waterContactTicks: 40, // 2s of continuous water contact at the drill column → flooded, mark drowned + skip
    digToMaxSteps: 24, // cap the dig-to-ore staircase at 24 steps before giving up the cell
    digToStallTicks: 4, // bail DIG_TO after 4 consecutive blocked (no-progress) ticks → no unreachable-A* storm
  },
  excavate: {
    bandHeight: 5, // strip-mine from the first-ore depth down this many blocks (GTCEu vein thickness)
    maxRadius: 8, // clamp the vein footprint to ±8 columns (a 17×17 box) — never strip a huge region
    rowSpacing: 2, // corridors every 2 blocks in Z (1-block gap, exposed from the side; ≤ drill.scanRadius+1)
    levelSpacing: 2, // excavation levels every 2 blocks in Y (gap covered by vein-follow reach)
    maxCells: 2000, // planned-cell budget backstop (a clamped box is well under this)
    voidProbe: 2, // skip a corridor stand-cell whose floor is air ≥2 down (a void, not a 1-step drop)
    stallTicks: 200, // no excavate progress for 10s → rescue leg / skip cell (> nav.mineBreakTimeoutTicks=80)
    rescueTicks: 200, // continuous-drive rescue budget (10s) to climb/pillar back to the corridor cell
  },
  search: {
    scanRadius: 12,
    scanHeight: 6,
    scanPerTick: 1500,
    gridStep: 20,
    cols: 4,
    rows: 4,
  },
  chop: {
    logIds: new Set(), // PACK DATA (log block ids) → src/bot/profile/pack.ts
    allowAllLogs: true,
    scanRadius: 16,
    scanYRange: 8,
    veinRadius: 2,
  },
  craft: {
    // PACK DATA (a recipe is item ids) → src/bot/profile/pack.ts. Empty here = no default craft.
    defaultChain: [],
    stepTimeoutTicks: 100,
    openRetryTicks: 10, // ~0.5s between table place/open re-fires while the read-back verify polls
  },
  interact: {
    // reach ~2.5 blocks (vanilla is 4.5, keep LOS margin); frames/displays consume the held item.
    reach: 2.5,
    timeoutTicks: 400, // GOTO + aim + verify; matches nav.gotoTimeoutTicks (the leg dominates)
    graceTicks: 8, // ~0.4s for the placement to sync back before verify
    frameRadius: 1.5, // a frame entity sits in/near its target cell; 1.5 disambiguates a tiled wall
    profiles: {
      frame: { verify: "consumed" }, // vanilla item_frame / glow_frame ENTITY
      display: { verify: "consumed" }, // mod display / pedestal / showcase
      generic: { verify: "none" }, // any block right-click (lever/button/GUI) — dispatch only
    },
  },
  hunt: {
    targets: [], // PACK DATA (entity ids) → src/bot/profile/pack.ts. Empty here = nothing is huntable.
    senseRadius: 28, // a touch under main.js's 32-block publish radius
    reach: 3.0, // vanilla melee reach
    swingEvery: 12, // ~0.6s between swings: lets a sword's attack-strength recharge to full
    chaseTimeoutTicks: 200, // 10s chasing one target before giving up and re-seeking
    lootSettleTicks: 20, // 1s lingering on the kill spot for auto-pickup
    seekGraceTicks: 40, // 2s of an empty snapshot before ending
  },
  follow: {
    senseRadius: 44, // a touch under main.js's 48-block peer publish radius
    gap: 3.0, // hold within 3 blocks of the peer (close enough to feel "with" them, no shoving)
    resumeSlack: 1.5, // only re-walk once the peer is >4.5 blocks away (kills stand-still jitter)
    lostWaitTicks: 60, // 3s of an empty/peer-gone snapshot before it logs FOLLOW_WAIT (still waits)
  },
  loot: {
    scanInterval: 40,
    scanRadius: 3,
    // ≤ the vanilla pickup reach (~1.1 blocks): arrival must OVERLAP the drop.
    pickupDist: 1,
    verifyRadius: 2.5,
    timeoutTicks: 200,
    capBreakTimeoutTicks: 240, // hand-break headroom: terracotta 125t, stone 150t + aim/latency margin
  },
  safety: {
    minHealth: 6,
    distressEnabled: true, // proactive: escape early when SUSTAINED-losing HP, not just at the floor
    distressWindow: 60, // 3s window — wide enough for ≥2 damage ticks of drown/lava/suffocation cadence
    distressDrop: 4, // ≥2 hearts lost from the recent peak within the window (paired with the event gate)
    distressMinEvents: 2, // …AND from ≥2 distinct damage ticks: one survived fall (1 event) never trips
    surfaceMaxTicks: 60, // RECOVER holds jump to surface for ≤3s before giving up on a capped pocket
    toolDurabilityHardStop: 5,
    toolDurabilitySwap: 10,
    toolSwapBlockedPhases: ["HOME", "DUMP"], // the mine mission's dump-trip legs
    stuckTicksThreshold: 600,
    stuckMovedEpsilon: 0.25,
    phaseStallTicks: 1200, // 60s of a frozen feet backstop → PAUSED (a movement phase's own timeout fires first)
    airRecoverPct: 0.3, // ~90 of 300 ticks left — surface well before drowning damage
    lowFoodLevel: 6, // sprint cuts out at 6; react here so we never actually starve
    eatTargetFood: 20, // eat back to full once we start
    eatTimeoutTicks: 200, // ~10s — a meal that hasn't fed us by now is stuck; bail
    eatBiteTicks: 35, // one bite ≈ 32 ticks; wait this long before starting the next
    foodItems: [], // PACK DATA (food item ids) → src/bot/profile/pack.ts. Empty here = the EAT leg is a no-op.
    recoverMaxAttempts: 3, // 3 recoveries in the window → give up to ERROR
    recoverBackoffWindow: 1200, // 60s; recoveries spaced wider than this don't count as a loop
    homeNoEffectLimit: 2, // a missing home spammed /home until the server kicked the bot
    homeRearmTicks: 6000, // 5 min: two /home per 5 min is far below the server's spam kick
    respawnDisplacedDist: 64, // respawn further than this from the death spot = displaced → park the mission
    voidY: -64,
    hazardSubstrings: ["lava", "fire"],
    // 1s. Measured, not guessed: on the sustain loop (live journal, 3/3 laps) the input
    // read ACTIVE for the full inputHoldTicks=10 run immediately after a long goto handed off to a
    // stationary mission — i.e. the residual of the released nav key latch outlives 6 ticks. The
    // window now runs from the bot's last drive tick (human.ts), so it must cover that residual;
    // a genuine takeover still pauses within settle+hold = 30 ticks (1.5s).
    inputSettleTicks: 20,
    inputHoldTicks: 10, // 0.5s of sustained input = a real takeover, not a lingering key release
    // 200 ticks = 10s. Bounds the OTHER arm of the settle window (a held drive key outside a
    // movement phase). That arm is unbounded by construction — every tick the key reads held it
    // re-arms — so ONE key left latched by a phase that exits without releasing it (the RECOVER
    // capped-pocket fall-through held key.jump; a plain transition releases nothing) suppressed
    // the human reflex FOREVER, and movementHeld() is horizontal-only so it never noticed. 10s is
    // far longer than any legitimate stationary hold: the ones that exist are a swim-out/surfacing
    // jump (capped at surfaceMaxTicks=60) and an eat/use hold (eatTimeoutTicks=200 does not touch
    // a drive key), so a hold past this is a latch, not work.
    driveHeldMaxTicks: 200,
    waterClutchEnabled: true,
    waterClutchMinFall: 5, // arm only for a committed ≥5-block drop (a ≤4 fall barely scratches)
    waterClutchReach: 4, // place once the floor is ≤4 below → inside the ~4.5-block place reach
    waterClutchScanDepth: 24, // deep enough to spot a long fall while staying in cache range
    waterClutchFallVy: -0.2, // clearly descending (not the up-arc of a jump)
    waterClutchRetrieveTicks: 40, // ~2s to scoop the source back up, else abandon the bucket
    waterClutchLeadClamp: 3, // lead the landing prediction by at most this many blocks
    waterBucketId: "", // PACK DATA (the filled-bucket item id) → src/bot/profile/pack.ts
    emptyBucketId: "", // PACK DATA (the emptied-bucket item id) → src/bot/profile/pack.ts
    swimOutEnabled: true,
    swimOutMaxTicks: 60, // give up after ~3s of NO upward progress (a covered pocket) → air reflex teleports
  },
  inventory: {
    fullPct: 0.85,
    checkIntervalTicks: 40,
    dumpChestGraceTicks: 40,
    junkItems: [], // PACK DATA (junk block ids) → src/bot/profile/pack.ts
  },
  // The whole sustain economy is PACK DATA — base coords, ore/ingot/fuel ids, the restock/tool
  // recipes → src/bot/profile/pack.ts. Only the batch/threshold NUMBERS are pack-neutral tunables.
  sustain: {
    basePos: { x: 0, y: 0, z: 0 },
    oreItem: "",
    ingotItem: "",
    fuelItem: "",
    mineCount: 3,
    oreKind: "",
    restockItem: "",
    restockMin: 16, // ≥16 of the restock part carried; 0 = never craft
    restockChain: [],
    toolItem: "",
    toolMin: 1, // ≥1 spare mining tool so the tool reflex always has a backup; 0 = never craft
    toolChain: [],
    storeItems: [],
  },
  telemetry: {
    // Off by default: a fresh install has no metrics store, and a dead URL only produces
    // TELEMETRY_PUSH_FAIL. To push, set it in config/local.overrides.json — docs/SETUP.md
    // § Optional: push metrics.
    pushUrl: null,
    interval: 100,
    prefix: "miner_",
  },
  chat: {
    trustedPlayers: [], // CLOSED by default — a deploy names its own operators (or "*")
    queueCapacity: 32, // ~1.6 s of a full-speed chat flood; drop-oldest past it
    denyReplyTicks: 100, // 5 s between spoken refusals to the same sender
    replyPrefix: "[gerda] ",
    maxCoordXZ: 30000000, // vanilla world border
    minCoordY: -64, // 1.20.1 build limits
    maxCoordY: 320,
    maxCount: 512, // a chat-typed `chop 99999` is a typo, not a plan
  },

  // ── top-level singletons ──
  fleetVeinClaimRadius: 8, // skip a cached vein within 8 blocks of a peer's hub-leased claim
  containerOpenGraceTicks: 40, // ~2s for a container GUI to open after useOnBlock (mirrors the DUMP chest grace)
  smeltWaitTimeoutTicks: 6000, // ~5min — a full stack of 8 smelts at ~200t/item is ~1600t; generous
  storageDepositGraceTicks: 8, // ~0.4s for a drawer deposit to sync back before verify (deferred-read gotcha)
  storageStandOffset: 1, // stand 1 block off the drawer face so the slot quadrant raycast has LOS
  // PACK DATA (the taxonomy is generic, the block ids are ours) → src/bot/profile/pack.ts.
  containerKinds: [],
  traceTicks: false, // per-tick decision tracing off by default — toggle live with `trace {on:true}`
  teleportWaitTicks: 120,
  // PACK DATA (both teleport commands depend on the server's teleport mod) → src/bot/profile/pack.ts.
  // Empty here = the HOME/RETURN legs have nothing to send. They travel together: `/back` is the
  // return half of the same FTB Essentials pair as `/home`, so a pack that renames one renames both.
  homeCommand: "",
  backCommand: "",
  teleportMinMoveBlocks: 3,
  hudEnabled: true,
  hudInterval: 10,
  worldModelPath: "./config/jsMacros/Macros/mc_world.json",
  persistInterval: 200,
  journeyMapExport: false,
  journeyMapDir: null,
  autoStartMission: null, // boot IDLE; await an explicit mission_start (no auto-mine on reload)
  logLevel: "INFO",
  fxDedupeTicks: 200, // 10s
};

/** DEEP-partial override shape for makeConfig: each section may be overridden with a subset of its
 *  own keys (e.g. `{ nav: { sprint: false } }`), and each top-level singleton with its value. A
 *  provided section is MERGED over the default section (siblings kept), NOT replaced wholesale. */
export type ConfigOverrides = {
  [K in keyof Config]?: Config[K] extends readonly unknown[]
    ? Config[K]
    : Config[K] extends object
      ? Partial<Config[K]>
      : Config[K];
};

function isSection(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Set);
}

/** Build a Config from DEFAULT_CONFIG + `layers`, applied LEFT-TO-RIGHT and DEEP-merged one level
 *  (per section): a section override contributes only its named keys, so a test can flip
 *  `{ nav: { sprint: false } }` without dropping the other nav defaults. A top-level singleton (or
 *  a non-plain-object like an array/Set) is replaced wholesale. ONE level is the whole depth: a
 *  sub-object NESTED inside a section is a value, so it is replaced, not merged. No section has
 *  that shape today — nest one and this stops doing what its name suggests.
 *
 *  LAYERS, not one blob: the pack profile sets `ore.ids` while a caller sets `ore.minPickRank`, and
 *  merging the two into a flat overrides object first would let the later top-level spread drop the
 *  earlier layer's whole section. Merging them CUMULATIVELY (each layer over the accumulated
 *  result) is the only shape where both survive. `makeConfig()` with no layers = DEFAULT_CONFIG. */
export function makeConfig(...layers: ConfigOverrides[]): Config {
  const out: Record<string, unknown> = { ...DEFAULT_CONFIG };
  for (const overrides of layers) {
    for (const [key, ov] of Object.entries(overrides)) {
      if (ov === undefined) continue;
      const base = out[key];
      out[key] = isSection(base) && isSection(ov) ? { ...base, ...ov } : ov;
    }
  }
  // reliability-ok: out is DEFAULT_CONFIG (a full Config) with each key replaced by a value of its
  // own type from the typed ConfigOverrides layers, so the shape is complete — the single
  // narrowing point.
  return out as unknown as Config;
}

/** Validate an EXTERNAL overrides blob (a fork's build-time `config/local.overrides.json`, parsed
 *  from JSON) before makeConfig merges it: it must be a plain object whose every top-level key names
 *  a Config section/singleton. An unknown key is a silent typo that would merge in and never take
 *  effect — so fail LOUD naming the key and the source. Deep values are the fork author's to own
 *  (merged one level deep by makeConfig); only the top-level shape is gated here. `source` names the
 *  origin in the error message. */
export function assertConfigOverrideKeys(
  ov: unknown,
  source = "config overrides",
): ConfigOverrides {
  if (!isSection(ov)) {
    const got = ov === null ? "null" : Array.isArray(ov) ? "array" : typeof ov;
    throw new ContractError(`${source}: expected a JSON object, got ${got}`);
  }
  for (const key of Object.keys(ov)) {
    if (!(key in DEFAULT_CONFIG)) {
      throw new ContractError(
        `${source}: unknown config key "${key}" (not a key of DEFAULT_CONFIG)`,
      );
    }
  }
  // reliability-ok: every own key is verified to be a Config key above; deep values are trusted
  // (the fork author owns them) and re-merged per-section by makeConfig — the single narrowing point.
  return ov as ConfigOverrides;
}
