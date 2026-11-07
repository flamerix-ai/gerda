// Storage-network domain: pure routing + drawer-slot geometry for the base "storage
// memory" (docs/MISSIONS.md). The kernel storage-dump mission reads the `storages`
// registry + each container's LIVE contents (via the facade), then this module decides,
// per item, WHICH container + slot it goes to — type-match → same-category → empty —
// nearest within a tier. jsMacros-free and unit-tested; the mission only executes the plan.
import { idPath } from "@/core/prim/pos";
import type { Vec3 } from "@/core/runtime/types";
import type { RecordedItem, StorageMarker } from "@/shared/domain/world-model";

export type { StorageMarker } from "@/shared/domain/world-model";

/** An item id + count — the unit of stored/depositable inventory. Same shape as the world-
 *  model's RecordedItem (the persisted chest "memory"), so they interchange structurally. */
export type StoredItem = RecordedItem;

/** A storage's live contents (read via the facade at deposit time). slots[i] = null = empty.
 *  For drawers, one entry per drawer slot (1/2/4); for chests/barrels, one per inventory slot. */
export interface StorageState {
  readonly marker: StorageMarker;
  readonly slots: ReadonlyArray<StoredItem | null>;
}

export type DepositReason = "type-match" | "category" | "empty";

export interface DepositTarget {
  readonly marker: StorageMarker;
  /** Drawer slot to aim at (0-based) — used to compute the look quadrant. -1 for
   *  chests/barrels, where a shift-click finds the slot itself. */
  readonly slot: number;
  readonly reason: DepositReason;
}

// ── item categories (the "similar" grouping) ─────────────────────────────────
// Pure substring heuristic over the item path — good enough for the GTCEu/vanilla ore
// economy (raw ore, ingots, dusts, plates, gems, wood, fuel). A magic-free SSOT a caller
// can extend; richer tag-based grouping can replace this later without touching routing.
const CATEGORY_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/raw_[a-z]/, "ore"],
  [/_ore$|_ore_/, "ore"],
  [/ingot/, "ingot"],
  [/nugget/, "nugget"],
  [/dust|powder/, "dust"],
  [/plate/, "plate"],
  [/gem|diamond|emerald|amethyst|ruby|sapphire|lapis|quartz/, "gem"],
  [/log$|planks$|_wood$|_stem$|stripped_/, "wood"],
  [/coal|charcoal|coke/, "fuel"],
];

/** Coarse category of an item id (namespace stripped), for same-category consolidation. */
export function categoryOf(itemId: string): string {
  const path = idPath(itemId);
  for (const [re, cat] of CATEGORY_RULES) if (re.test(path)) return cat;
  return "misc";
}

/** Max items per slot for a stackable item — a vanilla game invariant (Item.getMaxStackSize
 *  default 64), not a pack tunable, so it lives here as a named domain const (like the
 *  movement-physics constants) rather than in src/shared/config/schema.ts. */
const CHEST_STACK_MAX = 64;

function manhattan(m: StorageMarker, p: Vec3): number {
  return Math.abs(m.x - p.x) + Math.abs(m.y - p.y) + Math.abs(m.z - p.z);
}

interface Classification {
  readonly slot: number;
  readonly reason: DepositReason;
}

/** Can `state` accept `itemId`, and via which slot/reason? Drawers: a matching slot
 *  (merge) → an empty slot (assign). Chests: a same-item stack with room → an empty slot.
 *  The reason is the BEST affinity available (type-match > category > empty); null = can't. */
function classify(state: StorageState, itemId: string, cat: string): Classification | null {
  const { slots } = state;
  const sameCategory = slots.some((s) => s !== null && categoryOf(s.id) === cat);

  if (state.marker.kind === "drawer") {
    let empty = -1;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s && s.id === itemId) return { slot: i, reason: "type-match" }; // merge
      if (!s && empty < 0) empty = i;
    }
    if (empty < 0) return null; // every slot typed to other items
    return { slot: empty, reason: sameCategory ? "category" : "empty" };
  }

  // chest / barrel / generic container — a shift-click lands the stack, so slot = -1.
  const hasItemRoom = slots.some((s) => s !== null && s.id === itemId && s.count < CHEST_STACK_MAX);
  if (hasItemRoom) return { slot: -1, reason: "type-match" };
  const hasEmpty = slots.some((s) => s === null);
  if (!hasEmpty) return null;
  return { slot: -1, reason: sameCategory ? "category" : "empty" };
}

const REASON_RANK: Record<DepositReason, number> = { "type-match": 0, category: 1, empty: 2 };

/** Pick the best container+slot for `itemId`: by affinity tier (type-match → category →
 *  empty), nearest-first within a tier. Returns null when no registered storage can take it. */
export function pickStorageTarget(
  itemId: string,
  states: readonly StorageState[],
  from: Vec3,
): DepositTarget | null {
  const cat = categoryOf(itemId);
  let best: { target: DepositTarget; rank: number; dist: number } | null = null;
  for (const state of states) {
    const c = classify(state, itemId, cat);
    if (!c) continue;
    const rank = REASON_RANK[c.reason];
    const dist = manhattan(state.marker, from);
    if (best === null || rank < best.rank || (rank === best.rank && dist < best.dist)) {
      best = { target: { marker: state.marker, slot: c.slot, reason: c.reason }, rank, dist };
    }
  }
  return best?.target ?? null;
}

// ── multi-item planning ──────────────────────────────────────────────────────────────────
// pickStorageTarget routes ONE item; a deposit run carries several. Planning them all up
// front against a frozen snapshot would double-assign the same empty slot to two new types,
// so we plan against a MUTABLE working copy: each chosen deposit is applied before routing the
// next item, so the second new type sees the first's slot as taken. Pure + testable; the
// mission just walks the resulting legs. Drawers re-read live next run, so any drift self-heals.

export interface DepositLeg extends DepositTarget {
  readonly itemId: string;
  readonly count: number;
}

interface WorkingState {
  readonly marker: StorageMarker;
  readonly slots: (StoredItem | null)[];
}

/** Apply a planned deposit to the working slots so later items route against the new state. */
function applyDeposit(ws: WorkingState, target: DepositTarget, item: StoredItem): void {
  if (ws.marker.kind === "drawer") {
    const cur = ws.slots[target.slot];
    ws.slots[target.slot] = cur ? { id: cur.id, count: cur.count + item.count } : { ...item };
    return;
  }
  // chest/barrel: merge into same-id stacks (cap 64), then fill empties in 64-chunks.
  let remaining = item.count;
  for (let i = 0; i < ws.slots.length && remaining > 0; i++) {
    const s = ws.slots[i];
    if (s && s.id === item.id && s.count < CHEST_STACK_MAX) {
      const add = Math.min(CHEST_STACK_MAX - s.count, remaining);
      ws.slots[i] = { id: s.id, count: s.count + add };
      remaining -= add;
    }
  }
  for (let i = 0; i < ws.slots.length && remaining > 0; i++) {
    if (ws.slots[i] === null) {
      const add = Math.min(CHEST_STACK_MAX, remaining);
      ws.slots[i] = { id: item.id, count: add };
      remaining -= add;
    }
  }
}

export interface DepositPlan {
  readonly legs: readonly DepositLeg[];
  /** Item ids no registered storage could take (the network is full / mistyped) — the
   *  caller logs these; they stay in the bag rather than being silently dropped. */
  readonly unplaced: readonly string[];
}

/** Route a whole bag of items into the storage network: one leg per item, each planned against
 *  the state left by the previous (so two new types don't claim the same empty slot). */
export function planDeposits(
  items: readonly StoredItem[],
  states: readonly StorageState[],
  from: Vec3,
): DepositPlan {
  const work: WorkingState[] = states.map((s) => ({
    marker: s.marker,
    slots: s.slots.map((x) => (x ? { ...x } : null)),
  }));
  const legs: DepositLeg[] = [];
  const unplaced: string[] = [];
  for (const item of items) {
    const target = pickStorageTarget(item.id, work, from);
    const ws = target ? work.find((w) => w.marker === target.marker) : undefined;
    if (!target || !ws) {
      unplaced.push(item.id);
      continue;
    }
    applyDeposit(ws, target, item);
    legs.push({ ...target, itemId: item.id, count: item.count });
  }
  return { legs, unplaced };
}

// ── drawer slot geometry (ported from the live-proven ext.js drawer_deposit) ─────────────
// The deposit slot is chosen by where the player LOOKS: DrawerBlock.getHit() raycasts the
// eye vector against per-slot sub-boxes. So to target slot N we aim at its quadrant centre.
// Geometry from DrawerBlock.CACHED_SHAPES + getHit index order (decompiled FunctionalStorage):
//   X_1 = whole face; X_2 = vertical split (0 bottom, 1 top); X_4 = 2×2 (bottom-A, bottom-B,
//   top-A, top-B). Only ONE-aim-point-PER-quadrant matters (boundaries at 0.5), so the A/B
//   label order is cosmetic — assign and merge use the same point. h = horizontal-in-face
//   (X for N/S facing, Z for E/W), v = vertical (Y); 0.03/0.97 = the shallow slot box.
function localPoint(facing: string, h: number, v: number): Vec3 {
  if (facing === "south") return { x: h, y: v, z: 0.97 };
  if (facing === "west") return { x: 0.03, y: v, z: h };
  if (facing === "east") return { x: 0.97, y: v, z: h };
  return { x: h, y: v, z: 0.03 }; // north (default)
}

function quadrantOffsets(nSlots: number, facing: string): Vec3[] {
  if (nSlots <= 1) return [localPoint(facing, 0.5, 0.5)];
  if (nSlots === 2) return [localPoint(facing, 0.5, 0.25), localPoint(facing, 0.5, 0.75)];
  const ab: Record<string, readonly [number, number]> = {
    south: [0.75, 0.25],
    north: [0.25, 0.75],
    east: [0.25, 0.75],
    west: [0.75, 0.25],
  };
  const [a, b] = ab[facing] ?? [0.25, 0.75];
  return [
    localPoint(facing, a, 0.25),
    localPoint(facing, b, 0.25),
    localPoint(facing, a, 0.75),
    localPoint(facing, b, 0.75),
  ];
}

/** World point to aim at (lookAt) so a drawer use-interaction lands in `slot`. */
export function drawerQuadrantPoint(
  block: Vec3,
  nSlots: number,
  facing: string,
  slot: number,
): Vec3 {
  const offs = quadrantOffsets(nSlots, facing);
  const o = offs[slot] ?? offs[0] ?? { x: 0.5, y: 0.5, z: 0.5 };
  return { x: block.x + o.x, y: block.y + o.y, z: block.z + o.z };
}
