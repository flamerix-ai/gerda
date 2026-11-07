import { cellCenter, encodePos } from "@/core/prim/pos";
import type { Container, Runtime } from "@/core/runtime/Runtime";
import type { Face, Vec3 } from "@/core/runtime/types";
// place-cell — the ONE block-placement routine, the place-side analogue of break-cell.ts. Every
// phase that spends filler (PILLAR_UP jump-places under the feet; BRIDGE lays a floor across a gap;
// future wall-fill) needs the same two things: (1) equip a cheap filler WITHOUT clobbering the held
// mining tool, restoring the tool on exit, and (2) place a block at a target cell against a chosen
// support face and CONFIRM it landed (interact.placeBlock is dispatch-not-confirmed — the server
// applies it ~1 tick later, so the only honest "placed" is a re-read of the cell). Centralising it
// means no phase re-derives the hotbar dance or trusts an unconfirmed place.
import type { Config } from "@/shared/config/schema";
import { HOTBAR_VANILLA_START, isHotbar } from "@/shared/held";
import type { Ctx } from "@/shared/kernel/capability";

/** The slice of the kernel logger stepPlace needs — passed by phase callers (ctx.log), omitted by
 *  the Ctx-free greedy executor (which logs nothing per-tick). Keeps place-cell phase-independent. */
export interface PlaceLogger {
  info(tick: number, event: string, fields: Record<string, unknown>): void;
  warn(tick: number, event: string, fields: Record<string, unknown>): void;
}

const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);

/** Select the highest-priority filler into the hand WITHOUT clobbering the held mining tool:
 *  a filler already in the hotbar is just selected (the tool stays in its own slot, deselected);
 *  a main-inventory stack is swapped into an EMPTY hotbar slot, else (no empty slot) into the
 *  current slot as a last resort. Returns the equipped id, or null if the bag has no filler. */
export function equipFiller(inv: Container, fillers: readonly string[]): string | null {
  let best: { slot: number; rank: number } | null = null;
  for (const slot of inv.slots()) {
    const s = inv.slot(slot);
    if (!s) continue;
    const rank = fillers.indexOf(s.id);
    if (rank < 0) continue;
    if (!best || rank < best.rank) best = { slot, rank };
  }
  if (!best) return null;
  if (isHotbar(best.slot)) {
    inv.selectHotbar(best.slot - HOTBAR_VANILLA_START);
  } else {
    const empty = inv.slots().find((s) => isHotbar(s) && inv.slot(s) === null);
    const dest = empty ?? HOTBAR_VANILLA_START + inv.selectedHotbar();
    inv.swap(best.slot, dest);
    inv.selectHotbar(dest - HOTBAR_VANILLA_START);
  }
  return fillers[best.rank] ?? null;
}

/** Does the bag carry any filler block? The navigator's `canPillar` gate — the pure planner can't
 *  read inventory, so the executor calls this and passes the flag into planPath. Cheap (first hit
 *  wins), no hotbar mutation (unlike {@link equipFiller}). */
export function hasFiller(inv: Container, fillers: readonly string[]): boolean {
  for (const slot of inv.slots()) {
    const s = inv.slot(slot);
    if (s && fillers.includes(s.id)) return true;
  }
  return false;
}

/** Total filler blocks the bag carries (summed across every stack). The navigator gates pillar/bridge
 *  on a MINIMUM of this (cfg.nav.fillerMin), not just hasFiller>0: a place-chain it can't finish strands the
 *  bot mid-bridge over a void, so below the minimum it must route around / escalate instead of starting. */
export function fillerCount(inv: Container, fillers: readonly string[]): number {
  let n = 0;
  for (const slot of inv.slots()) {
    const s = inv.slot(slot);
    if (s && fillers.includes(s.id)) n += s.count;
  }
  return n;
}

/** Per-cell placement state, embedded in a phase's run-slice (it may carry more of its own).
 *  Keyed by the packed target cell so a new target restarts the machine + per-cell timeout, and
 *  carrying the hotbar slot the tool was in before we equipped filler (restored via {@link
 *  restoreHeldTool}). `freshPlaceRun()` seeds them. */
export interface PlaceRun {
  forKey: string;
  issued: boolean; // logged the first placeBlock for this cell (re-issued each tick until it lands)
  startTick: number;
  savedSlot: number; // hotbar index the mining tool was in before filler (-1 = unset)
}

export function freshPlaceRun(): PlaceRun {
  return { forKey: "", issued: false, startTick: 0, savedSlot: -1 };
}

/** Re-select the hotbar slot the mining tool was in before we equipped filler, so the bot hands
 *  back to MINE/SCAN holding its tool, not the filler. No-op if we never switched. Typed on the
 *  one field it touches so any run carrying a `savedSlot` (PlaceRun, PILLAR_UP's PillarRun) reuses
 *  it. */
export function restoreHeldTool(ctx: Ctx, run: { savedSlot: number }): void {
  if (run.savedSlot < 0) return;
  const invR = ctx.rt.inv.open();
  if (invR.ok) invR.value.selectHotbar(run.savedSlot);
  run.savedSlot = -1;
}

export type PlaceOutcome =
  | "working" // still equipping / waiting for the place to confirm this tick
  | "placed" // the target cell is now solid (this tick or already was) — caller advances
  | "no_filler" // the bag has no filler block — caller decides (skip / graceful bail)
  | "timeout"; // overran the place budget (server kept rejecting) — caller recovers

/**
 * Drive ONE tick of placing a filler block at `target`, by right-clicking `face` of `support`
 * (so the new block lands at `support + faceOffset == target`). Equips filler first (saving the
 * tool slot once, in `run.savedSlot` — the caller restores it via {@link restoreHeldTool} on
 * exit, NOT here, so a multi-cell bridge keeps the filler equipped between cells). Mutates `run`.
 * Confirms by re-reading `target`: only a real non-air read counts as "placed", never a fake.
 */
export function stepPlace(
  rt: Runtime,
  cfg: Config,
  tick: number,
  run: PlaceRun,
  target: Vec3,
  support: Vec3,
  face: Face,
  log?: PlaceLogger,
): PlaceOutcome {
  const key = encodePos(target.x, target.y, target.z);
  if (run.forKey !== key) {
    run.forKey = key;
    run.issued = false;
    run.startTick = tick;
  }

  // Already solid (we placed it last tick, or it never was a gap) → done. An unreadable target is
  // treated as NOT placed (keep trying) — only a confirmed non-air read counts.
  const idR = rt.world.blockId(target);
  if (idR.ok && !AIR.has(idR.value)) return "placed";

  const invR = rt.inv.open();
  if (!invR.ok) return "working";
  if (run.savedSlot < 0) run.savedSlot = invR.value.selectedHotbar();
  const filler = equipFiller(invR.value, cfg.nav.fillerBlocks);
  if (!filler) return "no_filler";

  // Face the cell, then right-click the support face. placeBlock is dispatch-not-confirmed, so we
  // re-issue every tick while the cell reads air (the server may reject a frame); we confirm at the
  // top of the NEXT tick. Logging once keeps the journal readable.
  void rt.interact.lookAt(cellCenter(target));
  // reliability-ok: placeBlock is dispatch-not-confirmed — we confirm by re-reading `target` at the
  // top of the next tick (a per-frame reject is harmless: we re-issue while the cell reads air).
  void rt.interact.placeBlock(support, face);
  if (!run.issued) {
    run.issued = true;
    log?.info(tick, "PLACE_CELL", { at: target, against: support, face, filler });
  }

  if (tick - run.startTick > cfg.nav.placeTimeoutTicks) {
    log?.warn(tick, "PLACE_CELL_TIMEOUT", { at: target, against: support, face });
    return "timeout";
  }
  return "working";
}
