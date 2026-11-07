import { FACE_OFFSET } from "@/core/prim/face";
import { EYE_HEIGHT } from "@/core/prim/movement-physics";
import { encodePos } from "@/core/prim/pos";
// In-memory L0 implementation for tests. Implements the SAME Runtime interface as
// the real one, so a method added to the facade fails to compile here until the
// mock provides it — no more hand-maintained drift.
import type {
  BreakResult,
  Container,
  ContainerView,
  DroppedItem,
  FrameEntity,
  ItemStack,
  Mob,
  Peer,
  PlayerInput,
  Runtime,
} from "@/core/runtime/Runtime";
import { craftGridSlots } from "@/core/runtime/craft-regions";
import { readSnapshot } from "@/core/runtime/snapshot";
import {
  type Face,
  type FleetAssignment,
  type Result,
  type Vec3,
  err,
  ok,
} from "@/core/runtime/types";

// Vanilla hotbar occupies inventory slots 36..44; the selected hotbar index maps here.
const HOTBAR_SLOT_BASE = 36;

// The horizontal-movement keys (see Runtime.keys.movementHeld / driveHeld).
const MOCK_HORIZONTAL_KEYS = ["key.forward", "key.back", "key.left", "key.right"];
// Every key the bot drives its body with (see Runtime.keys.driveHeld / driveHeldKeys).
const MOCK_DRIVE_KEYS = [...MOCK_HORIZONTAL_KEYS, "key.jump", "key.sprint"];

/** A test-seeded recipe: an ingredient multiset (id → count) → one output stack. */
interface MockRecipe {
  ingredients: Record<string, number>;
  output: { id: string; count: number };
}

interface MockState {
  tick: number;
  pos: Vec3;
  health: number;
  /** Breath (ticks), max breath, hunger (0..20) and motion — the F1 sensing surface. */
  air: number;
  maxAir: number;
  food: number;
  velocity: Vec3;
  alive: boolean;
  canBreatheWater: boolean;
  /** Ground contact (Entity.onGround) + current heading (Entity.setYRot/setXRot mirror). */
  onGround: boolean;
  /** Vanilla sprinting flag (Entity.setSprinting mirror) — the executor forces it during a run-up. */
  sprinting: boolean;
  /** How many times jump() fired (LivingEntity.jumpFromGround mirror) — a parkour launch asserts it. */
  jumpCount: number;
  rotation: { yaw: number; pitch: number };
  /** How many times respawn() revived the mock (LocalPlayer.respawn while dead). */
  respawnCalls: number;
  input: PlayerInput;
  blocks: Map<string, string>;
  items: DroppedItem[];
  /** Living entities (mobs) the hunt mission senses via world.mobs(). Test-seeded; a
   *  strike removes the target (count to 0 health → drop from the list) to drive the loop. */
  mobs: Mob[];
  /** Other players (peers) the follow mission senses via world.peers(). Test-seeded. */
  peers: Peer[];
  /** Item-frame entities the interact mission senses via world.frames(). Test-seeded. */
  frames: FrameEntity[];
  /** The fleet assignment world.assignment() returns; null = none (mine anywhere). */
  assignment: FleetAssignment | null;
  /** How many times interact.attack() fired (strike-loop assertion hook). */
  attackCalls: number;
  /** Uuid of the last interact.useOnEntity() target, or null (frame-interact assertion hook). */
  lastUseEntity: string | null;
  hotbar: number;
  slots: Map<number, ItemStack>;
  log: string[];
  chat: string[];
  files: Map<string, string>;
  keys: Record<string, boolean>;
  mineTarget: Vec3 | null;
  /** Last `interact.lookAt` target (test assertion hook). */
  lookTarget: Vec3 | null;
  /** Block id of the GUI opened by `interact.useOnBlock`, or null. */
  openScreen: string | null;
  /** Item id of the last `interact.useItem`, or null. */
  lastUseItem: string | null;
  /** Count of `interact.useItem` calls (bite pacing assertion hook). */
  useItemCalls: number;
  /** Item id of the last `interact.eat`, or null. */
  lastEat: string | null;
  /** Count of `interact.eat` calls (bite pacing assertion hook). */
  eatCalls: number;
  /** Recipe table seeded by tests. The mock "server" matches the placed grid's ingredient
   *  multiset (ids → counts, shape-agnostic) against these and computes the result, the
   *  same way the live server fills craft_out from whatever is placed. */
  recipes: MockRecipe[];
  /** Items currently sitting in the crafting input grid (row-major; null = empty cell). */
  craftGrid: (string | null)[];
  hudLines: string[];
  worldSig: string;
  /** When false, player.* resolve `err` — simulates the player being absent (world
   *  loading / between dimensions), so resource-gated capabilities can be tested. */
  playerPresent: boolean;
  /** The username `player.name()` reports — this bot's own identity (chat addressing/self-skip). */
  playerName: string;
  httpPosts: { url: string; body: string; contentType: string }[];
  /** Placed containers (keyed by encoded pos) the storage-network reads via `storage.read`. */
  containers: Map<string, ContainerView>;
}

export interface MockRuntime extends Runtime {
  readonly state: MockState;
  setBlock(x: number, y: number, z: number, id: string): void;
  setPos(p: Vec3): void;
  /** Seed the peers world.peers() returns (the follow mission's target feed). */
  setPeers(peers: Peer[]): void;
  /** Seed the fleet assignment world.assignment() returns (null = none). */
  setAssignment(a: FleetAssignment | null): void;
  /** Seed a placed container's contents for `storage.read` (the storage-network deposit tests). */
  setContainer(p: Vec3, view: ContainerView): void;
  flushBreak(): void; // resolve any pending breakAsync callbacks
}

export function createMockRuntime(): MockRuntime {
  const state: MockState = {
    tick: 0,
    pos: { x: 0, y: 64, z: 0 },
    health: 20,
    air: 300,
    maxAir: 300,
    food: 20,
    velocity: { x: 0, y: 0, z: 0 },
    alive: true,
    onGround: true,
    sprinting: false,
    jumpCount: 0,
    rotation: { yaw: 0, pitch: 0 },
    canBreatheWater: false,
    respawnCalls: 0,
    input: { forward: 0, strafe: 0, jumping: false, sprinting: false },
    blocks: new Map(),
    items: [],
    mobs: [],
    peers: [],
    frames: [],
    assignment: null,
    attackCalls: 0,
    lastUseEntity: null,
    hotbar: 0,
    slots: new Map(),
    log: [],
    chat: [],
    files: new Map(),
    keys: {},
    mineTarget: null,
    lookTarget: null,
    openScreen: null,
    lastUseItem: null,
    useItemCalls: 0,
    lastEat: null,
    eatCalls: 0,
    recipes: [],
    craftGrid: [],
    hudLines: [],
    worldSig: "local|minecraft:overworld",
    playerPresent: true,
    playerName: "bot_1",
    httpPosts: [],
    containers: new Map(),
  };
  let pendingBreak: (() => void) | null = null;

  // Inventory helpers shared by the craft primitives (consume inputs, add output).
  const countId = (id: string): number => {
    let n = 0;
    for (const s of state.slots.values()) if (s.id === id) n += s.count;
    return n;
  };
  const consume = (id: string, n: number): void => {
    let remaining = n;
    for (const [slot, s] of [...state.slots.entries()]) {
      if (remaining <= 0) break;
      if (s.id !== id) continue;
      const take = Math.min(s.count, remaining);
      remaining -= take;
      if (s.count <= take) state.slots.delete(slot);
      else state.slots.set(slot, { ...s, count: s.count - take });
    }
  };
  const addItem = (id: string, n: number): void => {
    for (const [slot, s] of state.slots.entries()) {
      if (s.id === id) {
        state.slots.set(slot, { ...s, count: s.count + n });
        return;
      }
    }
    for (let i = 9; i <= 44; i++) {
      if (!state.slots.has(i)) {
        state.slots.set(i, { id, count: n, durabilityPct: 100 });
        return;
      }
    }
  };
  // The mock "server": find the recipe whose ingredient multiset matches the current grid.
  const matchGridRecipe = (): MockRecipe | null => {
    const m: Record<string, number> = {};
    for (const c of state.craftGrid) if (c) m[c] = (m[c] ?? 0) + 1;
    const keys = Object.keys(m);
    for (const r of state.recipes) {
      const rk = Object.keys(r.ingredients);
      if (rk.length === keys.length && rk.every((k) => r.ingredients[k] === m[k])) return r;
    }
    return null;
  };

  // Region names track the OPEN screen, mirroring the live jsMacros wrapper: a 3×3 crafting
  // TABLE exposes "input"/"output"; the bare player inventory exposes "crafting_in"(2×2)/
  // "craft_out". This is what lets the shared craftGridSlots/craftOutSlot fallback (player
  // names → table names) actually exercise its table branch against the mock.
  const tableOpen = (): boolean => state.openScreen === "minecraft:crafting_table";
  const craftRegions = (): string[] =>
    tableOpen() ? ["input", "output"] : ["crafting_in", "craft_out"];
  const container: Container = {
    regions: () => ["hotbar", "main", ...craftRegions()],
    slots: (...regions) => {
      const out: number[] = [];
      if (regions.length === 0 || regions.includes("hotbar"))
        for (let i = 36; i <= 44; i++) out.push(i);
      if (regions.length === 0 || regions.includes("main"))
        for (let i = 9; i <= 35; i++) out.push(i);
      // Grid input cells: a 3×3 table reports 9 under "input", the 2×2 player grid 4 under
      // "crafting_in". Result slot [0] under "output" (table) or "craft_out" (player).
      const gridRegion = tableOpen() ? "input" : "crafting_in";
      const outRegion = tableOpen() ? "output" : "craft_out";
      if (regions.includes(gridRegion)) {
        const cells = tableOpen() ? 9 : 4;
        for (let i = 0; i < cells; i++) out.push(100 + i);
      }
      if (regions.includes(outRegion)) out.push(0);
      return out;
    },
    // The mock is always the player's own 46-slot inventory view (no custom-GUI empty-menu
    // case); tests exercising that path stub Container directly.
    totalSlots: () => 46,
    slot: (i) => state.slots.get(i) ?? null,
    selectedHotbar: () => state.hotbar,
    selectHotbar: (i) => {
      state.hotbar = i;
    },
    quick: (i) => state.slots.delete(i),
    swap: (a, b) => {
      const sa = state.slots.get(a);
      const sb = state.slots.get(b);
      if (sb) state.slots.set(a, sb);
      else state.slots.delete(a);
      if (sa) state.slots.set(b, sa);
      else state.slots.delete(b);
    },
    dropSlot: (i) => state.slots.delete(i),
  };

  const mock: MockRuntime = {
    state,
    tick: () => state.tick,
    setBlock: (x, y, z, id) => state.blocks.set(encodePos(x, y, z), id),
    setPos: (p) => {
      state.pos = p;
    },
    setPeers: (peers) => {
      state.peers = peers;
    },
    setAssignment: (a) => {
      state.assignment = a;
    },
    setContainer: (p, view) => state.containers.set(encodePos(p.x, p.y, p.z), view),
    flushBreak: () => {
      const cb = pendingBreak;
      pendingBreak = null;
      cb?.();
    },

    player: {
      name: (): Result<string> => (state.playerPresent ? ok(state.playerName) : err("no player")),
      pos: (): Result<Vec3> => (state.playerPresent ? ok(state.pos) : err("no player")),
      health: (): Result<number> => (state.playerPresent ? ok(state.health) : err("no player")),
      eyePos: (): Result<Vec3> =>
        state.playerPresent
          ? ok({ x: state.pos.x, y: state.pos.y + EYE_HEIGHT, z: state.pos.z })
          : err("no player"),
      input: (): Result<PlayerInput> => (state.playerPresent ? ok(state.input) : err("no player")),
      air: (): Result<number> => (state.playerPresent ? ok(state.air) : err("no player")),
      maxAir: (): Result<number> => (state.playerPresent ? ok(state.maxAir) : err("no player")),
      food: (): Result<number> => (state.playerPresent ? ok(state.food) : err("no player")),
      velocity: (): Result<Vec3> => (state.playerPresent ? ok(state.velocity) : err("no player")),
      alive: (): Result<boolean> => (state.playerPresent ? ok(state.alive) : err("no player")),
      canBreatheWater: (): Result<boolean> =>
        state.playerPresent ? ok(state.canBreatheWater) : err("no player"),
      respawn: (): Result<boolean> => {
        if (!state.playerPresent) return err("no player");
        // Mirrors LocalPlayer.respawn(): only acts while dead → revives + reports true.
        if (state.alive) return ok(false);
        state.alive = true;
        state.health = 20;
        state.respawnCalls += 1;
        return ok(true);
      },
      onGround: (): Result<boolean> =>
        state.playerPresent ? ok(state.onGround) : err("no player"),
      yaw: (): Result<number> => (state.playerPresent ? ok(state.rotation.yaw) : err("no player")),
      setSprinting: (on: boolean): Result<void> => {
        if (!state.playerPresent) return err("no player");
        state.sprinting = on;
        return ok(undefined);
      },
      jump: (): Result<void> => {
        if (!state.playerPresent) return err("no player");
        state.jumpCount += 1;
        return ok(undefined);
      },
    },
    world: {
      // The mock world is fully-loaded air unless a block is set — a legitimate test
      // default, not a masked failure.
      blockId: (b: Vec3): Result<string> =>
        ok(state.blocks.get(encodePos(b.x, b.y, b.z)) ?? "minecraft:air"),
      // Same shared reader as the real impl (over the seeded arrays instead of a JSON global),
      // so the distance-filter/sort can't drift between mock and runtime.
      items: (maxDist: number): Result<DroppedItem[]> =>
        ok(readSnapshot<DroppedItem>(state.items, state.pos, maxDist)),
      mobs: (maxDist: number): Result<Mob[]> =>
        ok(
          readSnapshot<Mob, Mob>(state.mobs, state.pos, maxDist, {
            map: (mb, distance) => ({ ...mb, distance }),
            sort: true,
          }),
        ),
      peers: (maxDist: number): Result<Peer[]> =>
        ok(
          readSnapshot<Peer, Peer>(state.peers, state.pos, maxDist, {
            map: (pr, distance) => ({ ...pr, distance }),
            sort: true,
          }),
        ),
      frames: (maxDist: number): Result<FrameEntity[]> =>
        ok(
          readSnapshot<FrameEntity, FrameEntity>(state.frames, state.pos, maxDist, {
            map: (fr, distance) => ({ ...fr, distance }),
            sort: true,
          }),
        ),
      signature: (): Result<string> =>
        state.worldSig ? ok(state.worldSig) : err("world not ready"),
      assignment: (): Result<FleetAssignment | null> => ok(state.assignment),
    },
    mine: {
      setTarget: (p: Vec3, _face: Face) => {
        state.mineTarget = p;
      },
      breakAsync: (p: Vec3, onDone: (r: BreakResult) => void) => {
        state.mineTarget = p;
        pendingBreak = () => {
          state.blocks.set(encodePos(p.x, p.y, p.z), "minecraft:air");
          onDone({ broken: true });
        };
      },
      cancel: () => {
        pendingBreak = null;
      },
    },
    interact: {
      placeBlock: (against: Vec3, face: Face): Result<void> => {
        const heldSlot = HOTBAR_SLOT_BASE + state.hotbar;
        const held = state.slots.get(heldSlot);
        if (!held) return err("nothing to place");
        const off = FACE_OFFSET[face];
        const dest = { x: against.x + off.x, y: against.y + off.y, z: against.z + off.z };
        const key = encodePos(dest.x, dest.y, dest.z);
        if ((state.blocks.get(key) ?? "minecraft:air") !== "minecraft:air") return err("occupied");
        state.blocks.set(key, held.id);
        if (held.count <= 1) state.slots.delete(heldSlot);
        else state.slots.set(heldSlot, { ...held, count: held.count - 1 });
        return ok(undefined);
      },
      useOnBlock: (p: Vec3, _face: Face): Result<void> => {
        state.openScreen = state.blocks.get(encodePos(p.x, p.y, p.z)) ?? "minecraft:air";
        return ok(undefined);
      },
      useItem: (): Result<void> => {
        state.lastUseItem = state.slots.get(HOTBAR_SLOT_BASE + state.hotbar)?.id ?? null;
        state.useItemCalls += 1;
        return ok(undefined);
      },
      useOnEntity: (uuid: string): Result<void> => {
        // Mirror the real useOnEntity(uuid): err when the uuid isn't a known frame entity
        // (broken/despawned — what the live resolve-by-uuid scan returns), else record the
        // interaction and consume 1 from the held stack (an EMPTY vanilla frame absorbs one;
        // the filled-frame rotate nuance is out of mock scope — tests splice it if needed).
        const fi = state.frames.findIndex((f) => f.uuid === uuid);
        if (fi < 0) return err(`entity ${uuid} not found`);
        state.lastUseEntity = uuid;
        const heldSlot = HOTBAR_SLOT_BASE + state.hotbar;
        const held = state.slots.get(heldSlot);
        if (held) {
          if (held.count <= 1) state.slots.delete(heldSlot);
          else state.slots.set(heldSlot, { ...held, count: held.count - 1 });
        }
        return ok(undefined);
      },
      attack: (uuid: string): Result<void> => {
        // Mirror the real attack(entity): damage the mob with this uuid, removing it at 0 health
        // so the strike loop converges (the mission re-finds the target by uuid each tick). err
        // if the uuid is already gone — exactly what the live facade returns for a dead target.
        state.attackCalls += 1;
        const i = state.mobs.findIndex((m) => m.uuid === uuid);
        if (i < 0) return err(`entity ${uuid} not found`);
        const m = state.mobs[i];
        if (!m) return err(`entity ${uuid} not found`);
        const hp = m.health - 4; // ~one iron-sword hit
        if (hp <= 0) state.mobs.splice(i, 1);
        else state.mobs[i] = { ...m, health: hp };
        return ok(undefined);
      },
      eat: (): Result<void> => {
        // Mirror useItem's tracking; food is test-driven (so pacing assertions stay in
        // control), but consume one of the held stack like the real finishUsingItem does.
        const heldSlot = HOTBAR_SLOT_BASE + state.hotbar;
        const held = state.slots.get(heldSlot);
        state.lastEat = held?.id ?? null;
        state.eatCalls += 1;
        if (held) {
          if (held.count <= 1) state.slots.delete(heldSlot);
          else state.slots.set(heldSlot, { ...held, count: held.count - 1 });
        }
        return ok(undefined);
      },
      lookAt: (p: Vec3): Result<void> => {
        state.lookTarget = p;
        return ok(undefined);
      },
      setRotation: (yaw: number, pitch: number): Result<void> => {
        state.rotation = { yaw, pitch };
        return ok(undefined);
      },
      setYaw: (yaw: number): Result<void> => {
        state.rotation = { yaw, pitch: state.rotation?.pitch ?? 0 };
        return ok(undefined);
      },
      closeScreen: (): Result<void> => {
        state.openScreen = null;
        return ok(undefined);
      },
      // Manual grid crafting mirror: place() moves one of each cell from inventory into the
      // grid; output()/take() compute the result from the grid via the seeded recipe table.
      craft: {
        // Resolve the grid size through the SAME shared helper the real impl uses (over the
        // mock's screen-tracked regions), so the player→table fallback is exercised here too.
        gridSize: (): Result<number> => ok(craftGridSlots((r) => container.slots(r)).length),
        place: (slots: ReadonlyArray<string | null>): Result<void> => {
          const need: Record<string, number> = {};
          for (const c of slots) if (c) need[c] = (need[c] ?? 0) + 1;
          for (const [id, n] of Object.entries(need)) {
            if (countId(id) < n) return err(`missing ingredient ${id}`);
          }
          for (const [id, n] of Object.entries(need)) consume(id, n);
          state.craftGrid = slots.slice();
          return ok(undefined);
        },
        output: (): Result<ItemStack | null> => {
          const r = matchGridRecipe();
          return ok(r ? { id: r.output.id, count: r.output.count, durabilityPct: 100 } : null);
        },
        take: (): Result<number> => {
          const r = matchGridRecipe();
          if (!r) return ok(0);
          addItem(r.output.id, r.output.count);
          state.craftGrid = [];
          return ok(r.output.count);
        },
        clearGrid: (): Result<void> => {
          for (const c of state.craftGrid) if (c) addItem(c, 1);
          state.craftGrid = [];
          return ok(undefined);
        },
      },
    },
    inv: { open: (): Result<Container> => ok(container) },

    storage: {
      read: (p): Result<ContainerView> => {
        const view = state.containers.get(encodePos(p.x, p.y, p.z));
        return view ? ok(view) : err(`no container at ${p.x},${p.y},${p.z}`);
      },
    },
    keys: {
      set: (key, pressed) => {
        state.keys[key] = pressed;
      },
      movementHeld: () => MOCK_HORIZONTAL_KEYS.some((k) => state.keys[k]),
      // Mirrors jsmacros.ts: the horizontal set PLUS jump/sprint — every key the bot drives its
      // body with, i.e. everything that can show up in player.input() (see Runtime.keys.driveHeld).
      driveHeld: () => MOCK_DRIVE_KEYS.some((k) => state.keys[k]),
      driveHeldKeys: () => MOCK_DRIVE_KEYS.filter((k) => state.keys[k]),
      releaseAll: () => {
        // Mirrors jsmacros.ts: action keys AND movement keys (the greedy navigator holds
        // key.forward/key.jump, which a reflex divert must release).
        for (const k of [
          "key.attack",
          "key.use",
          "key.drop",
          "key.forward",
          "key.back",
          "key.left",
          "key.right",
          "key.jump",
          "key.sprint",
          "key.sneak",
        ]) {
          state.keys[k] = false;
        }
      },
    },
    nav: {
      // Baritone removed: "stop navigating" releases the held movement keys (the greedy
      // executor's drive), mirroring the real impl. Records nothing to chat — there is no path driver.
      stop: () => {
        for (const k of Object.keys(state.keys)) state.keys[k] = false;
      },
    },
    chat: {
      say: (t) => state.chat.push(t),
      log: (t) => state.log.push(t),
    },
    hud: {
      setLines: (lines) => {
        state.hudLines = lines.slice();
      },
      clear: () => {
        state.hudLines = [];
      },
    },
    fs: {
      appendLine: (path, line) => state.files.set(path, `${state.files.get(path) ?? ""}${line}\n`),
      write: (path, data): Result<void> => {
        state.files.set(path, data);
        return ok(undefined);
      },
      read: (path): Result<string | null> => ok(state.files.get(path) ?? null),
      writeAtomic: (path, data): Result<void> => {
        state.files.set(path, data);
        return ok(undefined);
      },
    },
    http: {
      post: (url, body, contentType): Result<void> => {
        state.httpPosts.push({ url, body, contentType });
        return ok(undefined);
      },
    },
  };
  // The kernel drives the clock exactly as on the real runtime (jsmacros/index.ts): Kernel.tick calls
  // this hidden setter, so rt.tick() == st.tickCount under a kernel. Tests that drive greedy directly
  // (no kernel) keep setting `state.tick` by hand.
  (mock as MockRuntime & { __setTick: (t: number) => void }).__setTick = (t) => {
    state.tick = t;
  };
  return mock;
}
