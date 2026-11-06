import { walkTo } from "@/bot/missions/_goto-leg";
import { toSet } from "@/bot/missions/_params";
import { STATE, type State } from "@/bot/profile/states";
import { dist } from "@/core/prim/pos";
import type { Container } from "@/core/runtime/Runtime";
import type { Face, Vec3 } from "@/core/runtime/types";
// storage mission — the kernel-native "storage network" deposit: smart-route a bag of items into
// the configured base. Reads the `storages` registry (mc_world.json), builds each container's
// contents, plans a deposit per item (type-match → same-category → empty, nearest within a tier;
// see domain/storage.ts), groups the legs into per-container VISITS ordered nearest-first, then
// walks and deposits. This is the autonomous counterpart of the host-only drawer_deposit ext.
//
// Container contents (the routing input) come from two sources — the client-sync boundary
// (a headless client reads only what the server syncs to it): DRAWERS are read LIVE via rt.storage.read (their
// contents replicate client-side); CHESTS/BARRELS are server-only headless, so they route from the
// RECORDED snapshot in the registry (the "chest memory"). Deposit mechanics also differ:
//   • drawer — a USE interaction deposits the HELD stack into the slot the player LOOKS at, so we
//     stand in front, hold the item, aim the slot quadrant, useOnBlock; repeat per held stack.
//   • chest  — open the GUI + shift-click (vanilla auto-route), identical to the stash mission.
import { carryCount, carrySlots, hasContainerOpen } from "@/shared/domain/inventory";
import {
  type StorageState,
  type StoredItem,
  drawerQuadrantPoint,
  planDeposits,
} from "@/shared/domain/storage";
import {
  type RecordedItem,
  type StorageMarker,
  readWorldSection,
  withWorldSection,
} from "@/shared/domain/world-model";
import { holdItemById } from "@/shared/held";
import type { Ctx } from "@/shared/kernel/capability";
import type { PartialTransitionTable } from "@/shared/kernel/fsm";
import type { Mission } from "@/shared/kernel/mission";
import { defineSlice } from "@/shared/kernel/slice";
import { greedyRelease } from "@/shared/nav";

// Vanilla single chest / barrel size — the slot count a chest routes against when the registry
// recorded fewer (so a sparsely-recorded chest still shows its empty capacity). A protocol fact,
// not a tunable (like held.ts's HOTBAR_VANILLA_START=36).
const DEFAULT_CONTAINER_SLOTS = 27;

const FACE_OF: Record<string, Face> = {
  north: "NORTH",
  south: "SOUTH",
  east: "EAST",
  west: "WEST",
};
const FRONT_NORMAL: Record<string, Vec3> = {
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
};

// Drawer deposit is a 3-tick sequence: AIM (hold + lookAt) → USE (useOnBlock, a tick later so
// the new rotation has FLUSHED to the server before its use-raycast — same reason the ext's
// drawer_deposit waitTick(1)s between lookAt and interactBlock; without the gap the server
// raycasts the OLD look and the stack lands in the wrong slot / is rejected) → VERIFY.
type Sub = "AIM" | "USE" | "VERIFY" | "OPEN" | "SHIFT" | "CLOSE";

interface VisitLeg {
  readonly itemId: string;
  readonly slot: number; // drawer slot to aim (-1 for chests)
}

interface Visit {
  readonly marker: StorageMarker;
  readonly kind: StorageMarker["kind"];
  readonly facing: string;
  readonly nSlots: number;
  readonly block: Vec3; // the container block
  readonly stand: Vec3; // where to walk to (in front of a drawer; the chest itself otherwise)
  readonly legs: VisitLeg[];
}

interface StorageMem {
  visits: Visit[];
  vi: number; // current visit
  legi: number; // current leg within the visit
  sub: Sub;
  subStart: number; // tick the current sub-step began (grace timing)
  before: number; // carry count of the current itemId before a drawer use (verify hook)
  opened: boolean; // chest GUI dispatched
  deposited: number;
  deposits: RecordedItem[]; // what the CURRENT chest visit moved (→ recorded memory on CLOSE)
  unplaced: string[];
  done: boolean;
}

const STORAGE_SLICE = defineSlice<StorageMem>("storage", () => ({
  visits: [],
  vi: 0,
  legi: 0,
  sub: "AIM",
  subStart: 0,
  before: 0,
  opened: false,
  deposited: 0,
  deposits: [],
  unplaced: [],
  done: false,
}));

const mem = (ctx: Ctx): StorageMem => ctx.slice(STORAGE_SLICE);

const STORAGE_EDGES: PartialTransitionTable<State> = {
  GOTO: ["STORE", "IDLE", "PAUSED", "ERROR"],
  STORE: ["GOTO", "IDLE", "PAUSED", "ERROR"],
};

/** Aggregate the carry inventory into {id,count} for the whitelisted ids (planning input). */
function bagItems(c: Container, ids: ReadonlySet<string>): StoredItem[] {
  const sum = new Map<string, number>();
  for (const slot of c.slots()) {
    const s = c.slot(slot);
    if (s && ids.has(s.id)) sum.set(s.id, (sum.get(s.id) ?? 0) + s.count);
  }
  return [...sum.entries()].map(([id, count]) => ({ id, count }));
}

/** Read each registered storage's contents: drawers LIVE (rt.storage.read), chests/barrels from
 *  the recorded snapshot, padded to the container's slot capacity so empty room stays routable. */
function buildStates(ctx: Ctx, markers: readonly StorageMarker[]): StorageState[] {
  const out: StorageState[] = [];
  for (const m of markers) {
    if (m.kind === "drawer") {
      const r = ctx.rt.storage.read({ x: m.x, y: m.y, z: m.z });
      if (r.ok) {
        const liveFacing = r.value.facing ?? m.facing;
        out.push({
          marker: liveFacing ? { ...m, facing: liveFacing } : m,
          slots: r.value.slots.map((s) => (s ? { id: s.id, count: s.count } : null)),
        });
        continue;
      }
      ctx.log.warn(ctx.st.tickCount, "STORAGE_READ_FAIL", { pos: [m.x, m.y, m.z], err: r.error });
    }
    const recorded = m.recorded ?? [];
    const size = m.slots ?? (m.kind === "drawer" ? recorded.length : DEFAULT_CONTAINER_SLOTS);
    const slots = Array.from({ length: Math.max(size, recorded.length) }, (_, i) => {
      const s = recorded[i];
      return s ? { id: s.id, count: s.count } : null;
    });
    out.push({ marker: m, slots });
  }
  return out;
}

function makeVisit(marker: StorageMarker, state: StorageState): Visit {
  const block = { x: marker.x, y: marker.y, z: marker.z };
  const facing = marker.facing ?? "north";
  const isDrawer = marker.kind === "drawer";
  const n = FRONT_NORMAL[facing] ?? FRONT_NORMAL["north"];
  const off = isDrawer && n ? n : { x: 0, y: 0, z: 0 };
  return {
    marker,
    kind: marker.kind,
    facing,
    nSlots: state.slots.length,
    block,
    stand: { x: block.x + off.x, y: block.y, z: block.z + off.z },
    legs: [],
  };
}

/** Group the planned legs into per-container visits, ordered nearest-first from `from`. */
function planVisits(
  legs: ReturnType<typeof planDeposits>["legs"],
  states: readonly StorageState[],
  from: Vec3,
): Visit[] {
  const byPos = new Map<string, Visit>();
  for (const leg of legs) {
    const m = leg.marker;
    const key = `${m.x},${m.y},${m.z}`;
    let v = byPos.get(key);
    if (!v) {
      const state = states.find((s) => s.marker === m) ?? { marker: m, slots: [] };
      v = makeVisit(m, state);
      byPos.set(key, v);
    }
    v.legs.push({ itemId: leg.itemId, slot: leg.slot });
  }
  // greedy nearest-neighbour visit order (a base's storages cluster, so this is plenty).
  const pool = [...byPos.values()];
  const ordered: Visit[] = [];
  let cur = from;
  while (pool.length > 0) {
    let bi = 0;
    for (let i = 1; i < pool.length; i++) {
      const a = pool[i];
      const b = pool[bi];
      if (a && b && dist(cur, a.stand) < dist(cur, b.stand)) bi = i;
    }
    const next = pool.splice(bi, 1)[0];
    if (!next) break;
    ordered.push(next);
    cur = next.stand;
  }
  return ordered;
}

function setSub(ctx: Ctx, m: StorageMem, sub: Sub): void {
  m.sub = sub;
  m.subStart = ctx.st.tickCount;
}

function advanceVisit(ctx: Ctx, m: StorageMem): void {
  m.vi += 1;
  m.legi = 0;
  if (m.vi >= m.visits.length) {
    finish(ctx, m, "all visits done");
    return;
  }
  ctx.transition(STATE.GOTO, "storage: next visit");
}

function advanceLeg(ctx: Ctx, m: StorageMem, visit: Visit): void {
  m.legi += 1;
  if (m.legi >= visit.legs.length) {
    advanceVisit(ctx, m);
    return;
  }
  setSub(ctx, m, "AIM");
}

function finish(ctx: Ctx, m: StorageMem, note: string): void {
  void ctx.rt.interact.closeScreen();
  if (m.unplaced.length > 0) {
    ctx.log.warn(ctx.st.tickCount, "STORAGE_UNPLACED", { ids: m.unplaced });
  }
  ctx.log.info(ctx.st.tickCount, "STORAGE_DONE", { note, deposited: m.deposited });
  m.done = true;
}

// ── drawer deposit (hold → aim slot quadrant → use; repeat per held stack) ────────────────────
function stepDrawer(ctx: Ctx, m: StorageMem, visit: Visit): void {
  const { rt, st, cfg } = ctx;
  const leg = visit.legs[m.legi];
  if (!leg) {
    advanceVisit(ctx, m);
    return;
  }
  const ids = new Set([leg.itemId]);

  if (m.sub === "AIM") {
    const invR = rt.inv.open();
    if (!invR.ok) {
      ctx.log.warn(st.tickCount, "STORAGE_NO_INV", { phase: "drawer" });
      advanceLeg(ctx, m, visit);
      return;
    }
    const inv = invR.value;
    if (holdItemById(inv, leg.itemId) < 0) {
      advanceLeg(ctx, m, visit); // nothing left of this id on hand
      return;
    }
    // Aim the slot's quadrant THIS tick; the use fires next tick so the rotation flushes first.
    const point = drawerQuadrantPoint(visit.block, visit.nSlots, visit.facing, leg.slot);
    void rt.interact.lookAt(point);
    setSub(ctx, m, "USE");
    return;
  }

  if (m.sub === "USE") {
    const invR = rt.inv.open();
    m.before = invR.ok ? carryCount(invR.value, ids) : 0;
    void rt.interact.useOnBlock(visit.block, FACE_OF[visit.facing] ?? "NORTH");
    setSub(ctx, m, "VERIFY");
    return;
  }

  // VERIFY — the deposit is server-authoritative; a same-tick read is stale, so wait the grace.
  if (st.tickCount - m.subStart < cfg.storageDepositGraceTicks) return;
  const invR = rt.inv.open();
  const after = invR.ok ? carryCount(invR.value, ids) : m.before;
  if (after < m.before) {
    m.deposited += m.before - after;
    setSub(ctx, m, "AIM"); // more stacks of this id may remain in other carry slots
    return;
  }
  // nothing dropped after the grace → the slot wouldn't take it (full / no LOS). Skip, don't ERROR.
  ctx.log.warn(st.tickCount, "STORAGE_DRAWER_BLOCKED", { item: leg.itemId, pos: visit.block });
  advanceLeg(ctx, m, visit);
}

// ── chest deposit (open GUI + shift-click whitelisted ids; identical to the stash mission) ─────
function stepChest(ctx: Ctx, m: StorageMem, visit: Visit): void {
  const { rt, st, cfg } = ctx;
  const ids = new Set(visit.legs.map((l) => l.itemId));

  if (m.sub === "OPEN") {
    const invR = rt.inv.open();
    if (invR.ok && hasContainerOpen(invR.value.regions())) {
      setSub(ctx, m, "SHIFT");
      return;
    }
    if (!m.opened) {
      void rt.interact.useOnBlock(visit.block, "TOP");
      m.opened = true;
      return;
    }
    if (st.tickCount - m.subStart > cfg.containerOpenGraceTicks) {
      ctx.log.warn(st.tickCount, "STORAGE_CHEST_NO_GUI", { pos: visit.block });
      advanceVisit(ctx, m); // skip this chest, keep the items, move on
    }
    return;
  }

  if (m.sub === "SHIFT") {
    const invR = rt.inv.open();
    if (!invR.ok) {
      ctx.log.warn(st.tickCount, "STORAGE_LOST_CHEST", { pos: visit.block });
      advanceVisit(ctx, m);
      return;
    }
    const inv = invR.value;
    const idList = [...ids];
    const beforeById = new Map(idList.map((id) => [id, carryCount(inv, new Set([id]))]));
    // highest slot first so a compacting container impl doesn't shift indices mid-loop.
    for (const slot of carrySlots(inv, ids).sort((a, b) => b - a)) inv.quick(slot);
    const reread = rt.inv.open();
    const after = reread.ok ? reread.value : inv;
    // Per-id moved → both the running total AND the recorded memory written on CLOSE.
    m.deposits = [];
    let movedTotal = 0;
    let onHand = 0;
    for (const id of idList) {
      const b = beforeById.get(id) ?? 0;
      onHand += b;
      const mvd = b - carryCount(after, new Set([id]));
      if (mvd > 0) {
        m.deposits.push({ id, count: mvd });
        movedTotal += mvd;
      }
    }
    m.deposited += movedTotal;
    if (movedTotal === 0 && onHand > 0)
      ctx.log.warn(st.tickCount, "STORAGE_CHEST_BLOCKED", { pos: visit.block, onHand });
    setSub(ctx, m, "CLOSE");
    return;
  }

  // CLOSE — shut the GUI, then record what we deposited into the chest's memory (its true
  // contents are server-only/headless-blind, so the memory IS what we put in) before moving on.
  void rt.interact.closeScreen();
  m.opened = false;
  recordChestDeposit(ctx, visit, m.deposits);
  m.deposits = [];
  advanceVisit(ctx, m);
}

/** Merge `count` of `id` into a recorded slot snapshot (same-id stacks ≤64, then new slots up to
 *  the container's capacity). Overflow past capacity is dropped from memory (chest is full). */
function addRecorded(
  recorded: (RecordedItem | null)[],
  id: string,
  count: number,
  cap: number,
): void {
  let rem = count;
  for (let i = 0; i < recorded.length && rem > 0; i++) {
    const s = recorded[i];
    if (s && s.id === id && s.count < 64) {
      const add = Math.min(64 - s.count, rem);
      recorded[i] = { id, count: s.count + add };
      rem -= add;
    }
  }
  while (rem > 0 && recorded.length < cap) {
    const add = Math.min(64, rem);
    recorded.push({ id, count: add });
    rem -= add;
  }
}

/** Update a chest/barrel marker's recorded contents in mc_world.json after a deposit (the
 *  "chest memory" — drawers route from a live read, so they don't need this). A synchronous
 *  read-modify-write on the worker thread, so it's atomic vs persistence's own save. */
function recordChestDeposit(ctx: Ctx, visit: Visit, deposits: readonly RecordedItem[]): void {
  if (deposits.length === 0) return;
  const res = withWorldSection(ctx, (section) => {
    const idx = section.storages.findIndex(
      (s) => s.x === visit.block.x && s.y === visit.block.y && s.z === visit.block.z,
    );
    const marker = section.storages[idx];
    if (idx < 0 || !marker) return null; // not registered (manually removed mid-run) — nothing to record
    const cap = marker.slots ?? DEFAULT_CONTAINER_SLOTS;
    const recorded: (RecordedItem | null)[] = [...(marker.recorded ?? [])];
    for (const d of deposits) addRecorded(recorded, d.id, d.count, cap);
    const storages = section.storages.map((s, i) => (i === idx ? { ...marker, recorded } : s));
    return { ...section, storages };
  });
  if (res.status === "written")
    ctx.log.info(ctx.st.tickCount, "STORAGE_RECORDED", { pos: visit.block, ids: deposits.length });
  else if (res.status === "write-failed")
    ctx.log.warn(ctx.st.tickCount, "STORAGE_RECORD_FAIL", { pos: visit.block, err: res.error });
}

export const storageMission: Mission = {
  name: "storage",
  params: [
    {
      name: "items",
      type: "string",
      required: true,
      desc: 'ids to deposit into the storage network — JSON array ["minecraft:raw_iron"] or CSV',
    },
  ],

  edges: STORAGE_EDGES,
  initialPhase: STATE.GOTO,
  movementPhases: new Set([STATE.GOTO]),

  init(ctx: Ctx, params: Record<string, unknown>): void {
    const m = mem(ctx);
    m.visits = [];
    m.vi = 0;
    m.legi = 0;
    m.opened = false;
    m.deposited = 0;
    m.deposits = [];
    m.unplaced = [];
    m.done = false;

    const whitelist = toSet(params["items"]);
    const posR = ctx.rt.player.pos();
    const sigR = ctx.rt.world.signature();
    if (!(posR.ok && sigR.ok) || whitelist.size === 0) {
      m.done = true;
      return;
    }
    const invR = ctx.rt.inv.open();
    if (!invR.ok) {
      m.done = true;
      return;
    }
    const items = bagItems(invR.value, whitelist);
    if (items.length === 0) {
      ctx.log.info(ctx.st.tickCount, "STORAGE_NOTHING", { want: [...whitelist] });
      m.done = true;
      return;
    }

    const markers = readWorldSection(ctx)?.storages ?? [];
    if (markers.length === 0) {
      ctx.log.warn(ctx.st.tickCount, "STORAGE_NO_REGISTRY", { hint: "scan/add storages first" });
      m.done = true;
      return;
    }

    const states = buildStates(ctx, markers);
    const plan = planDeposits(items, states, posR.value);
    m.unplaced = [...plan.unplaced];
    m.visits = planVisits(plan.legs, states, posR.value);
    if (m.visits.length === 0) {
      finish(ctx, m, "nothing routable");
      return;
    }
    setSub(ctx, m, m.visits[0]?.kind === "drawer" ? "AIM" : "OPEN");
    ctx.log.info(ctx.st.tickCount, "STORAGE_PLAN", {
      visits: m.visits.length,
      legs: plan.legs.length,
      unplaced: m.unplaced.length,
    });
  },

  handlers: {
    GOTO(ctx: Ctx): void {
      const { rt, st } = ctx;
      const m = mem(ctx);
      const visit = m.visits[m.vi];
      if (!visit) {
        m.done = true;
        return;
      }
      const skip = (event: "STORAGE_GOTO_TIMEOUT" | "STORAGE_GOTO_BLOCKED"): void => {
        greedyRelease(rt);
        ctx.log.warn(st.tickCount, event, { stand: visit.stand });
        advanceVisit(ctx, m); // can't reach it → skip, keep items
      };
      walkTo(ctx, visit.stand, {
        onArrive: () => {
          greedyRelease(rt);
          setSub(ctx, m, visit.kind === "drawer" ? "AIM" : "OPEN");
          m.opened = false;
          ctx.transition(STATE.STORE, "storage arrived");
        },
        onTimeout: () => skip("STORAGE_GOTO_TIMEOUT"),
        onBlocked: () => skip("STORAGE_GOTO_BLOCKED"),
      });
    },

    STORE(ctx: Ctx): void {
      const m = mem(ctx);
      const visit = m.visits[m.vi];
      if (!visit) {
        m.done = true;
        return;
      }
      if (visit.kind === "drawer") stepDrawer(ctx, m, visit);
      else stepChest(ctx, m, visit);
    },
  },

  isDone(ctx: Ctx): boolean {
    return mem(ctx).done;
  },

  outputs(ctx: Ctx): Record<string, unknown> {
    const m = mem(ctx);
    return { deposited: m.deposited, unplaced: m.unplaced };
  },

  onAbort(ctx: Ctx): void {
    void ctx.rt.interact.closeScreen();
    ctx.rt.nav.stop();
  },
};
