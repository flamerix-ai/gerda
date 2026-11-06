import { STATE, type State } from "@/bot/profile/states";
import { asRecord } from "@/core/prim/typed-object";
import type { Container } from "@/core/runtime/Runtime";
import type { Vec3 } from "@/core/runtime/types";
import type { CraftChainStep } from "@/shared/config/schema";
import { carryCount } from "@/shared/domain/inventory";
import { equipSlot } from "@/shared/held";
// craft mission — execute a recipe chain by MANUAL GRID PLACEMENT. The recipe-book API is
// dead on Monifactory (verified live), so each chain
// step carries its grid layout; we place ingredients into the open grid and let the SERVER
// compute the result. Crafting is tick-driven: place → wait ≥1 tick for craft_out → take.
//
// Chain steps that fit the 2×2 player grid (≤4 cells) are crafted there (no GUI screen opens —
// the inventory menu accepts slot clicks directly), so world interaction stays available. From
// the FIRST step that needs a 3×3 grid (>4 cells, e.g. a chest or drawer) onward, crafting
// moves to a placed table (place block → useOnBlock to open → craft every remaining step at it
// → close) — a step's output feeds the next from inventory. Data-driven via the `chain` param
// (default: oak logs → planks → table → chest). Stationary. Hand-written (needs params in init).
import type { Ctx } from "@/shared/kernel/capability";
import type { PartialTransitionTable } from "@/shared/kernel/fsm";
import type { Mission } from "@/shared/kernel/mission";
import { defineSlice } from "@/shared/kernel/slice";

const TABLE_ID = "minecraft:crafting_table";
// The bare player survival grid is 2×2 = 4 cells; a 3×3 table screen reports 9. The CLOSE
// step waits for gridSize() to drop to the player grid, confirming no table screen is open.
const PLAYER_GRID_CELLS = 4;
const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);
// Ground cover a block placement replaces (clicking the TOP of the block below swaps these
// out) — savanna foot cells are routinely grass/fern, not air.
const REPLACEABLE = new Set([
  "minecraft:grass",
  "minecraft:short_grass",
  "minecraft:tall_grass",
  "minecraft:fern",
  "minecraft:dead_bush",
  "minecraft:snow",
]);
const isFreeCell = (id: string): boolean => AIR.has(id) || REPLACEABLE.has(id);

// Mission step: close any stale screen → pre-crafts (2×2) → place+open a table → final
// craft (3×3) → done. CLOSE is the entry: a prior aborted craft can leave a 3×3 table
// screen open, and openInventory() then returns THAT grid — so the 2×2 pre-craft recipes
// (e.g. a crafting table = 4 planks in a square) land row-major in the 3×3 and never resolve.
type CraftStep = "CLOSE" | "PRE" | "PLACE_TABLE" | "OPEN_TABLE" | "FINAL" | "DONE";
// Per-craft sub-state (craft_out fills a tick AFTER placement, so place and take split).
type CraftPhase = "PLACE" | "WAIT" | "TAKE";

interface CraftMem {
  step: CraftStep;
  chain: CraftChainStep[];
  idx: number; // current chain index being crafted
  remaining: number; // crafts left for the current step (counts down from `times`)
  phase: CraftPhase;
  placeTable: boolean;
  // Index of the first chain step whose grid needs a 3×3 table (grid.length > the 2×2 player
  // grid); steps [0..tableStart) craft in the player grid, [tableStart..end] at the table.
  // chain.length when no step needs a table (everything fits the 2×2 player grid).
  tableStart: number;
  tablePos: Vec3 | null;
  producedId: string | null; // last result id (for `outputs`)
  stepStart: number;
  // Tick of the last table place/open re-fire — PLACE_TABLE/OPEN_TABLE poll a read-back
  // verify and re-fire the interaction every cfg.craft.openRetryTicks until it lands.
  lastUseTick: number;
}

function initCraft(): CraftMem {
  return {
    step: "DONE",
    chain: [],
    idx: 0,
    remaining: 0,
    phase: "PLACE",
    placeTable: true,
    tableStart: 0,
    tablePos: null,
    producedId: null,
    stepStart: 0,
    lastUseTick: Number.NEGATIVE_INFINITY,
  };
}

const CRAFT_SLICE = defineSlice<CraftMem>("craft", initCraft);

function setStep(ctx: Ctx, mem: CraftMem, step: CraftStep): void {
  mem.step = step;
  mem.stepStart = ctx.st.tickCount;
  mem.lastUseTick = Number.NEGATIVE_INFINITY; // next verified interaction fires immediately
}

/** Parse the `chain` param (array of {grid, times}) or fall back to the config default. */
function parseChain(
  params: Record<string, unknown>,
  defaultChain: readonly CraftChainStep[],
): CraftChainStep[] {
  const raw = params["chain"];
  if (Array.isArray(raw)) {
    const out: CraftChainStep[] = [];
    for (const el of raw) {
      const r = asRecord(el);
      const grid = r["grid"];
      const times = r["times"];
      if (Array.isArray(grid)) {
        const cells = grid.map((c) => (typeof c === "string" ? c : null));
        out.push({
          grid: cells,
          times: typeof times === "number" && times > 0 ? Math.floor(times) : 1,
        });
      }
    }
    if (out.length > 0) return out;
  }
  return defaultChain.map((s) => ({ grid: s.grid.slice(), times: s.times }));
}

/** Do we carry the ingredients for ONE craft of `step` (its non-null grid cells, counted)? Used
 *  by the conditional restock path to SKIP (not ERROR) when materials are short. Best-effort:
 *  only the first chain step is checked (later steps consume earlier outputs), which is exact for
 *  the single-step restock recipes the sustain loop uses. */
function hasIngredients(inv: Container, step: CraftChainStep | undefined): boolean {
  if (!step) return false;
  const need = new Map<string, number>();
  for (const cell of step.grid) if (cell) need.set(cell, (need.get(cell) ?? 0) + 1);
  for (const [id, n] of need) if (carryCount(inv, new Set([id])) < n) return false;
  return true;
}

/** Select an inventory item into the held hotbar slot. Returns false if absent. */
function equip(inv: Container, id: string): boolean {
  for (const slot of inv.slots()) {
    if (inv.slot(slot)?.id !== id) continue;
    equipSlot(inv, slot);
    return true;
  }
  return false;
}

/** Drive the current chain step's place→wait→take cycle `remaining` times. Calls `onComplete`
 *  once the step's crafts are all done (the step timeout in craftHandler bounds each phase). */
function craftOnce(ctx: Ctx, mem: CraftMem, onComplete: () => void): void {
  const step = mem.chain[mem.idx];
  if (!step || mem.remaining <= 0) {
    onComplete();
    return;
  }
  const { rt } = ctx;
  switch (mem.phase) {
    case "PLACE": {
      // Wait until the open grid is large enough — the 3×3 table screen may still be opening
      // after useOnBlock; the step timeout catches a genuinely stuck open. (gridSize resolves
      // the screen-specific region itself, so the 2×2 player grid and the 3×3 table both work.)
      const sizeR = rt.interact.craft.gridSize();
      if (sizeR.ok && sizeR.value < step.grid.length) return;
      const r = rt.interact.craft.place(step.grid);
      if (!r.ok) {
        ctx.transition(STATE.ERROR, `craft place failed: ${r.error}`);
        return;
      }
      mem.phase = "WAIT";
      mem.stepStart = ctx.st.tickCount;
      return;
    }
    case "WAIT": {
      const o = rt.interact.craft.output();
      if (!o.ok) {
        ctx.transition(STATE.ERROR, `craft output read failed: ${o.error}`);
        return;
      }
      if (o.value === null) return; // result not synced yet — wait a tick
      mem.producedId = o.value.id;
      mem.phase = "TAKE";
      return;
    }
    case "TAKE": {
      const r = rt.interact.craft.take();
      if (!r.ok) {
        ctx.transition(STATE.ERROR, `craft take failed: ${r.error}`);
        return;
      }
      if (r.value <= 0) {
        ctx.transition(STATE.ERROR, "craft produced no output (wrong grid for this pack?)");
        return;
      }
      ctx.log.info(ctx.st.tickCount, "CRAFT", { item: mem.producedId, made: r.value });
      ctx.bus.emit("crafted", { id: mem.producedId ?? "unknown", count: r.value });
      mem.remaining--;
      mem.phase = "PLACE";
      mem.stepStart = ctx.st.tickCount;
      if (mem.remaining <= 0) onComplete();
      return;
    }
  }
}

/** The first real crafting step once any stale screen is closed. Player-grid steps
 *  (`tableStart > 0`) run first; otherwise jump straight to the table (or DONE if empty). */
function firstStep(mem: CraftMem): CraftStep {
  if (mem.tableStart > 0) return "PRE";
  if (mem.tableStart < mem.chain.length) return "PLACE_TABLE";
  return "DONE";
}

function doClose(ctx: Ctx, mem: CraftMem): void {
  // A prior aborted craft can leave a 3×3 table screen open; close it so the 2×2 pre-crafts
  // run in the player grid (closeScreen is render-thread deferred, so we poll gridSize until
  // the player grid is back — the step timeout bounds a genuinely stuck close).
  const sizeR = ctx.rt.interact.craft.gridSize();
  if (sizeR.ok && sizeR.value > PLAYER_GRID_CELLS) {
    const r = ctx.rt.interact.closeScreen();
    if (!r.ok) ctx.log.warn(ctx.st.tickCount, "CRAFT_CLOSE_FAIL", { error: r.error });
    return; // re-check next tick until the player grid is back
  }
  setStep(ctx, mem, firstStep(mem));
}

function afterPre(ctx: Ctx, mem: CraftMem): void {
  // Player-grid steps are done; if any table step remains, place the table, else finish.
  if (mem.tableStart >= mem.chain.length) {
    setStep(ctx, mem, "DONE");
    return;
  }
  // craftRange stopped AT tableStart without initializing its craft count (it only resets
  // `remaining` when advancing INTO a step it will run); prime the first table step here.
  mem.idx = mem.tableStart;
  mem.remaining = mem.chain[mem.tableStart]?.times ?? 0;
  mem.phase = "PLACE";
  setStep(ctx, mem, "PLACE_TABLE");
}

/** Advance `craftOnce` across steps [mem.idx .. endExclusive); calls `onAllDone` at the end. */
function craftRange(ctx: Ctx, mem: CraftMem, endExclusive: number, onAllDone: () => void): void {
  if (mem.idx >= endExclusive) {
    onAllDone();
    return;
  }
  craftOnce(ctx, mem, () => {
    mem.idx++;
    if (mem.idx >= endExclusive) {
      onAllDone();
      return;
    }
    mem.remaining = mem.chain[mem.idx]?.times ?? 0;
    mem.phase = "PLACE";
  });
}

function doPre(ctx: Ctx, mem: CraftMem): void {
  // Player-grid pre-crafts are chain indices [0 .. tableStart) (2×2 player grid).
  craftRange(ctx, mem, mem.tableStart, () => afterPre(ctx, mem));
}

/** Candidate table cells around the player: the four foot-level neighbors (front +Z first),
 *  then the same ring one block UP — a bot that dug itself into a 1-deep pit (stump mining
 *  does this constantly) has ALL foot neighbors solid and can only place on the rim
 *  (live: "no placeable cell" with 4× dirt/grass_block around the feet). */
function tableCandidates(p: Vec3): Vec3[] {
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  const z = Math.floor(p.z);
  const out: Vec3[] = [];
  for (const dy of [0, 1]) {
    out.push(
      { x, y: y + dy, z: z + 1 },
      { x, y: y + dy, z: z - 1 },
      { x: x + 1, y: y + dy, z },
      { x: x - 1, y: y + dy, z },
    );
  }
  return out;
}

function doPlaceTable(ctx: Ctx, mem: CraftMem): void {
  const { rt, st, cfg } = ctx;
  // Effect-verify a pending placement: placeBlock "ok" only means the interaction was
  // DISPATCHED — live, the second craft run aimed into the ground below the first
  // run's table, "placed" fine, and died in FINAL. Advance only when the table block reads
  // back at tablePos; cfg.craft.stepTimeoutTicks bounds a placement that never lands.
  if (mem.tablePos) {
    const idR = rt.world.blockId(mem.tablePos);
    if (idR.ok && idR.value === TABLE_ID) {
      setStep(ctx, mem, "OPEN_TABLE");
      return;
    }
  }
  const posR = rt.player.pos();
  if (!posR.ok) return;
  const neighbors = tableCandidates(posR.value);
  // Reuse an adjacent table before consuming one from the bag (failed runs leave them standing).
  for (const n of neighbors) {
    const idR = rt.world.blockId(n);
    if (idR.ok && idR.value === TABLE_ID) {
      mem.tablePos = n;
      setStep(ctx, mem, "OPEN_TABLE");
      return;
    }
  }
  if (st.tickCount - mem.lastUseTick < cfg.craft.openRetryTicks) return;
  // Pick a placeable cell: free (air/ground-cover) with a solid block below to place against —
  // never a blind floor(pos)+Z (that cell can be inside a hill or over a hole).
  let target: Vec3 | null = null;
  for (const n of neighbors) {
    const cellR = rt.world.blockId(n);
    if (!cellR.ok || !isFreeCell(cellR.value)) continue;
    const belowR = rt.world.blockId({ x: n.x, y: n.y - 1, z: n.z });
    if (!belowR.ok || isFreeCell(belowR.value)) continue;
    target = n;
    break;
  }
  if (!target) {
    // Keep polling (a world-read hiccup or an un-synced chunk clears itself); the step
    // timeout bounds a genuinely boxed-in bot with the loud PLACE_TABLE timeout ERROR.
    ctx.log.warn(st.tickCount, "CRAFT_NO_CELL", { pos: posR.value });
    mem.lastUseTick = st.tickCount;
    return;
  }
  const invR = rt.inv.open();
  if (!invR.ok) return;
  if (!equip(invR.value, TABLE_ID)) {
    ctx.transition(STATE.ERROR, "no crafting table to place");
    return;
  }
  mem.lastUseTick = st.tickCount;
  const against: Vec3 = { x: target.x, y: target.y - 1, z: target.z };
  const look = rt.interact.lookAt(target);
  if (!look.ok) ctx.log.warn(st.tickCount, "CRAFT_LOOK_FAIL", { error: look.error });
  const placed = rt.interact.placeBlock(against, "TOP");
  if (!placed.ok) {
    ctx.transition(STATE.ERROR, `place table failed: ${placed.error}`);
    return;
  }
  mem.tablePos = target; // verified by the read-back at the top next tick
}

function doOpenTable(ctx: Ctx, mem: CraftMem): void {
  if (!mem.tablePos) {
    setStep(ctx, mem, "FINAL");
    return;
  }
  const { rt, st, cfg } = ctx;
  // Effect-verify: enter FINAL only once the 3×3 grid is actually open — one unverified
  // useOnBlock left both live runs stuck in FINAL with the 2×2 player grid still up.
  const sizeR = rt.interact.craft.gridSize();
  if (sizeR.ok && sizeR.value > PLAYER_GRID_CELLS) {
    setStep(ctx, mem, "FINAL");
    return;
  }
  if (st.tickCount - mem.lastUseTick < cfg.craft.openRetryTicks) return;
  mem.lastUseTick = st.tickCount;
  const look = rt.interact.lookAt(mem.tablePos);
  if (!look.ok) ctx.log.warn(st.tickCount, "CRAFT_LOOK_FAIL", { error: look.error });
  const r = rt.interact.useOnBlock(mem.tablePos, "TOP");
  if (!r.ok) {
    ctx.transition(STATE.ERROR, `open table failed: ${r.error}`);
    return;
  }
}

function doFinal(ctx: Ctx, mem: CraftMem): void {
  // Table steps are chain indices [tableStart .. end] — crafted at the open 3×3 table in
  // sequence (a step's output, e.g. a chest, feeds the next step's grid from inventory).
  craftRange(ctx, mem, mem.chain.length, () => {
    // reliability-ok: best-effort GUI close on completion; a stuck screen is harmless (the
    // next mission's openInventory supersedes it) and not worth failing the craft over.
    void ctx.rt.interact.closeScreen();
    setStep(ctx, mem, "DONE");
  });
}

function craftHandler(ctx: Ctx): void {
  const mem = ctx.slice(CRAFT_SLICE);
  if (mem.step !== "DONE" && ctx.st.tickCount - mem.stepStart > ctx.cfg.craft.stepTimeoutTicks) {
    ctx.transition(STATE.ERROR, `craft step ${mem.step}/${mem.phase} timeout`);
    return;
  }
  switch (mem.step) {
    case "CLOSE":
      doClose(ctx, mem);
      return;
    case "PRE":
      doPre(ctx, mem);
      return;
    case "PLACE_TABLE":
      doPlaceTable(ctx, mem);
      return;
    case "OPEN_TABLE":
      doOpenTable(ctx, mem);
      return;
    case "FINAL":
      doFinal(ctx, mem);
      return;
    case "DONE":
      return;
  }
}

const CRAFT_EDGES: PartialTransitionTable<State> = {
  CRAFT: ["IDLE", "PAUSED", "ERROR"],
};

export const craftMission: Mission = {
  name: "craft",
  params: [
    {
      name: "chain",
      type: "string",
      required: false,
      desc: "JSON [{grid:(id|null)[], times}] (default → chest from oak logs)",
    },
    {
      name: "table",
      type: "bool",
      required: false,
      desc: "place a table for the final step (default true)",
    },
    {
      name: "want",
      type: "string",
      required: false,
      desc: "conditional restock: target item id — skip (no-op) if ≥min already carried or materials short",
    },
    {
      name: "min",
      type: "int",
      required: false,
      desc: "want-mode threshold: craft only when carrying fewer than this many `want`",
    },
  ],
  edges: CRAFT_EDGES,
  initialPhase: STATE.CRAFT,
  init(ctx: Ctx, params: Record<string, unknown>): void {
    const mem = ctx.slice(CRAFT_SLICE);
    mem.chain = parseChain(params, ctx.cfg.craft.defaultChain);
    mem.idx = 0;
    mem.remaining = mem.chain[0]?.times ?? 0;
    mem.phase = "PLACE";
    mem.placeTable = params["table"] !== false;
    mem.producedId = null;
    mem.tablePos = null;
    // Conditional restock (#22): a `want` item makes this a SKIP-able top-up, not an
    // unconditional craft — an unattended loop must never stall (guard-park) or ERROR on it.
    // No-op (→ DONE, isDone true next tick) when we already carry ≥min, OR when the ingredients
    // for one craft are missing (can't restock yet → skip silently, try again next lap). A plain
    // craft (no `want`) is unchanged: it still fails loud on a bad recipe / no output.
    const want = typeof params["want"] === "string" ? params["want"] : null;
    if (want) {
      const min = typeof params["min"] === "number" ? Math.floor(params["min"]) : 1;
      const invR = ctx.rt.inv.open();
      if (invR.ok) {
        const inv = invR.value;
        const have = carryCount(inv, new Set([want]));
        if (have >= min) {
          ctx.log.info(ctx.st.tickCount, "CRAFT_STOCKED", { want, have, min });
          setStep(ctx, mem, "DONE");
          return;
        }
        if (!hasIngredients(inv, mem.chain[0])) {
          ctx.log.info(ctx.st.tickCount, "CRAFT_NO_MATERIALS", { want, have, min });
          setStep(ctx, mem, "DONE");
          return;
        }
        // A 3×3 step needs a placed crafting table (PLACE_TABLE equips a TABLE_ID item, else
        // ERRORs) — for a skip-safe restock, treat a missing table as "can't craft yet", skip.
        const needsTable =
          mem.placeTable && mem.chain.some((s) => s.grid.length > PLAYER_GRID_CELLS);
        if (needsTable && carryCount(inv, new Set([TABLE_ID])) < 1) {
          ctx.log.info(ctx.st.tickCount, "CRAFT_NO_TABLE", { want, have, min });
          setStep(ctx, mem, "DONE");
          return;
        }
      }
    }
    // The table is needed from the first step whose grid exceeds the 2×2 player grid (e.g. a
    // chest or drawer = 8 ingredients in a 3×3). Steps before it craft in the player grid.
    // `table:false` forces everything into the player grid (caller's override; will fail loud
    // if a 3×3 step is actually present).
    const firstBig = mem.chain.findIndex((s) => s.grid.length > PLAYER_GRID_CELLS);
    mem.tableStart = !mem.placeTable || firstBig < 0 ? mem.chain.length : firstBig;
    // (producedId/tablePos already reset above, before the want-mode early return.)
    // Always enter through CLOSE — a stale screen from a prior aborted craft would otherwise
    // route the 2×2 pre-crafts into a 3×3 grid and silently break the recipe shape.
    setStep(ctx, mem, "CLOSE");
  },
  handlers: { CRAFT: craftHandler },
  isDone(ctx: Ctx): boolean {
    return ctx.slice(CRAFT_SLICE).step === "DONE";
  },
  outputs(ctx: Ctx): Record<string, unknown> {
    const mem = ctx.slice(CRAFT_SLICE);
    return { crafted: mem.producedId, tablePos: mem.tablePos };
  },
  onAbort(ctx: Ctx): void {
    // reliability-ok: best-effort teardown — return any grid items and close the GUI; an
    // abort path can't act on these failing, and they're superseded by the next mission.
    void ctx.rt.interact.craft.clearGrid();
    void ctx.rt.interact.closeScreen();
    ctx.rt.keys.releaseAll();
  },
};
