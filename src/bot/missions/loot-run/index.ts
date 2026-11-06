import { walkTo } from "@/bot/missions/_goto-leg";
import { parseIdList } from "@/bot/missions/_params";
import { STATE, type State } from "@/bot/profile/states";
import { dist } from "@/core/prim/pos";
import type { Container } from "@/core/runtime/Runtime";
import type { Vec3 } from "@/core/runtime/types";
// loot-run mission — the inverse of the storage mission: instead of depositing a bag INTO the base,
// it walks the registered containers (chests/barrels scattered through houses), opens each, and
// TAKES everything (or a whitelist) into the carry inventory, then moves to the next.
// Registry-driven: the targets are the `storages` already recorded in mc_world.json — so the
// workflow is "storage_scan the houses as you walk, THEN loot-run sweeps them". Discovery stays a
// separate, composable step (the storage_scan ext / storage_add); this mission only consumes the
// list.
//
// Persistence — "remember what was already looted": once a container is emptied
// it is marked `looted` in mc_world.json, so a later run (or another fleet bot reading the same world
// section) skips it instead of walking back to a ransacked chest. The container's true contents are
// readable here because we OPEN the GUI (the open screen's slots ARE client-synced — unlike a blind
// headless `storage.read` of a closed chest), so the recorded memory we write back is exact.
//
// Never ERROR: an unreachable container / a chest that won't open / a full inventory all just log and
// advance to the next target — looting is best-effort, like the storage mission's skips.
import { classifyBlock } from "@/shared/domain/block-traits";
import { containerRegions, hasContainerOpen } from "@/shared/domain/inventory";
import {
  type RecordedItem,
  type StorageMarker,
  readWorldSection,
  withWorldSection,
} from "@/shared/domain/world-model";
import type { Ctx } from "@/shared/kernel/capability";
import type { PartialTransitionTable } from "@/shared/kernel/fsm";
import type { Mission } from "@/shared/kernel/mission";
import { defineSlice } from "@/shared/kernel/slice";
import { greedyRelease } from "@/shared/nav";
import { type BreakRun, freshBreakRun, stepBreak } from "@/shared/nav/break-cell";

// Containers loot-run takes FROM. Drawers are base storage (the deposit target), not house loot, so
// they're excluded — a loot-run shouldn't empty the bot's own drawers back into its bag.
const LOOTABLE_KINDS = new Set<StorageMarker["kind"]>(["chest", "barrel", "container"]);

type Sub = "OPEN" | "TAKE" | "CLOSE";

interface LootVisit {
  readonly marker: StorageMarker;
  readonly block: Vec3; // the container block
  readonly stand: Vec3; // where to walk to (the block itself — useOnBlock reaches from adjacent)
}

interface LootMem {
  visits: LootVisit[];
  vi: number; // current visit
  sub: Sub;
  subStart: number; // tick the current sub-step began (grace timing)
  opened: boolean; // chest GUI dispatched
  whitelist: string[]; // ids to take; empty = take everything
  remaining: RecordedItem[]; // what's LEFT in the current chest after taking (→ recorded memory on CLOSE)
  emptied: boolean; // current chest is now truly empty after taking (→ `looted` flag on CLOSE)
  tookHere: number; // count moved out of the current chest
  takenTotal: number; // running total across all visits
  breakBlocked: boolean; // mine off a solid block capping a chest instead of skipping it (opt-in)
  breakRun: BreakRun; // AIM→BREAK state for un-capping the current chest
  uncapping: boolean; // currently mining the cap off this chest (→ log LOOT_UNCAPPED once it clears)
  done: boolean;
}

const LOOT_SLICE = defineSlice<LootMem>("loot-run", () => ({
  visits: [],
  vi: 0,
  sub: "OPEN",
  subStart: 0,
  opened: false,
  whitelist: [],
  remaining: [],
  emptied: false,
  tookHere: 0,
  takenTotal: 0,
  breakBlocked: false,
  breakRun: freshBreakRun(),
  uncapping: false,
  done: false,
}));

const mem = (ctx: Ctx): LootMem => ctx.slice(LOOT_SLICE);

const LOOT_EDGES: PartialTransitionTable<State> = {
  GOTO: ["RANSACK", "IDLE", "PAUSED", "ERROR"],
  RANSACK: ["GOTO", "IDLE", "PAUSED", "ERROR"],
};

/** The (slot, item) pairs in the OPEN container's external regions — the chest's true contents,
 *  readable because the screen is open (client-synced). Carry/player regions are excluded. */
function containerEntries(c: Container): { slot: number; id: string; count: number }[] {
  const out: { slot: number; id: string; count: number }[] = [];
  const regions = containerRegions(c.regions());
  if (regions.length === 0) return out;
  for (const slot of c.slots(...regions)) {
    const s = c.slot(slot);
    if (s) out.push({ slot, id: s.id, count: s.count });
  }
  return out;
}

function makeVisit(marker: StorageMarker): LootVisit {
  const block = { x: marker.x, y: marker.y, z: marker.z };
  return { marker, block, stand: block };
}

/** A chest/barrel can't be opened if a solid full cube sits directly on top — the vanilla
 *  `ChestBlock.isChestBlockedAt` rule (decompiled from LootrChestBlock.use → isChestBlockedAt).
 *  Approximated headless from block-traits: an opaque full cube is neither passable (air,
 *  torches, carpets) nor standable (slabs, stairs, glass) — those don't block a chest. City
 *  builds bury decorative Lootr chests under terracotta/stone, so pre-skipping them avoids
 *  wasting the open-grace window on a chest no player could open either. */
function blockedFromAbove(ctx: Ctx, block: Vec3): boolean {
  const above = ctx.rt.world.blockId({ x: block.x, y: block.y + 1, z: block.z });
  if (!above.ok) return false; // unreadable (unloaded chunk) → don't pre-skip; let the open attempt decide
  const t = classifyBlock(above.value);
  return !t.passable && !t.standable;
}

function setSub(ctx: Ctx, m: LootMem, sub: Sub): void {
  m.sub = sub;
  m.subStart = ctx.st.tickCount;
}

function advanceVisit(ctx: Ctx, m: LootMem): void {
  m.vi += 1;
  m.opened = false;
  m.uncapping = false;
  m.breakRun = freshBreakRun();
  if (m.vi >= m.visits.length) {
    finish(ctx, m, "all containers visited");
    return;
  }
  setSub(ctx, m, "OPEN");
  ctx.transition(STATE.GOTO, "loot-run: next container");
}

function finish(ctx: Ctx, m: LootMem, note: string): void {
  void ctx.rt.interact.closeScreen();
  ctx.log.info(ctx.st.tickCount, "LOOT_DONE", { note, taken: m.takenTotal });
  m.done = true;
}

/** Persist the result of looting one container: overwrite its recorded memory with what's LEFT, and
 *  set `looted` when no wanted items remain — so a later run / another fleet bot skips it. Synchronous
 *  read-modify-write on the worker thread (atomic vs persistence's own save), mirroring recordChestDeposit. */
function recordLooted(
  ctx: Ctx,
  visit: LootVisit,
  remaining: readonly RecordedItem[],
  emptied: boolean,
): void {
  const looted = emptied;
  const res = withWorldSection(ctx, (section) => {
    const idx = section.storages.findIndex(
      (s) => s.x === visit.block.x && s.y === visit.block.y && s.z === visit.block.z,
    );
    const marker = section.storages[idx];
    if (idx < 0 || !marker) return null; // unregistered mid-run — nothing to persist
    const recorded: (RecordedItem | null)[] = remaining.map((r) => ({ id: r.id, count: r.count }));
    const updated: StorageMarker = looted
      ? { ...marker, recorded, looted: true, lootedTick: ctx.st.tickCount }
      : { ...marker, recorded };
    const storages = section.storages.map((s, i) => (i === idx ? updated : s));
    return { ...section, storages };
  });
  if (res.status === "written")
    ctx.log.info(ctx.st.tickCount, "LOOT_RECORDED", { pos: visit.block, looted });
  else if (res.status === "write-failed")
    ctx.log.warn(ctx.st.tickCount, "LOOT_RECORD_FAIL", { pos: visit.block, err: res.error });
}

/** Un-cap a chest capped by a solid block (the vanilla isChestBlockedAt rule). Returns "clear" once the
 *  cap is gone (→ proceed to open), "working" while still breaking, "skip" if it can't be broken (logged
 *  + advanced). Gating LOOT_UNCAPPED here (on `m.uncapping` flipping once the world reads air) rather than
 *  on stepBreak's transient "cleared" is deliberate: the cap goes to air async between ticks, so the tick
 *  that sees it clear is NOT the tick stepBreak returned "cleared" — we'd race straight past the log. */
function stepUncap(ctx: Ctx, m: LootMem, visit: LootVisit): "clear" | "working" | "skip" {
  const { rt, st, cfg } = ctx;
  if (blockedFromAbove(ctx, visit.block)) {
    if (!m.breakBlocked) {
      ctx.log.info(st.tickCount, "LOOT_BLOCKED", { pos: visit.block });
      advanceVisit(ctx, m);
      return "skip";
    }
    const cap = { x: visit.block.x, y: visit.block.y + 1, z: visit.block.z };
    m.uncapping = true;
    if (
      stepBreak(rt, cfg, st.tickCount, m.breakRun, cap, "TOP", cfg.loot.capBreakTimeoutTicks) ===
      "timeout"
    ) {
      ctx.log.warn(st.tickCount, "LOOT_BLOCKED", { pos: visit.block, note: "cap unbreakable" });
      advanceVisit(ctx, m);
      return "skip";
    }
    return "working";
  }
  if (m.uncapping) {
    ctx.log.info(st.tickCount, "LOOT_UNCAPPED", {
      cap: { x: visit.block.x, y: visit.block.y + 1, z: visit.block.z },
    });
    m.uncapping = false;
    m.subStart = st.tickCount; // restart the open-grace clock — the break time shouldn't count against it
  }
  return "clear";
}

// ── take-all from an open container (shift-click each wanted slot into the carry inventory) ──────
function stepRansack(ctx: Ctx, m: LootMem, visit: LootVisit): void {
  const { rt, st, cfg } = ctx;
  const whitelist = new Set(m.whitelist);
  const wanted = (id: string): boolean => whitelist.size === 0 || whitelist.has(id);

  if (m.sub === "OPEN") {
    const invR = rt.inv.open();
    if (invR.ok && hasContainerOpen(invR.value.regions())) {
      setSub(ctx, m, "TAKE");
      return;
    }
    if (!m.opened) {
      // A chest capped by a solid block won't open for anyone (vanilla isChestBlockedAt) — mine the
      // cap off (breakBlocked) or skip it; only fall through to open once the cap is clear.
      if (stepUncap(ctx, m, visit) !== "clear") return;
      void rt.interact.useOnBlock(visit.block, "TOP");
      m.opened = true;
      return;
    }
    if (st.tickCount - m.subStart > cfg.containerOpenGraceTicks) {
      ctx.log.warn(st.tickCount, "LOOT_NO_GUI", { pos: visit.block });
      advanceVisit(ctx, m); // chest won't open (blocked / not a container) → skip
    }
    return;
  }

  if (m.sub === "TAKE") {
    const invR = rt.inv.open();
    if (!invR.ok) {
      ctx.log.warn(st.tickCount, "LOOT_LOST_CHEST", { pos: visit.block });
      advanceVisit(ctx, m);
      return;
    }
    const inv = invR.value;
    const before = containerEntries(inv);
    const wantedBefore = before.filter((e) => wanted(e.id));
    // highest slot first so a compacting container impl doesn't shift indices mid-loop.
    for (const e of [...wantedBefore].sort((a, b) => b.slot - a.slot)) inv.quick(e.slot);
    // Re-read the open container: what's LEFT is the new memory; what's GONE is what we took.
    const reread = rt.inv.open();
    const after = reread.ok ? containerEntries(reread.value) : before;
    const leftWanted = after.filter((e) => wanted(e.id));
    const beforeWantedCount = wantedBefore.reduce((n, e) => n + e.count, 0);
    const leftWantedCount = leftWanted.reduce((n, e) => n + e.count, 0);
    m.tookHere = beforeWantedCount - leftWantedCount;
    m.takenTotal += m.tookHere;
    m.remaining = after.map((e) => ({ id: e.id, count: e.count }));
    // `looted` = the chest is now TRULY empty, not merely empty of the whitelist — so a whitelist
    // run that leaves other items doesn't permanently hide the chest from a later take-everything.
    m.emptied = after.length === 0;
    if (m.tookHere === 0 && beforeWantedCount > 0)
      ctx.log.warn(st.tickCount, "LOOT_FULL", { pos: visit.block, want: beforeWantedCount });
    else if (m.tookHere > 0)
      ctx.log.info(st.tickCount, "LOOT_TOOK", { pos: visit.block, n: m.tookHere });
    setSub(ctx, m, "CLOSE");
    return;
  }

  // CLOSE — shut the GUI, persist the leftover memory + `looted` flag, then advance.
  void rt.interact.closeScreen();
  recordLooted(ctx, visit, m.remaining, m.emptied);
  m.remaining = [];
  m.emptied = false;
  advanceVisit(ctx, m);
}

export const lootRunMission: Mission = {
  name: "loot-run",
  params: [
    {
      name: "items",
      type: "string",
      required: false,
      desc: 'only take these ids — JSON array ["minecraft:gold_ingot"] or CSV; omit = take everything',
    },
    {
      name: "near",
      type: "int",
      required: false,
      desc: "only loot containers within this many blocks of the start (omit = all registered)",
    },
    {
      name: "breakBlocked",
      type: "bool",
      required: false,
      desc: "mine off a solid block capping a chest instead of skipping it (leaves a hole; opt-in)",
    },
  ],

  edges: LOOT_EDGES,
  initialPhase: STATE.GOTO,
  movementPhases: new Set([STATE.GOTO]),

  init(ctx: Ctx, params: Record<string, unknown>): void {
    const m = mem(ctx);
    m.visits = [];
    m.vi = 0;
    m.opened = false;
    m.remaining = [];
    m.emptied = false;
    m.tookHere = 0;
    m.takenTotal = 0;
    m.done = false;
    m.breakRun = freshBreakRun();
    m.uncapping = false;
    m.breakBlocked = params["breakBlocked"] === true || params["breakBlocked"] === "true";
    m.whitelist = parseIdList(params["items"]);

    const posR = ctx.rt.player.pos();
    const sigR = ctx.rt.world.signature();
    if (!(posR.ok && sigR.ok)) {
      m.done = true;
      return;
    }
    const nearRaw = params["near"];
    const near = typeof nearRaw === "number" ? nearRaw : null;

    const markers = readWorldSection(ctx)?.storages ?? [];

    const here = posR.value;
    const candidates = markers.filter(
      (s) =>
        LOOTABLE_KINDS.has(s.kind) &&
        s.looted !== true &&
        (near === null || dist(here, { x: s.x, y: s.y, z: s.z }) <= near),
    );
    if (candidates.length === 0) {
      ctx.log.info(ctx.st.tickCount, "LOOT_NONE", {
        registered: markers.length,
        hint: "storage_scan the houses first (looted ones are skipped)",
      });
      m.done = true;
      return;
    }

    // greedy nearest-neighbour visit order (mirrors the storage mission).
    const pool = candidates.map(makeVisit);
    const ordered: LootVisit[] = [];
    let cur = here;
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
    m.visits = ordered;
    setSub(ctx, m, "OPEN");
    ctx.log.info(ctx.st.tickCount, "LOOT_PLAN", {
      containers: m.visits.length,
      want: m.whitelist.length === 0 ? "all" : m.whitelist,
      near,
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
      const skip = (event: "LOOT_GOTO_TIMEOUT" | "LOOT_GOTO_BLOCKED"): void => {
        greedyRelease(rt);
        ctx.log.warn(st.tickCount, event, { stand: visit.stand });
        advanceVisit(ctx, m); // can't reach it → skip, leave it un-looted for a later run
      };
      walkTo(ctx, visit.stand, {
        onArrive: () => {
          greedyRelease(rt);
          setSub(ctx, m, "OPEN");
          m.opened = false;
          ctx.transition(STATE.RANSACK, "loot-run arrived");
        },
        onTimeout: () => skip("LOOT_GOTO_TIMEOUT"),
        onBlocked: () => skip("LOOT_GOTO_BLOCKED"),
      });
    },

    RANSACK(ctx: Ctx): void {
      const m = mem(ctx);
      const visit = m.visits[m.vi];
      if (!visit) {
        m.done = true;
        return;
      }
      stepRansack(ctx, m, visit);
    },
  },

  isDone(ctx: Ctx): boolean {
    return mem(ctx).done;
  },

  outputs(ctx: Ctx): Record<string, unknown> {
    const m = mem(ctx);
    return { taken: m.takenTotal, containers: m.visits.length };
  },

  onAbort(ctx: Ctx): void {
    void ctx.rt.interact.closeScreen();
    ctx.rt.nav.stop();
  },
};
