// Movement types — the extensible registry of single-step moves the planner explores
// ("movement types as a registry, not a switch"). Each declares whether it applies
// from a cell in a cardinal/diagonal direction, and at what tick cost. Adding bridge /
// pillarUp later = one entry here + the planner picks it up, no core change. Pure (over a
// BlockReader); jsMacros-free. Costs come from core/prim/movement-physics.
//
// `apply` returns a LIST of moves (0..N) for one (from, direction): most moves yield at most
// one, but parkour yields one per legal jump distance — so the registry stays a flat
// "from + direction → moves" function and neighbors() just flattens.
import {
  JUMP_ONE_BLOCK_TICKS,
  LADDER_ONE_BLOCK_TICKS,
  SPRINT_ONE_BLOCK_TICKS,
  WALK_ONE_BLOCK_TICKS,
  canSurviveFall,
  fallTicks,
} from "@/core/prim/movement-physics";
import type { Vec3 } from "@/core/runtime/types";
import {
  type BlockReader,
  breakableSolid,
  climbableAt,
  groundUnder,
  hazardAt,
  passableCell,
  standableSurface,
  walkableAt,
} from "@/shared/domain/senses";

export interface PlanOpts {
  /** Most blocks we'll plan to fall in one dropDown move (search bound). */
  readonly maxDrop: number;
  /** Health points of fall damage tolerated (0 = refuse any damaging drop). */
  readonly maxFallDamage: number;
  /** Enable the parkour move (sprint-jump across a gap). Off by default so existing planner
   *  behaviour is unchanged; the navigator turns it on via cfg.nav.parkour. */
  readonly parkour?: boolean;
  /** Longest parkour jump distance in cells (land `maxParkour` cells away over a `maxParkour-1`
   *  air gap). Baritone: 4 sprinting / 3 walking. Ignored unless `parkour`. */
  readonly maxParkour?: number;
  /** Per-jump tick bias added to a parkour cost (Baritone's jumpPenalty) so a flat walk wins
   *  when one exists. Ignored unless `parkour`. */
  readonly parkourPenalty?: number;
  /** Enable the pillarUp move (rise one block in place by placing filler under the feet). The
   *  PURE planner can't read inventory, so the navigator sets this from the live bag — only true
   *  when a filler block is actually carried. Off by default. */
  readonly canPillar?: boolean;
  /** Per-block placement cost bias on a pillarUp (Baritone blockPlacementPenalty), so a walking
   *  route up wins when one exists. Ignored unless `canPillar`. */
  readonly pillarPenalty?: number;
  /** Enable MINING moves (mineTraverse / mineAscend — DIG_TO as movement, Baritone
   *  MovementTraverse/Ascend's mining case): the planner may break a solid breakable cell to
   *  advance. Off by default (the executor must break-then-step, so it's gated like canPillar);
   *  the navigator turns it on via cfg.nav.mine. */
  readonly mine?: boolean;
  /** Per-block break cost (ticks) added for each solid cell a mine-move must clear (Baritone
   *  CalculationContext.costOfBreaking). A flat estimate for now — high enough that an open walk
   *  route wins, low enough that a short tunnel beats a long detour. Ignored unless `mine`. */
  readonly breakCost?: number;
  /** Enable the BRIDGE move (bridgePlace — cross a floor gap by laying filler under the next cell,
   *  the constructive counterpart to the fall-damage veto). Off by default (the executor must
   *  place-then-step, gated like canPillar/mine); the navigator turns it on via cfg.nav.bridge when
   *  filler is carried. OPTIMISTIC: it assumes the floor it places becomes support for the next
   *  cell, so a multi-cell bridge plans as a chain (every reachable A* node already stands on a
   *  real-or-just-placed floor — no static support check needed; the executor confirms each place). */
  readonly bridge?: boolean;
  /** Per-block placement cost bias on a bridgePlace (Baritone blockPlacementPenalty), so a route
   *  that spends no filler wins when one exists. Ignored unless `bridge`. */
  readonly bridgePenalty?: number;
  /** Longest gap (cells) a bridgePlace will START spanning: a bridge edge is offered ONLY when a real
   *  landing exists within this many cells ahead. CRITICAL search bound — without it the optimistic
   *  bridge makes EVERY cell over an open void "reachable", so A* explores the whole void to its
   *  expansion cap, and each cold-cache cell is a live getBlock → a render-thread-contending read storm
   *  that hitches the game. Capping the reach keeps the frontier finite over a void. Ignored unless
   *  `bridge`. Defaults to a small value if unset. */
  readonly bridgeMaxRun?: number;
  /** Enable the waterDrop move (deliberately dive down a deep shaft an ordinary drop would refuse,
   *  trusting the emergency water-clutch reflex to place water and negate the fall). The PROACTIVE
   *  use of the clutch: a cheap descent that beats mining a staircase down. The pure planner can't
   *  read inventory, so the navigator sets this only when a water bucket is actually carried. Off by
   *  default. Pairs ONLY with a fatal-but-finite drop (a safe drop is dropDownSafe's, cheaper). */
  readonly waterDrop?: boolean;
  /** Deepest shaft (cells) a waterDrop will dive — the search bound (like bridgeMaxRun): water
   *  negates ANY fall, but an unbounded downward scan is a getBlock storm. Ignored unless waterDrop. */
  readonly waterDropMaxDrop?: number;
  /** Tick bias added to a waterDrop (the bucket place+scoop cycle + a bias so a safe walk/drop route
   *  wins when one exists — the bot only dives when diving is genuinely cheaper). Ignored unless
   *  waterDrop. */
  readonly waterDropPenalty?: number;
  /** Enable the LADDER moves (ladderEnter / ladderUp / ladderDown — ride an existing ladder/vine to
   *  reach a different level WITHOUT placing or mining, the clean non-destructive answer to "the
   *  chest is on the floor above"). Unlike pillar/bridge/mine these spend nothing and need no bag
   *  check — they only apply where a climbable block already EXISTS — so the navigator can leave them
   *  on (cfg.nav.ladder). The planner prefers a ladder over a pillar (ladder is cheaper) but a flat
   *  walk over a ladder (a climb costs more than a step). Off by default so the base move set is
   *  unchanged. */
  readonly ladder?: boolean;
  /** Per-block-of-drop tick bias added to every DESCENDING move (dropDownSafe / diagonalDescend) — the
   *  "amortized reversal cost". A drop is cheap and unconditional (gravity), but climbing back is dear
   *  and conditional (pillar needs filler, ladder needs a ladder). A* over the raw cost therefore dives
   *  freely into a ravine and can't get back out (live: a surface search sank a bot 30 blocks
   *  into a pit). Charging each drop a fraction of its own reversal up front (mirrors Baritone's high
   *  blockPlacementPenalty "to conserve blocks") makes a flat/around/bridge route out-bid an unnecessary
   *  descent, while a genuinely-downward goal still pays it and goes. Goal-agnostic (penalizes ALL drops
   *  by depth) so it needs no goal reference in the move. The hard recoverability guard lives in the
   *  executor (greedy-nav descent veto); this is the soft planner-side bias. Defaults to 0 (off). */
  readonly descentPenalty?: number;
  /** X/Z columns to treat as IMPASSABLE regardless of geometry (peer-as-obstacle). A peer
   *  bot standing in the world reads as AIR to the block reader, so without this the planner routes
   *  straight through a teammate and the two shove each other off course. Keys are `columnKey(x,z)`;
   *  whole-column because a peer occupies ~2 cells of height and jumps. Only move TARGETS are
   *  filtered — planning OUT of an avoided column (peer walked into us) must stay legal. The
   *  navigator rebuilds the set from the live peer snapshot every plan/edge check, so the route
   *  cache's edgeValid also re-vetoes a cached step a peer has since walked into. */
  readonly avoid?: ReadonlySet<string>;
}

/** The `PlanOpts.avoid` key for an X/Z column. */
export function columnKey(x: number, z: number): string {
  return `${x},${z}`;
}

export const DEFAULT_PLAN_OPTS: PlanOpts = { maxDrop: 4, maxFallDamage: 0 };

/** The closed set of move policies the registry can emit. Each `MovementType.kind` is one
 *  of these; the planner threads the kind that ARRIVED at each path cell through to the executor, which
 *  dispatches on it (a `switch(kind)`) instead of re-deriving the move from `feet→next` geometry. Adding
 *  a movement type = one new literal here + the entry below + an executor case. */
export type MoveKind =
  | "traverse"
  | "stepUp"
  | "dropDownSafe"
  | "waterDrop"
  | "diagonal"
  | "diagonalAscend"
  | "diagonalDescend"
  | "parkour"
  | "mineTraverse"
  | "mineAscend"
  | "mineDescend"
  | "bridgePlace"
  | "pillarUp"
  | "mineDown"
  | "ladderEnter"
  | "ladderUp"
  | "ladderDown";

export interface MoveResult {
  readonly to: Vec3;
  readonly cost: number;
  readonly kind: MoveKind;
}

export interface MovementType {
  readonly kind: MoveKind;
  /** True → this move steps DIAGONALLY (both dx,dz = ±1); false/absent → a cardinal step (exactly
   *  one of dx/dz is ±1). neighbors() feeds each move the matching direction set. */
  readonly diagonal?: boolean;
  /** True → this move is VERTICAL (straight up/down, no horizontal offset). neighbors() calls it
   *  ONCE with dx=dz=0 instead of iterating the cardinal/diagonal direction set. */
  readonly vertical?: boolean;
  /** Apply from `from` in a direction (cardinal or diagonal per `diagonal`, or 0,0 if `vertical`).
   *  Returns 0..N destination cells + costs reachable by THIS move in that direction. */
  apply(reader: BlockReader, from: Vec3, dx: number, dz: number, opts: PlanOpts): MoveResult[];
}

/** Walk one block onto an adjacent same-level standable cell. */
const traverse: MovementType = {
  kind: "traverse",
  apply(reader, from, dx, dz) {
    const to = { x: from.x + dx, y: from.y, z: from.z + dz };
    if (!walkableAt(reader, to)) return [];
    return [{ to, cost: WALK_ONE_BLOCK_TICKS, kind: "traverse" }];
  },
};

/** Jump up one block onto an adjacent +1 cell (needs head clearance above the start). */
const stepUp: MovementType = {
  kind: "stepUp",
  apply(reader, from, dx, dz) {
    // clearance to jump: the cell two above the feet must be open
    if (!passableCell(reader, { x: from.x, y: from.y + 2, z: from.z })) return [];
    const to = { x: from.x + dx, y: from.y + 1, z: from.z + dz };
    if (!walkableAt(reader, to)) return [];
    return [{ to, cost: WALK_ONE_BLOCK_TICKS + JUMP_ONE_BLOCK_TICKS, kind: "stepUp" }];
  },
};

/** Step into an adjacent open column and fall to the ground below, if the drop is safe. */
const dropDownSafe: MovementType = {
  kind: "dropDownSafe",
  apply(reader, from, dx, dz, opts) {
    const ex = from.x + dx;
    const ez = from.z + dz;
    // must be able to enter the column (else it's a wall, not a ledge)
    if (!passableCell(reader, { x: ex, y: from.y, z: ez })) return [];
    if (!passableCell(reader, { x: ex, y: from.y + 1, z: ez })) return [];
    const ground = groundUnder(reader, { x: ex, y: from.y, z: ez }, opts.maxDrop + 1);
    if (!ground || ground.drop < 1 || ground.drop > opts.maxDrop) return [];
    // Unaided survivable drop only — a clutch dive is a separate, costed move (waterDrop), so this
    // cheap drop deliberately passes clutch OFF (canSurviveFall header explains the split).
    if (!canSurviveFall(ground.drop, { maxFallDamage: opts.maxFallDamage })) return [];
    const to = { x: ex, y: ground.y + 1, z: ez };
    if (!walkableAt(reader, to)) return [];
    const reversal = (opts.descentPenalty ?? 0) * ground.drop;
    return [
      { to, cost: WALK_ONE_BLOCK_TICKS + fallTicks(ground.drop) + reversal, kind: "dropDownSafe" },
    ];
  },
};

/** Step into an adjacent open column and DIVE — a fall an ordinary drop would refuse (too deep to
 *  survive), trusting the emergency water-clutch reflex to place water at the bottom and negate it.
 *  The proactive use of the clutch: a cheap descent vs. mining a staircase down. Mirrors dropDownSafe
 *  but takes ONLY the unsafe drops (a safe one is dropDownSafe's, cheaper) and never dives into a
 *  bottomless void or onto a hazard floor (water saves you from the fall, not from lava). Gated on
 *  opts.waterDrop (the navigator sets it only when a water bucket is carried — the clutch's fuel).
 *  The executor needs NO special case: `to` is the safe LANDING (floor directly below), so the walk
 *  driver's step-hazard veto passes, it walks the bot off the ledge, and the clutch (an independent
 *  reflex) catches the fall. */
const waterDrop: MovementType = {
  kind: "waterDrop",
  apply(reader, from, dx, dz, opts) {
    if (!opts.waterDrop) return [];
    const ex = from.x + dx;
    const ez = from.z + dz;
    // must be able to enter the column (else it's a wall, not a ledge) — same gate as dropDownSafe
    if (!passableCell(reader, { x: ex, y: from.y, z: ez })) return [];
    if (!passableCell(reader, { x: ex, y: from.y + 1, z: ez })) return [];
    const ground = groundUnder(reader, { x: ex, y: from.y, z: ez }, opts.waterDropMaxDrop ?? 48);
    if (!ground) return []; // bottomless → never (can't clutch onto nothing)
    // ONLY take the drops dropDownSafe won't: a safe (unaided-survivable) drop is cheaper there, so a
    // waterDrop is offered strictly for a fall that WOULD damage — else we'd spend a bucket cycle for nothing.
    if (canSurviveFall(ground.drop, { maxFallDamage: opts.maxFallDamage })) return [];
    // water negates the fall, not a lava/magma landing — refuse a hazardous floor
    if (hazardAt(reader, { x: ex, y: ground.y, z: ez })) return [];
    const to = { x: ex, y: ground.y + 1, z: ez };
    if (!walkableAt(reader, to)) return [];
    return [
      {
        to,
        cost: WALK_ONE_BLOCK_TICKS + fallTicks(ground.drop) + (opts.waterDropPenalty ?? 0),
        kind: "waterDrop",
      },
    ];
  },
};

/** Walk one block DIAGONALLY onto a same-level standable cell. Derived from Baritone
 *  MovementDiagonal: legal only if BOTH orthogonal corner cells are passable (feet + head) — else
 *  the 0.6-wide player clips the corner block. Cost = WALK × √2 (matches the octile heuristic, so
 *  the planner's estimate is exact on open ground). Diagonal ascend/descend are a later addition. */
const diagonal: MovementType = {
  kind: "diagonal",
  diagonal: true,
  apply(reader, from, dx, dz) {
    const to = { x: from.x + dx, y: from.y, z: from.z + dz };
    if (!walkableAt(reader, to)) return [];
    // Corner-cut guard: the two cells we'd graze (one step along x, one along z) must be open at
    // BOTH feet and head height, or the player snags the corner. (Baritone also allows mining a
    // corner; we require clear — a planner that mines diagonals is a later refinement.)
    const ax = from.x + dx;
    const az = from.z + dz;
    if (!passableCell(reader, { x: ax, y: from.y, z: from.z })) return [];
    if (!passableCell(reader, { x: ax, y: from.y + 1, z: from.z })) return [];
    if (!passableCell(reader, { x: from.x, y: from.y, z: az })) return [];
    if (!passableCell(reader, { x: from.x, y: from.y + 1, z: az })) return [];
    return [{ to, cost: WALK_ONE_BLOCK_TICKS * Math.SQRT2, kind: "diagonal" }];
  },
};

/** Step DIAGONALLY and UP one block (a diagonal stepUp) — Baritone MovementDiagonal's ascending
 *  case. Needs jump headroom over the take-off and BOTH orthogonal corner columns clear through the
 *  rise (feet/head/jump levels) so the player doesn't clip while going up-and-over. Cost = WALK×√2 +
 *  JUMP. Driven by the existing executor (next.y>feet.y ⇒ jump, faces the diagonal). */
const diagonalAscend: MovementType = {
  kind: "diagonalAscend",
  diagonal: true,
  apply(reader, from, dx, dz) {
    if (!passableCell(reader, { x: from.x, y: from.y + 2, z: from.z })) return []; // jump headroom
    const to = { x: from.x + dx, y: from.y + 1, z: from.z + dz };
    if (!walkableAt(reader, to)) return [];
    // Both orthogonal corners clear at feet/head/jump height — no clip while rising past them.
    for (const c of [
      { x: from.x + dx, z: from.z },
      { x: from.x, z: from.z + dz },
    ]) {
      if (!passableCell(reader, { x: c.x, y: from.y, z: c.z })) return [];
      if (!passableCell(reader, { x: c.x, y: from.y + 1, z: c.z })) return [];
      if (!passableCell(reader, { x: c.x, y: from.y + 2, z: c.z })) return [];
    }
    return [
      {
        to,
        cost: WALK_ONE_BLOCK_TICKS * Math.SQRT2 + JUMP_ONE_BLOCK_TICKS,
        kind: "diagonalAscend",
      },
    ];
  },
};

/** Step DIAGONALLY and DOWN one block (a diagonal step-down) — Baritone MovementDiagonal's
 *  descending case. Same corner-cut guard as a flat diagonal (cleared at the start level); the
 *  destination is one lower. Cost = WALK×√2 + the 1-block fall. Driven by the existing executor
 *  (next.y<feet.y ⇒ a walk, faces the diagonal). */
const diagonalDescend: MovementType = {
  kind: "diagonalDescend",
  diagonal: true,
  apply(reader, from, dx, dz, opts) {
    const to = { x: from.x + dx, y: from.y - 1, z: from.z + dz };
    if (!walkableAt(reader, to)) return [];
    for (const c of [
      { x: from.x + dx, z: from.z },
      { x: from.x, z: from.z + dz },
    ]) {
      if (!passableCell(reader, { x: c.x, y: from.y, z: c.z })) return [];
      if (!passableCell(reader, { x: c.x, y: from.y + 1, z: c.z })) return [];
      // Catch-ledge guard (live-found): a cardinal-corner cell that has a STANDABLE
      // floor at the FROM level (its top == from's feet) keeps the 0.6-wide box supported at the
      // upper level through the whole diagonal — the box rides that ledge and never tips into the
      // lower destination, so the walk driver holds forward forever without advancing (a real
      // leg-stall on a snow-plateau edge). A clean diagonal descend has BOTH corners dropping away
      // (no from-level support) and tips reliably. When a corner catches, REJECT here — the cardinal
      // decomposition (drop straight, then traverse — or traverse, then drop) is always available
      // (the catching corner is itself walkable at the from level) and the executor drives those
      // reliably, so nothing is stranded; we only trade √2 for two cardinal steps.
      if (standableSurface(reader, { x: c.x, y: from.y - 1, z: c.z })) return [];
    }
    return [
      {
        to,
        cost: WALK_ONE_BLOCK_TICKS * Math.SQRT2 + fallTicks(1) + (opts.descentPenalty ?? 0),
        kind: "diagonalDescend",
      },
    ];
  },
};

/** Sprint-jump straight ACROSS a horizontal gap, landing 2–4 cells away at the SAME level —
 *  modelled on Baritone's parkour move. The point: don't drop into a pit and then have to
 *  climb back out (the surface-traversal failure); jump it. Legal when every cell over the gap is
 *  an OPEN drop (passable feet+head, no floor directly under), the take-off has head clearance,
 *  and the landing is standable. Cost: dist 2→WALK×2, 3→WALK×3,
 *  4→SPRINT×4, plus a small jump penalty so a flat walk wins when one exists. Flat-only for now;
 *  descending parkour is a later refinement. */
const parkour: MovementType = {
  kind: "parkour",
  apply(reader, from, dx, dz, opts) {
    if (!opts.parkour) return [];
    const maxJump = Math.min(opts.maxParkour ?? 0, 4);
    if (maxJump < 2) return [];
    // Take-off head clearance: room above the feet to leave the ground.
    if (!passableCell(reader, { x: from.x, y: from.y + 2, z: from.z })) return [];
    const penalty = opts.parkourPenalty ?? 0;
    const out: MoveResult[] = [];
    for (let dist = 2; dist <= maxJump; dist++) {
      // Every cell over the gap (1..dist-1) must be an OPEN drop: passable at feet + head, and NO
      // standable floor directly below (else it's a walk/step, not a jump — let traverse own it).
      let clear = true;
      for (let d = 1; d < dist; d++) {
        const gx = from.x + dx * d;
        const gz = from.z + dz * d;
        if (!passableCell(reader, { x: gx, y: from.y, z: gz })) {
          clear = false;
          break;
        }
        if (!passableCell(reader, { x: gx, y: from.y + 1, z: gz })) {
          clear = false;
          break;
        }
        if (standableSurface(reader, { x: gx, y: from.y - 1, z: gz })) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      const to = { x: from.x + dx * dist, y: from.y, z: from.z + dz * dist };
      if (!walkableAt(reader, to)) continue;
      const base = dist >= 4 ? SPRINT_ONE_BLOCK_TICKS * dist : WALK_ONE_BLOCK_TICKS * dist;
      out.push({ to, cost: base + penalty, kind: "parkour" });
    }
    return out;
  },
};

/** Count how many of `cells` are solid blocks the miner must break to pass, or `null` if ANY is
 *  unbreakable (bedrock/hazard/liquid) — meaning the whole mine-move is illegal. An already-open
 *  (passable) cell costs nothing; a solid breakable one counts 1. Shared by the mine moves. */
function countBreaks(reader: BlockReader, cells: readonly Vec3[]): number | null {
  let n = 0;
  for (const c of cells) {
    if (passableCell(reader, c)) continue;
    if (!breakableSolid(reader, c)) return null;
    n++;
  }
  return n;
}

/** Mine THROUGH a solid breakable cell to advance one block at the SAME level — DIG_TO as a
 *  movement (Baritone MovementTraverse's mining case). The destination floor (to.y-1) must already
 *  be standable (we tunnel, not bridge); the feet + head cells are broken if solid. Gated behind
 *  `opts.mine` (the executor must break-then-step), and only offered when ≥1 cell actually needs
 *  breaking — an already-open step belongs to `traverse`. Cost = WALK + breakCost per cell cleared.
 *  Refuses if any cell is unbreakable/hazard (breakableSolid=false). */
const mineTraverse: MovementType = {
  kind: "mineTraverse",
  apply(reader, from, dx, dz, opts) {
    if (!opts.mine) return [];
    const to = { x: from.x + dx, y: from.y, z: from.z + dz };
    if (!standableSurface(reader, { x: to.x, y: to.y - 1, z: to.z })) return [];
    const breaks = countBreaks(reader, [to, { x: to.x, y: to.y + 1, z: to.z }]);
    if (breaks === null || breaks === 0) return []; // unbreakable, or already open (traverse owns)
    return [
      { to, cost: WALK_ONE_BLOCK_TICKS + breaks * (opts.breakCost ?? 0), kind: "mineTraverse" },
    ];
  },
};

/** Mine UP a staircase tread to advance one block +1 in Y — DIG_TO climbing to an above ore
 *  (Baritone MovementAscend's mining case). Breaks the destination feet + head and the headroom
 *  over the current stand, then jumps onto the SOLID tread (to.y-1, deliberately not broken). Gated
 *  + offered only when ≥1 cell needs breaking (an open step-up belongs to `stepUp`). Cost = WALK +
 *  JUMP + breakCost per cell cleared. */
const mineAscend: MovementType = {
  kind: "mineAscend",
  apply(reader, from, dx, dz, opts) {
    if (!opts.mine) return [];
    const to = { x: from.x + dx, y: from.y + 1, z: from.z + dz };
    if (!standableSurface(reader, { x: to.x, y: from.y, z: to.z })) return []; // the tread to climb
    const breaks = countBreaks(reader, [
      to,
      { x: to.x, y: to.y + 1, z: to.z }, // destination head
      { x: from.x, y: from.y + 2, z: from.z }, // headroom to jump up through
    ]);
    if (breaks === null || breaks === 0) return [];
    return [
      {
        to,
        cost: WALK_ONE_BLOCK_TICKS + JUMP_ONE_BLOCK_TICKS + breaks * (opts.breakCost ?? 0),
        kind: "mineAscend",
      },
    ];
  },
};

/** Mine DOWN a staircase tread to advance one block −1 in Y — a descending dig-stair, the mirror of
 *  mineAscend (Baritone MovementDescend's mining case). A SAFE stepped descent through rock as an
 *  alternative to the vertical mineDown shaft: break the destination feet + head (the two cells the
 *  body enters stepping down-forward) and step down onto the SOLID tread below the destination
 *  (to.y-1, deliberately NOT broken — it's what we land on). Gated behind `opts.mine`; offered only
 *  when ≥1 cell needs breaking (an already-open down-step belongs to dropDownSafe). Refuses if any
 *  cell is unbreakable/hazard. The executor needs NO new branch — driveMineStep clears the occupancy
 *  cells and the walk driver steps forward, gravity dropping the bot onto the tread (same as
 *  mineTraverse). Cost = walk + a 1-block fall + breakCost per cell cleared. */
const mineDescend: MovementType = {
  kind: "mineDescend",
  apply(reader, from, dx, dz, opts) {
    if (!opts.mine) return [];
    const to = { x: from.x + dx, y: from.y - 1, z: from.z + dz };
    if (!standableSurface(reader, { x: to.x, y: to.y - 1, z: to.z })) return []; // the tread to land on
    const breaks = countBreaks(reader, [to, { x: to.x, y: to.y + 1, z: to.z }]);
    if (breaks === null || breaks === 0) return []; // unbreakable, or already open (dropDownSafe owns)
    return [
      {
        to,
        cost: WALK_ONE_BLOCK_TICKS + fallTicks(1) + breaks * (opts.breakCost ?? 0),
        kind: "mineDescend",
      },
    ];
  },
};

/** Cross a same-level floor GAP by laying a filler block under the next cell, then walking onto it
 *  — BRIDGE as a movement (Baritone MovementTraverse's place case), the constructive counterpart to
 *  the fall-damage veto: where dropDownSafe refuses an unsafe drop, this places a floor and crosses.
 *  Legal when the next cell + its head are passable (a wall is the digger's job), and the floor under
 *  it is NOT standable (a real gap) with NO safe landing below (else dropDownSafe owns it — don't
 *  waste filler). OPTIMISTIC: NO check that the bot has a block to place against — every reachable A*
 *  node already stands on a floor (real, or just-placed by the preceding bridgePlace), so support is
 *  guaranteed and multi-cell bridges plan as a chain. The executor confirms each placement live; an
 *  unplaceable cell fails there. Gated behind `opts.bridge`. Cost = WALK + placePenalty so a no-filler
 *  route wins when one exists; the planner only bridges a gap too wide to parkour. */
const bridgePlace: MovementType = {
  kind: "bridgePlace",
  apply(reader, from, dx, dz, opts) {
    if (!opts.bridge) return [];
    const to = { x: from.x + dx, y: from.y, z: from.z + dz };
    if (!passableCell(reader, to)) return []; // a wall ahead → the digger's job, not the bridger's
    if (!passableCell(reader, { x: to.x, y: to.y + 1, z: to.z })) return [];
    if (standableSurface(reader, { x: to.x, y: to.y - 1, z: to.z })) return []; // floor there → traverse
    // Only bridge a gap with NO safe landing — a short safe drop belongs to dropDownSafe.
    const ground = groundUnder(reader, to, opts.maxDrop + 1);
    if (ground && canSurviveFall(ground.drop, { maxFallDamage: opts.maxFallDamage })) return [];
    // Search bound: only start a bridge that REACHES real ground within bridgeMaxRun cells ahead.
    // Over an open void no landing is found in range → no edge → the A* frontier can't spread
    // across the whole void (the getBlock-storm hitch). A crossable gap of width ≤ bridgeMaxRun
    // still chains: each successive cell is closer to the same landing, so it stays in range the
    // whole way over. The landing counts at the bridge level (to.y) OR one block UP (to.y+1, a
    // step-up landing): a pickaxe mines TOP-face standing ore.y+1 ABOVE the ore, so an across-void
    // ore's only foothold is its top, one above the bridge plane — accepting a +1 landfall lets the
    // chain reach the cell adjacent to it, where the always-on stepUp move finishes the climb
    // (bridge+stepUp composition). It ALSO counts within a SAFE DROP below (to.y-1 …
    // to.y-safeDrop): a ravine's far rim usually sits a little LOWER than the bridge plane, so the
    // bot bridges FLAT to the rim then dropDownSafe onto it (bridge + safe-drop composition = "drop
    // down a couple of blocks, then bridge forward"). Without this the landfall search only ever
    // saw an equal-or-higher far side and refused to start over a lower one.
    const maxRun = opts.bridgeMaxRun ?? 4;
    let landfall = false;
    outer: for (let d = 1; d <= maxRun; d++) {
      const ax = from.x + dx * (1 + d);
      const az = from.z + dz * (1 + d);
      if (walkableAt(reader, { x: ax, y: to.y + 1, z: az })) {
        landfall = true;
        break;
      }
      // to.y and every level down that dropDownSafe can actually finish (within maxDrop AND 0-damage).
      for (
        let down = 0;
        down <= opts.maxDrop && canSurviveFall(down, { maxFallDamage: opts.maxFallDamage });
        down++
      ) {
        if (walkableAt(reader, { x: ax, y: to.y - down, z: az })) {
          landfall = true;
          break outer;
        }
      }
    }
    if (!landfall) return [];
    return [{ to, cost: WALK_ONE_BLOCK_TICKS + (opts.bridgePenalty ?? 0), kind: "bridgePlace" }];
  },
};

/** Rise ONE block in place by jump-placing a filler block under the feet (the classic Minecraft
 *  pillar), modelled on Baritone's pillar move. This is what lets the navigator climb a SHEER
 *  vertical wall (a stepUp needs an adjacent +1 cell; a pillar makes its own floor). Vertical: the
 *  destination is straight up (from.y+1, same X/Z). Legal only when `canPillar` (the navigator
 *  confirmed filler in the bag — the pure planner can't read inventory) and there is room to rise
 *  and stand: the new feet (from.y+1) and head (from.y+2) cells must be clear. We do NOT require a
 *  pre-existing floor at the destination — the move CREATES it (places at from.y, under the new
 *  feet, which is the cell the player currently occupies, so it's reachable). Cost = the jump +
 *  a placement penalty (Baritone blockPlacementPenalty) so any walking route up is preferred. The
 *  executor (greedy-nav pillarStep) drives the jump→apex→place→settle cycle. */
const pillarUp: MovementType = {
  kind: "pillarUp",
  vertical: true,
  apply(reader, from, _dx, _dz, opts) {
    if (!opts.canPillar) return [];
    // Room to rise into and stand: feet + head of the new (one-up) standing position must be open.
    // (No walkableAt here — the floor under the new feet does not exist yet; we place it.)
    if (!passableCell(reader, { x: from.x, y: from.y + 1, z: from.z })) return [];
    if (!passableCell(reader, { x: from.x, y: from.y + 2, z: from.z })) return [];
    const to = { x: from.x, y: from.y + 1, z: from.z };
    return [{ to, cost: JUMP_ONE_BLOCK_TICKS + (opts.pillarPenalty ?? 0), kind: "pillarUp" }];
  },
};

/** Descend ONE block straight down by mining the floor under the feet, then dropping into it —
 *  modelled on Baritone's downward move (the digging case). The vertical counterpart to pillarUp:
 *  where pillarUp PLACES a floor to rise a sheer wall, this BREAKS the floor to sink, letting the
 *  navigator bore straight down through solid rock toward an at-or-below goal (a shaft) as a general
 *  A* move — not only inside the drill's dedicated DESCEND/DIG_TO. Vertical: the destination is
 *  straight down (from.y-1, same X/Z); that very cell IS the floor block we break, and gravity drops
 *  the bot onto whatever's below. Gated behind `opts.mine` (the executor must break-then-drop, like
 *  the other mining moves). Legal only when the floor is a breakable solid AND there's a standable
 *  surface ONE further down to land on — so a single break is a controlled 1-block descent, never
 *  opening a deep void (a safe drop is dropDownSafe's job; an unsafe one the fall-damage veto's).
 *  Cost = the break + a 1-block fall (so any walking route down — stairs, a safe ledge — wins). */
const mineDown: MovementType = {
  kind: "mineDown",
  vertical: true,
  apply(reader, from, _dx, _dz, opts) {
    if (!opts.mine) return [];
    const floor = { x: from.x, y: from.y - 1, z: from.z };
    if (!breakableSolid(reader, floor)) return []; // already open (dropDownSafe owns) or unbreakable/hazard
    if (!standableSurface(reader, { x: from.x, y: from.y - 2, z: from.z })) return []; // land one down
    return [{ to: floor, cost: fallTicks(1) + (opts.breakCost ?? 0), kind: "mineDown" }];
  },
};

/** A cell a climbing body can occupy as it enters/rides a ladder: ordinary clear air OR another
 *  climbable cell (a head/feet may be in a ladder block while climbing). */
function clearForClimb(reader: BlockReader, pos: Vec3): boolean {
  return passableCell(reader, pos) || climbableAt(reader, pos);
}

/** Step horizontally OFF a standable cell INTO an adjacent climbable cell at the same level — mounting
 *  the bottom (or a mid-height side entry) of a ladder/vine. The destination is a ladder cell (not a
 *  walkable floor), so traverse can't own it; this move makes the climbable column reachable as an A*
 *  node, from which ladderUp/ladderDown (or a traverse back off) continue. Legal when the target cell
 *  is climbable and its head is clear. No floor check on the target — the ladder supports the body.
 *  Cost = a walk step (mounting is a step, not yet a climb). Gated on opts.ladder. */
const ladderEnter: MovementType = {
  kind: "ladderEnter",
  apply(reader, from, dx, dz, opts) {
    if (!opts.ladder) return [];
    const to = { x: from.x + dx, y: from.y, z: from.z + dz };
    if (!climbableAt(reader, to)) return [];
    if (!clearForClimb(reader, { x: to.x, y: to.y + 1, z: to.z })) return []; // head clearance
    return [{ to, cost: WALK_ONE_BLOCK_TICKS, kind: "ladderEnter" }];
  },
};

/** Climb UP one block of a ladder/vine — the non-destructive counterpart to pillarUp (pillar PLACES a
 *  floor to rise; this rides an existing ladder). Vertical: destination straight up. Legal when the
 *  body is ON a climbable (from) and the cell above is EITHER another climbable (continue up) OR a
 *  walkable stand whose floor is this ladder — the TOP-OUT: mantle off the last rung onto the cell
 *  above it, standing ON TOP of the ladder. The top-out is load-bearing for dismounting: from the stand
 *  a flat traverse walks off onto the adjacent floor, whereas the only other exit (a stepUp off the top
 *  rung) is a jump a ladder turns back into a re-climb (the live dismount stall). Head clearance two
 *  above. Cost = one climb tick. Gated on opts.ladder. */
const ladderUp: MovementType = {
  kind: "ladderUp",
  vertical: true,
  apply(reader, from, _dx, _dz, opts) {
    if (!opts.ladder) return [];
    if (!climbableAt(reader, from)) return []; // must be on the ladder to climb it
    const to = { x: from.x, y: from.y + 1, z: from.z };
    // continue up the ladder, OR top out onto a stand the ladder itself supports (walkableAt checks the
    // floor under `to` is standable — `from`, a ladder, is in STANDABLE_SPECIAL_IDS, so it qualifies).
    if (!climbableAt(reader, to) && !walkableAt(reader, to)) return [];
    if (!clearForClimb(reader, { x: from.x, y: from.y + 2, z: from.z })) return []; // new head clear
    return [{ to, cost: LADDER_ONE_BLOCK_TICKS, kind: "ladderUp" }];
  },
};

/** Climb DOWN one block of a ladder/vine. Vertical: destination straight down. Conservative — legal
 *  only while ALREADY on the ladder (from climbable) and the cell below continues the ladder, so a
 *  descent only extends an in-progress climb (entering a downward ladder from a top floor is not yet
 *  modelled; the planner reaches lower ground via cheaper drops/stairs where they exist). Cost = one
 *  climb tick (dearer than a safe drop, so a drop wins when one exists). Gated on opts.ladder. */
const ladderDown: MovementType = {
  kind: "ladderDown",
  vertical: true,
  apply(reader, from, _dx, _dz, opts) {
    if (!opts.ladder) return [];
    if (!climbableAt(reader, from)) return [];
    const to = { x: from.x, y: from.y - 1, z: from.z };
    if (!climbableAt(reader, to)) return []; // only descend where the ladder continues
    return [{ to, cost: LADDER_ONE_BLOCK_TICKS, kind: "ladderDown" }];
  },
};

/** The active move set. Extend here (bridge / …) — the planner adapts. */
export const MOVEMENT_TYPES: readonly MovementType[] = [
  traverse,
  stepUp,
  dropDownSafe,
  diagonal,
  diagonalAscend,
  diagonalDescend,
  parkour,
  mineTraverse,
  mineAscend,
  mineDescend,
  bridgePlace,
  pillarUp,
  mineDown,
  waterDrop,
  ladderEnter,
  ladderUp,
  ladderDown,
];

const CARDINALS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const DIAGONALS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** All single-step moves reachable from `from` (every movement type × its direction set). A
 *  vertical move (pillarUp) is applied once with no horizontal offset; the rest iterate their
 *  cardinal/diagonal direction set. */
export function neighbors(reader: BlockReader, from: Vec3, opts: PlanOpts): MoveResult[] {
  const out: MoveResult[] = [];
  // Peer-as-obstacle post-filter (single aggregation point — every engine, A*/D*/edgeValid, and
  // every move type inherits it): drop any move whose TARGET lands in an avoided column.
  const avoid = opts.avoid;
  const keep = (r: MoveResult) => {
    if (!avoid?.has(columnKey(r.to.x, r.to.z))) out.push(r);
  };
  for (const mt of MOVEMENT_TYPES) {
    if (mt.vertical) {
      for (const r of mt.apply(reader, from, 0, 0, opts)) keep(r);
      continue;
    }
    for (const [dx, dz] of mt.diagonal ? DIAGONALS : CARDINALS) {
      for (const r of mt.apply(reader, from, dx, dz, opts)) keep(r);
    }
  }
  return out;
}
