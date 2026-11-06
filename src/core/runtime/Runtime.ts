// L0 — the ONLY abstraction over jsMacros. Everything above the facade is pure
// and unit-testable; the real impl wraps globals, the mock is in-memory. Because
// this is a TS interface, the mock can't silently drift from the real surface.
import type { Face, FleetAssignment, Result, Vec3 } from "@/core/runtime/types";

export interface ItemStack {
  readonly id: string;
  readonly count: number;
  readonly durabilityPct: number; // 100 = full / no damage
}

export interface DroppedItem extends Vec3 {
  readonly id: string;
  readonly count: number;
}

/** A living entity (mob) near the player — the hunt mission's target feed. Like
 *  DroppedItem, the underlying entity reads are render-thread-pinned, so the real impl
 *  reads a snapshot main.js publishes (mirrored into __MC_MOBS), never the worker-thread
 *  World.getEntities(). `uuid` identifies a specific mob across ticks (it moves); `health`
 *  is 0 / absent for a dead or unreadable mob (the strike loop stops when the target leaves
 *  the snapshot). */
export interface Mob extends Vec3 {
  readonly type: string; // entity id, e.g. "minecraft:pig"
  readonly uuid: string;
  readonly health: number;
  readonly distance: number;
}

/** Another player near the bot — a human or another fleet bot (a "peer"). publishMobs
 *  EXCLUDES players, so peers are a separate render-thread-pinned snapshot main.js publishes
 *  (mirrored into __MC_PEERS); `world.peers()` reads it. `name` is the username (how the follow
 *  mission targets a specific peer); self is excluded by uuid upstream. The follow mission's feed
 *  + the future peer-as-obstacle source (fleet coordination). */
export interface Peer extends Vec3 {
  readonly name: string;
  readonly uuid: string;
  readonly health: number;
  readonly distance: number;
}

/** An item-frame entity (item_frame / glow_item_frame) near the bot — the interact mission's
 *  frame-profile feed. Frames are DECORATION entities: not living (no health — publishMobs skips
 *  them), not items, not players, so they get their own render-thread-pinned snapshot main.js
 *  publishes (mirrored into __MC_FRAMES); `world.frames()` reads it. `uuid` is what
 *  `interact.useOnEntity` right-clicks (uuid resolve + InteractionManager calls are NOT pinned —
 *  the attack(entity) precedent). */
export interface FrameEntity extends Vec3 {
  readonly type: string; // "minecraft:item_frame" | "minecraft:glow_item_frame"
  readonly uuid: string;
  readonly distance: number;
}

/** Open container (own inventory, or the screen currently open). */
export interface Container {
  regions(): string[];
  /** Slot indices in the given regions; with NO args, the carry inventory (main+hotbar).
   *  (The real jsMacros getSlots() returns empty for no-arg — the facade normalizes it.) */
  slots(...regions: string[]): number[];
  /** Number of REAL slots in the open menu. Custom mod GUIs (e.g. the prospector) expose a
   *  region MAP that still claims hotbar indices while the underlying menu slot list is EMPTY —
   *  reading any index then throws. 0 means "no readable slots right now". */
  totalSlots(): number;
  slot(index: number): ItemStack | null;
  selectedHotbar(): number;
  selectHotbar(index: number): void;
  /** Shift-click quick-move (chest deposit). */
  quick(index: number): void;
  swap(a: number, b: number): void;
  dropSlot(index: number): void;
}

export interface BreakResult {
  readonly broken: boolean;
}

/** A placed container's contents + kind, read WITHOUT opening it (the storage-network seam).
 *  `facing` = drawer subfacing (for slot-quadrant aim), else null. slots[i] = null = empty. */
export interface ContainerView {
  readonly kind: "drawer" | "chest" | "barrel" | "container";
  readonly facing: string | null;
  readonly slots: ReadonlyArray<ItemStack | null>;
}

/** One block-id → container-kind rule, matched by substring on the id. The FACADE owns the
 *  generic taxonomy (drawer/chest/barrel/container = storage SHAPES the geometry needs); the
 *  PACK owns which mod ids map onto it, so the table is injected at construction rather than
 *  baked in — no mod id belongs in the core tier. */
export interface ContainerKindRule {
  readonly match: string;
  readonly kind: ContainerView["kind"];
}

export interface PlayerInput {
  readonly forward: number;
  readonly strafe: number;
  readonly jumping: boolean;
  readonly sprinting: boolean;
}

export interface Runtime {
  readonly tick: () => number;

  player: {
    /** This client's own username — IDENTITY, not state. The chat-command capability needs it
     *  to tell a line addressed at THIS bot from one addressed at a peer, and to ignore its own
     *  replies in a fleet that shares one chat. `err` while the player isn't in the world yet. */
    name(): Result<string>;
    pos(): Result<Vec3>;
    health(): Result<number>;
    eyePos(): Result<Vec3>;
    input(): Result<PlayerInput>;
    /** Breath remaining, in ticks (vanilla full = 300). Pairs with maxAir() for a fraction
     *  the air reflex reacts to directly — far more honest than sniffing the eye block id. */
    air(): Result<number>;
    /** Max breath, in ticks. >0 when readable; the air reflex guards against a zero divisor. */
    maxAir(): Result<number>;
    /** Hunger, 0..20. Drives the hunger reflex / maintenance EAT. */
    food(): Result<number>;
    /** Per-tick motion vector (blocks/tick). y≈-0.078 in free-ish stance from gravity. */
    velocity(): Result<Vec3>;
    /** False once the player entity is dead (HP 0, awaiting respawn). */
    alive(): Result<boolean>;
    /** True when the player can breathe underwater (conduit power / aqua-affinity helmet /
     *  water-breathing) — the air reflex must NOT trip then, even fully submerged. */
    canBreatheWater(): Result<boolean>;
    /** Press the DeathScreen "Respawn" button. Returns true if it was found + clicked,
     *  false if no death screen is open (already alive / mid-respawn). Idempotent — safe
     *  to call every tick while dead. */
    respawn(): Result<boolean>;
    /** Is the player standing on the ground? Entity.onGround() (SRG m_20096_, confirmed via
     *  reflect). The navigator's executor reads this to time jumps + detect being airborne;
     *  a read, so safe to call freely. */
    onGround(): Result<boolean>;
    /** Current view yaw in degrees (0=south, +clockwise). Paired with setRotation to aim
     *  straight up/down without spinning: lookAt degenerates for a perfectly-vertical target
     *  (horizontal distance ≈ 0 → wrong pitch), so the break routine keeps yaw + sets pitch. */
    yaw(): Result<number>;
    /** Force the vanilla sprinting state ON/OFF (LivingEntity.setSprinting, SRG m_6858_). The
     *  jsMacros key.sprint keybind does NOT engage real sprint (verified: held key → speed caps at
     *  walk, isSprinting stays false), so the navigator drives a parkour run-up by re-asserting this
     *  every tick while charging — the only way to reach the ~0.28 b/tick a wide sprint-jump needs.
     *  aiStep recomputes the flag each tick, so it must be re-set per tick to hold. */
    setSprinting(on: boolean): Result<void>;
    /** Force an immediate jump (LivingEntity.jumpFromGround, SRG m_6135_). The jsMacros key.jump keybind
     *  does NOT reliably make the player leave the ground here (verified: parkour launches stayed grounded
     *  at y=101) — same flaky-keybind class as setSprinting — so the parkour executor calls this on the
     *  launch tick. While sprinting it also applies vanilla's sprint-jump forward boost, the extra reach a
     *  wide jump needs. Requires the player to be on the ground (a no-op mid-air); fire once per launch. */
    jump(): Result<void>;
  };

  world: {
    /** Block id at a position. `err` = the chunk/world wasn't readable (NOT "air") — a
     *  caller must decide locally (skip / treat conservatively), never act on a fake. */
    blockId(p: Vec3): Result<string>;
    items(maxDist: number): Result<DroppedItem[]>;
    /** Living entities (mobs) within `maxDist`, nearest-first. Snapshot-backed like
     *  items() (the entity reads are render-thread-pinned), so it never errors — an absent
     *  snapshot (pre-publish) reads as []. The hunt mission's target feed. */
    mobs(maxDist: number): Result<Mob[]>;
    /** Other players (peers — humans + other bots) within `maxDist`, nearest-first. Snapshot-
     *  backed like mobs() (player reads are render-thread-pinned, and publishMobs excludes
     *  players), mirrored into __MC_PEERS, so it never errors — an absent snapshot reads as [].
     *  The follow mission's target feed; self is excluded upstream by uuid. */
    peers(maxDist: number): Result<Peer[]>;
    /** Item-frame entities within `maxDist`, nearest-first. Snapshot-backed like mobs()/peers()
     *  (decoration-entity reads are render-thread-pinned), mirrored into __MC_FRAMES, so it never
     *  errors — an absent snapshot reads as []. The interact mission's frame-profile feed: pick
     *  the frame nearest the target block, then `interact.useOnEntity(uuid)` right-clicks it. */
    frames(maxDist: number): Result<FrameEntity[]>;
    /** Identity of the CURRENT world for scoping persistent knowledge —
     *  `<world/server id>|<dimension>`. `err` = the world isn't ready yet (worker boot)
     *  — callers defer world-scoped work until it resolves, and re-scope when it CHANGES
     *  (dimension travel), never cache it once. */
    signature(): Result<string>;
    /** The fleet assignment the coordinator hub pushed down — the XZ region this
     *  bot may mine + peer-claimed regions to avoid. `ok(null)` = no assignment (mine anywhere).
     *  Snapshot-backed like mobs()/items() (mirrored into `__MC_ASSIGNMENT`), so it never errors;
     *  an absent/blank global reads as `null`. The mine scan filters candidate ore by it. */
    assignment(): Result<FleetAssignment | null>;
  };

  mine: {
    setTarget(p: Vec3, face: Face): void;
    /** Async break with completion callback (1.9.2 breakBlockAsync). */
    breakAsync(p: Vec3, onDone: (r: BreakResult) => void): void;
    cancel(): void;
  };

  /** World interaction — place/use/craft. The coherent "act on the world with the held
   *  item or a block" group (distinct from `mine`, which only breaks). A caller selects
   *  the hotbar item (via `inv`) and faces the target (`lookAt`) first; these stay
   *  primitive. `err` = the interaction was rejected / had no effect (never a fake ok). */
  interact: {
    /** Place the held block against `face` of the block at `against`; the new block lands
     *  at `against` + the face offset. SEMANTICS: in the real runtime `ok` means the
     *  right-click interaction was DISPATCHED, not that a block confirmedly landed (the
     *  server applies it asynchronously, ~1 tick later) — a caller that needs confirmation
     *  must re-read `world.blockId` next tick. `err` = the interaction call itself threw.
     *  (The mock applies it synchronously, so under test `ok` ⇒ the block is present — the
     *  one place real/mock `ok` differ in strength; see craft-regions / the contract test.) */
    placeBlock(against: Vec3, face: Face): Result<void>;
    /** Right-click the block at `p` on `face` — opens a table/chest, flips a lever. Same
     *  dispatch-not-confirmed `ok` semantics as `placeBlock` (it's the same vanilla
     *  right-click interaction; the two methods differ only in caller intent). */
    useOnBlock(p: Vec3, face: Face): Result<void>;
    /** Right-click the ENTITY with this uuid with the held item — put an item into a vanilla
     *  item frame, use on an armor stand. The entity counterpart of `useOnBlock`, built exactly
     *  like `attack(uuid)`: resolve the live entity by uuid (World.getEntities — uuid resolve +
     *  InteractionManager calls are NOT render-thread-pinned, unlike entity detail reads) and
     *  call interactEntity(entity). `err` = the uuid is no longer present. Dispatch-not-confirmed
     *  like useOnBlock — a `consumed` caller re-reads the bag after a grace. */
    useOnEntity(uuid: string): Result<void>;
    /** Right-click with the held item (throw/activate). */
    useItem(): Result<void>;
    /** Eat the held food: applies its nutrition + consumes one from the stack. Calls the
     *  item's `finishUsingItem` directly (server-correct) rather than simulating a held
     *  right-click — jsMacros re-asserts held keys every tick, which resets the use-item
     *  timer to 32 forever so input-driven eating never completes in this build (verified
     *  live). No-op for a non-edible held item. Fire-and-forget on the render thread, so
     *  `ok` = the bite was dispatched; a caller confirms by re-reading `player.food()`. */
    eat(): Result<void>;
    /** Melee-attack the entity with this uuid (a single left-click swing). We resolve the live
     *  entity by uuid (World.getEntities) and call InteractionManager.attack(entity) — NOT the
     *  no-arg attack(), which depends on the render-thread crosshair hitResult that is null on
     *  the worker thread (verified live: no-arg swings but never lands). `err` = the uuid is no
     *  longer present (already dead/despawned). Fire-and-forget; the caller confirms a kill by
     *  the target leaving world.mobs(). */
    attack(uuid: string): Result<void>;
    /** Orient the player toward `p` (yaw + pitch). Interaction does not auto-look. */
    lookAt(p: Vec3): Result<void>;
    /** Set heading directly: yaw (degrees, 0=south, +clockwise) + pitch (degrees, -90=up).
     *  Entity.setYRot/setXRot (SRG m_146922_/m_146926_, confirmed via reflect). Distinct from
     *  lookAt (which aims at a point) — the navigator drives a heading. MUTATES (turns the
     *  player), so it is gated to the live executor, not used in read-only probes. */
    setRotation(yaw: number, pitch: number): Result<void>;
    /** Set ONLY the yaw, leaving the current pitch untouched — the navigator's heading change
     *  while walking. Avoids the camera jerk from forcing pitch=0 every movement tick when a
     *  break just aimed it down (live: DESCEND snapped 0↔90 between centring and digging). */
    setYaw(yaw: number): Result<void>;
    /** Close the open GUI screen (e.g. a crafting table). `Screen.close()` rebuilds the
     *  screen so it is scheduled on the render thread (fire-and-forget) — `ok` means the
     *  close was scheduled (or nothing was open), not that it has already applied (≈1 tick). */
    closeScreen(): Result<void>;
    /** Manual grid crafting. The recipe-book API is dead on Monifactory (verified live),
     *  so we place ingredients into the OPEN crafting grid
     *  and let the SERVER compute the result (pack-correct — overrides honored). The
     *  result slot fills ~1 tick AFTER placement, so this is split into tick-driven
     *  primitives the craft mission sub-steps across: place → (wait) → output → take.
     *  `slots` is row-major (length 4 = the 2×2 player grid, 9 = a 3×3 table that must
     *  already be open); each non-null cell gets exactly ONE of that item id. */
    craft: {
      /** Number of input cells in the resolvable crafting grid: 9 when a 3×3 table screen is
       *  open, else 4 (the player 2×2 grid, which `openInventory` always exposes — so this is
       *  4, never 0, when no table is open). The region name differs by screen (`crafting_in`
       *  for the player inventory, `input` for a table), so callers ask here, not by region
       *  name; >4 is the signal that a table screen is open (used by the craft CLOSE step). */
      gridSize(): Result<number>;
      /** Drop one of each non-null cell's item from inventory into the open grid.
       *  `err` = a required ingredient is missing or the open grid is smaller than `slots`. */
      place(slots: ReadonlyArray<string | null>): Result<void>;
      /** The current result-slot stack, or `null` until the server computes it (≈1 tick
       *  after `place`). `err` = no crafting grid open. */
      output(): Result<ItemStack | null>;
      /** Shift-click the result into inventory (consumes one ingredient set). Returns the
       *  count moved (0 if the result slot was empty). */
      take(): Result<number>;
      /** Return any items left in the input grid back to inventory (abort cleanup). */
      clearGrid(): Result<void>;
    };
  };

  inv: {
    /** Open the player inventory / current container screen. `err` = none open. */
    open(): Result<Container>;
  };

  /** Read a PLACED container's contents + kind WITHOUT opening it — the storage-network
   *  seam. Chests, barrels and Functional Storage drawers all expose the Forge
   *  ITEM_HANDLER capability, which is client-synced (it backs the count label), so a READ
   *  is client-safe. `err` = no block-entity / no item handler at `p` (not a container). */
  storage: {
    read(p: Vec3): Result<ContainerView>;
  };

  keys: {
    set(key: string, pressed: boolean): void;
    releaseAll(): void;
    /** True if a horizontal-movement key (forward/back/left/right) is currently held — i.e.
     *  the bot is actively trying to walk. Lets the stuck reflex tell a wedged driver (keys
     *  held, no progress) from a phase deliberately holding position (keys released, e.g. a
     *  follower waiting on a stationary leader), which is NOT stuck. */
    movementHeld(): boolean;
    /** True if ANY key the bot drives its body with is held — the horizontal set PLUS
     *  jump and sprint, i.e. exactly the keys that can make `player.input()` read
     *  forward/strafe/jumping/sprinting. This is the "the bot itself is the source of that
     *  input" signal the human-takeover reflex needs (movementHeld() is narrower on
     *  purpose: a held jump/sprint alone is not "trying to walk", so it must not count as
     *  stuck-driving). Bot-owned by construction — it tracks what the BOT pressed through
     *  this facade, so a human on the physical keyboard never sets it. */
    driveHeld(): boolean;
    /** The drive keys held RIGHT NOW — the same set `driveHeld()` answers over, enumerated.
     *  Diagnostics only: the human reflex names the offending key when a held drive key has
     *  suppressed it past cfg.safety.driveHeldMaxTicks, so a latch has an owner in the journal
     *  instead of a silent "the reflex never fires". */
    driveHeldKeys(): readonly string[];
  };

  /** Navigation command surface. Baritone was removed: the bot's own greedy executor
   *  (`greedyStep`) now drives ALL field movement via held keys, so there is no external path
   *  driver to start. `stop()` is the one remaining verb — halt movement by releasing the held
   *  keys (the greedy navigator holds key.forward/jump/sprint). Phases call it on exit/abort. */
  nav: {
    stop(): void;
  };

  chat: {
    say(text: string): void;
    log(text: string): void;
  };

  /** On-screen overlay (jsMacros Draw2D). Cosmetic — failures are silent no-ops. */
  hud: {
    setLines(lines: string[]): void;
    clear(): void;
  };

  fs: {
    /** Append a line (the NDJSON log sink). Best-effort void — it can't log its own
     *  failure without recursing; the worker's own logging covers a dead disk. */
    appendLine(path: string, line: string): void;
    write(path: string, data: string): Result<void>;
    /** Read a file. `ok(null)` = the file does not exist (a legitimate empty state);
     *  `err` = an IO failure (so a caller never mistakes a broken read for "no data"
     *  and overwrites a real file). */
    read(path: string): Result<string | null>;
    /** Crash-safe write: stage to a temp file, then atomically rename over `path`
     *  (so a reader/scraper never sees a half-written file). */
    writeAtomic(path: string, data: string): Result<void>;
  };

  http: {
    /** POST a body to a URL (game-KPI push to VictoriaMetrics' import API). `err` =
     *  connect/IO failure or a non-2xx status — telemetry is best-effort, so a dead
     *  VM must surface as a logged warning, never a thrown stall in the tick loop. */
    post(url: string, body: string, contentType: string): Result<void>;
  };
}
