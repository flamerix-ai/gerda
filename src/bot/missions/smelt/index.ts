import { STATE, type State } from "@/bot/profile/states";
import type { Container } from "@/core/runtime/Runtime";
import type { Vec3 } from "@/core/runtime/types";
// smelt mission — the first mod-MACHINE processing capability, and the PATTERN future machines
// (Storage Drawers, GTCEu macerator/EBF) follow. It runs a furnace cycle in place: open the
// furnace GUI → shift-click the raw input + fuel in (vanilla auto-routes a smeltable to the input
// slot and a fuel to the fuel slot, exactly like the chest-deposit DUMP path) → wait for the smelt
// → shift-click the finished output back out → close.
//
// REGION-AGNOSTIC by design (see the EMI/prospector "don't guess mod internals offline" lesson in
// CLAUDE.md): it never hardcodes furnace slot/region names. Loading rides vanilla shift-click
// (quick) auto-routing; reading the machine's progress scans the OPEN screen's NON-player slots
// (containerRegions) and matches by ITEM ID — the input id (still smelting) and the output id
// (ready to collect). So the same mission drives any single-input→single-output machine whose GUI
// honours shift-click, with only the item ids as data.
//
// Mirrors craft: ONE kernel state (STATE.SMELT) + an internal step machine, stationary, hand-written
// (needs params in init). Tick-driven because the smelt result, like a craft result, lands slowly.
//
// RUN MODE (the sustain-loop "yield" — see SmeltRunMode): a furnace cooks server-side in a loaded
// chunk regardless of whether the bot waits here, so `mode:"load"` shifts the ore+fuel in and finishes
// immediately (the bot goes mining) and `mode:"collect"` comes back to drain ready output. The default
// `mode:"full"` babysits the whole batch (the standalone behaviour). The loop fans "load" across a
// furnace bank, mines, then sweeps "collect" — never blocking the bot for the smelt itself.
//
// LIVE-VERIFIED (vanilla furnace): a full 8×raw_iron→iron_ingot cycle ran end to end —
// useOnBlock opened the GUI (no lookAt needed), vanilla shift-click auto-routed input→input/coal→fuel
// (SMELT_LOADED loaded:8), the containerRegions item-id scan read the output slot, and all 8 ingots
// were collected (SMELT_DONE collected:8). STILL UNVERIFIED: a GTCEu MACHINE (macerator/EBF) — its
// GUI region names + whether it honours shift-click routing may differ from a vanilla furnace; what id
// a GTCEu raw ore smelts to. The unit tests use a scriptable fake furnace and do NOT assert any of
// the live behaviour above.
import {
  type SlotEntry,
  carryCount,
  carrySlots,
  containerRegions,
  hasContainerOpen,
} from "@/shared/domain/inventory";
import type { Ctx } from "@/shared/kernel/capability";
import type { PartialTransitionTable } from "@/shared/kernel/fsm";
import type { Mission } from "@/shared/kernel/mission";
import { defineSlice } from "@/shared/kernel/slice";

// Internal sub-step machine (one kernel STATE.SMELT, like craft's mem.step).
type SmeltStep = "OPEN" | "LOAD" | "WAIT" | "COLLECT" | "DONE";

// Run mode — the answer to "don't block the bot for the whole smelt" (the sustain-loop yield).
// A furnace cooks server-side in a loaded chunk whether or not the bot stands here, so:
//   "full"    — OPEN→LOAD→WAIT→COLLECT→DONE: load + babysit the whole batch (the standalone default).
//   "load"    — OPEN→LOAD→DONE: shift the raw ore + fuel in and LEAVE; the furnace cooks unattended.
//   "collect" — OPEN→COLLECT→DONE: come back later and drain whatever finished (no loading, no wait).
// The sustain loop fans "load" across a furnace bank, goes mining, then sweeps "collect" next base trip.
type SmeltRunMode = "full" | "load" | "collect";

interface SmeltMem {
  step: SmeltStep;
  runMode: SmeltRunMode;
  furnace: Vec3 | null; // the furnace block to open; null → expect a screen already open
  inputId: string; // the raw item to smelt (e.g. "gtceu:raw_iron")
  fuelId: string | null; // fuel to load (e.g. "minecraft:coal"); null → no fuel (electric/already fueled)
  outputId: string; // the expected smelted result (e.g. "minecraft:iron_ingot")
  targetCount: number; // collect at least this many output (0 = whatever the loaded input yields)
  collected: number; // output items pulled back into the bag so far
  opened: boolean; // useOnBlock was dispatched (so OPEN only fires it once)
  stepStart: number; // tick the current step began (for grace/timeout)
}

function initSmelt(): SmeltMem {
  return {
    step: "DONE",
    runMode: "full",
    furnace: null,
    inputId: "",
    fuelId: null,
    outputId: "",
    targetCount: 0,
    collected: 0,
    opened: false,
    stepStart: 0,
  };
}

function parseSmeltMode(raw: unknown): SmeltRunMode {
  switch (String(raw ?? "").toLowerCase()) {
    case "load":
      return "load";
    case "collect":
      return "collect";
    default:
      return "full"; // "", "full", or anything unrecognised → the babysit-the-batch default
  }
}

export const SMELT_SLICE = defineSlice<SmeltMem>("smelt", initSmelt);

const SMELT_EDGES: PartialTransitionTable<State> = {
  SMELT: ["IDLE", "PAUSED", "ERROR"],
};

function setStep(ctx: Ctx, mem: SmeltMem, step: SmeltStep): void {
  mem.step = step;
  mem.stepStart = ctx.st.tickCount;
}

/** Every (slot,id) pair in the given regions of the open container. */
function entriesIn(c: Container, regions: string[]): SlotEntry[] {
  const out: SlotEntry[] = [];
  for (const slot of c.slots(...regions)) {
    const s = c.slot(slot);
    if (s) out.push({ slot, id: s.id });
  }
  return out;
}

// OPEN — dispatch the furnace right-click once, then wait for a container screen. A furnace with no
// known position assumes the screen is already up (caller opened it). Times out → ERROR (fail loud).
function stepOpen(ctx: Ctx, mem: SmeltMem): void {
  const { rt, st, cfg } = ctx;
  const invR = rt.inv.open();
  if (invR.ok && hasContainerOpen(invR.value.regions())) {
    // "collect" came back only to drain ready output — skip loading entirely.
    setStep(ctx, mem, mem.runMode === "collect" ? "COLLECT" : "LOAD");
    return;
  }
  if (mem.furnace && !mem.opened) {
    // Any face opens the GUI; TOP is the most reachable when standing beside the furnace.
    void rt.interact.useOnBlock(mem.furnace, "TOP");
    mem.opened = true;
    return;
  }
  if (st.tickCount - mem.stepStart > cfg.containerOpenGraceTicks) {
    ctx.transition(STATE.ERROR, "smelt: furnace GUI did not open");
  }
}

// LOAD — shift-click the raw input (and fuel) from the bag; vanilla routes them to the furnace's
// input/fuel slots. Verify the input actually left the bag (a silent quick() failure must not read
// as "loaded"). Nothing to smelt → straight to COLLECT (grab any already-done output), else WAIT.
function stepLoad(ctx: Ctx, mem: SmeltMem): void {
  const { rt, st } = ctx;
  const invR = rt.inv.open();
  if (!invR.ok) {
    ctx.transition(STATE.ERROR, "smelt: lost the furnace screen during load");
    return;
  }
  const inv = invR.value;
  const loadIds = new Set([mem.inputId, ...(mem.fuelId ? [mem.fuelId] : [])]);
  const before = carryCount(inv, new Set([mem.inputId]));
  if (before === 0) {
    // No raw input on hand. "load" (defer) is purely a loader → nothing to do, finish. "full" maybe
    // a prior run already loaded it, or there's only output to fetch → drain it.
    if (mem.runMode === "load") {
      finish(ctx, mem, "nothing to load");
      return;
    }
    setStep(ctx, mem, "COLLECT");
    return;
  }
  // Highest slot first so a compacting container impl doesn't shift indices mid-loop.
  for (const slot of carrySlots(inv, loadIds).sort((a, b) => b - a)) inv.quick(slot);

  // Verify-convention: the input must have left the bag. If none did the furnace is full / the
  // GUI rejected the move — surface it rather than waiting forever on a smelt that never started.
  const reread = rt.inv.open();
  const after = reread.ok ? carryCount(reread.value, new Set([mem.inputId])) : before;
  if (after >= before) {
    ctx.log.warn(st.tickCount, "SMELT_LOAD_BLOCKED", {
      inputId: mem.inputId,
      onHand: before,
      hint: "furnace input full or shift-click rejected",
    });
    ctx.transition(STATE.ERROR, "smelt: input did not load");
    return;
  }
  ctx.log.info(st.tickCount, "SMELT_LOADED", {
    inputId: mem.inputId,
    loaded: before - after,
    fuelId: mem.fuelId,
    mode: mem.runMode,
  });
  // "load" (defer) leaves the furnace cooking unattended — done the moment the ore is in. "full"
  // babysits the batch through WAIT→COLLECT.
  if (mem.runMode === "load") {
    finish(ctx, mem, "loaded, left to smelt");
    return;
  }
  setStep(ctx, mem, "WAIT");
}

// WAIT — poll the machine's non-player slots. Collect as soon as the output id appears; finish once
// the input slot has drained (the loaded batch is fully smelted). A long timeout collects whatever
// is done rather than hanging (a fuel-starved or jammed furnace).
function stepWait(ctx: Ctx, mem: SmeltMem): void {
  const { rt, st, cfg } = ctx;
  const invR = rt.inv.open();
  if (!invR.ok) {
    ctx.transition(STATE.ERROR, "smelt: lost the furnace screen while smelting");
    return;
  }
  const inv = invR.value;
  const machine = containerRegions(inv.regions());
  const machineEntries = entriesIn(inv, machine);
  const outReady = machineEntries.some((e) => e.id === mem.outputId);
  const inputLeft = machineEntries.some((e) => e.id === mem.inputId);

  // Output is present → go grab it. If the input slot is also drained the batch is done; otherwise
  // we collect what's ready and (in COLLECT) loop back to keep smelting the rest.
  if (outReady) {
    setStep(ctx, mem, "COLLECT");
    return;
  }
  if (!inputLeft) {
    // Input gone but no output id seen — nothing more will come (already collected, or a non-
    // smeltable that vanished). Finish cleanly rather than spin to the timeout.
    finish(ctx, mem, "no input left, no output pending");
    return;
  }
  if (st.tickCount - mem.stepStart > cfg.smeltWaitTimeoutTicks) {
    ctx.log.warn(st.tickCount, "SMELT_WAIT_TIMEOUT", {
      waited: st.tickCount - mem.stepStart,
      hint: "fuel-starved or jammed furnace",
    });
    setStep(ctx, mem, "COLLECT"); // grab whatever finished, then DONE
  }
}

// COLLECT — shift-click every output-id stack from the machine back into the bag; verify the bag
// gained it. Loop back to WAIT while the input slot still has raw ore AND the target isn't met;
// otherwise close the GUI and finish.
function stepCollect(ctx: Ctx, mem: SmeltMem): void {
  const { rt, st } = ctx;
  const invR = rt.inv.open();
  if (!invR.ok) {
    // Screen already gone — count what's in the bag and finish (best-effort).
    finish(ctx, mem, "screen closed before collect");
    return;
  }
  const inv = invR.value;
  const machine = containerRegions(inv.regions());
  const before = carryCount(inv, new Set([mem.outputId]));
  const outSlots = entriesIn(inv, machine)
    .filter((e) => e.id === mem.outputId)
    .map((e) => e.slot)
    .sort((a, b) => b - a);
  for (const slot of outSlots) inv.quick(slot);

  const reread = rt.inv.open();
  const after = reread.ok ? carryCount(reread.value, new Set([mem.outputId])) : before;
  const got = after - before;
  if (got > 0) {
    mem.collected += got;
    ctx.log.info(st.tickCount, "SMELT_COLLECTED", {
      outputId: mem.outputId,
      got,
      total: mem.collected,
    });
  }

  // "collect" is a one-shot sweep — drain what's ready and leave (the loop returns later for more).
  // "full" babysits: loop back to WAIT while raw input is still cooking AND the target isn't met.
  if (mem.runMode === "collect") {
    finish(ctx, mem, got > 0 ? "collected ready output" : "nothing ready");
    return;
  }
  const inputLeft = reread.ok && entriesIn(reread.value, machine).some((e) => e.id === mem.inputId);
  const targetMet = mem.targetCount > 0 && mem.collected >= mem.targetCount;
  if (inputLeft && !targetMet) {
    setStep(ctx, mem, "WAIT");
    return;
  }
  finish(ctx, mem, targetMet ? "target reached" : "batch smelted");
}

function finish(ctx: Ctx, mem: SmeltMem, note: string): void {
  // reliability-ok: best-effort GUI close on the way out (fire-and-forget render-thread schedule).
  void ctx.rt.interact.closeScreen();
  ctx.log.info(ctx.st.tickCount, "SMELT_DONE", {
    note,
    outputId: mem.outputId,
    collected: mem.collected,
  });
  setStep(ctx, mem, "DONE");
}

function smeltHandler(ctx: Ctx): void {
  const mem = ctx.slice(SMELT_SLICE);
  switch (mem.step) {
    case "OPEN":
      stepOpen(ctx, mem);
      return;
    case "LOAD":
      stepLoad(ctx, mem);
      return;
    case "WAIT":
      stepWait(ctx, mem);
      return;
    case "COLLECT":
      stepCollect(ctx, mem);
      return;
    case "DONE":
      return; // isDone() ends the mission
  }
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

export const smeltMission: Mission = {
  name: "smelt",
  params: [
    {
      name: "mode",
      type: "string",
      required: false,
      desc: "full (load+wait+collect, default) | load (defer: load & leave) | collect (drain ready output)",
    },
    {
      name: "input",
      type: "string",
      required: false,
      desc: "raw item id to smelt (e.g. gtceu:raw_iron); required for full/load, unused for collect",
    },
    {
      name: "output",
      type: "string",
      required: true,
      desc: "expected smelted id (e.g. minecraft:iron_ingot)",
    },
    {
      name: "fuel",
      type: "string",
      required: false,
      desc: "fuel item id (omit for electric/pre-fueled)",
    },
    {
      name: "count",
      type: "int",
      required: false,
      desc: "collect ≥ this many output (0 = the loaded batch)",
    },
    {
      name: "x",
      type: "int",
      required: false,
      desc: "furnace block X (omit → use the already-open screen)",
    },
    { name: "y", type: "int", required: false },
    { name: "z", type: "int", required: false },
  ],
  edges: SMELT_EDGES,
  initialPhase: STATE.SMELT,
  init(ctx: Ctx, params: Record<string, unknown>): void {
    const mem = ctx.slice(SMELT_SLICE);
    const x = Number(params["x"]);
    const y = Number(params["y"]);
    const z = Number(params["z"]);
    mem.furnace =
      Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
    mem.runMode = parseSmeltMode(params["mode"]);
    mem.inputId = str(params["input"], "");
    mem.outputId = str(params["output"], "");
    mem.fuelId = typeof params["fuel"] === "string" && params["fuel"] ? params["fuel"] : null;
    const count = Number(params["count"]);
    mem.targetCount = Number.isFinite(count) && count > 0 ? count : 0;
    mem.collected = 0;
    mem.opened = false;
    setStep(ctx, mem, "OPEN");
  },
  handlers: { SMELT: smeltHandler },
  isDone(ctx: Ctx): boolean {
    return ctx.slice(SMELT_SLICE).step === "DONE";
  },
  outputs(ctx: Ctx): Record<string, unknown> {
    const mem = ctx.slice(SMELT_SLICE);
    return { smelted: mem.outputId, collected: mem.collected };
  },
  onAbort(ctx: Ctx): void {
    // reliability-ok: best-effort teardown — close the GUI + release keys; an abort can't act on
    // these failing, and the next mission supersedes them.
    void ctx.rt.interact.closeScreen();
    ctx.rt.keys.releaseAll();
  },
};
