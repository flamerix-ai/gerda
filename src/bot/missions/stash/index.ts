import { walkTo } from "@/bot/missions/_goto-leg";
import { intParam, parseIdList } from "@/bot/missions/_params";
import { STATE, type State } from "@/bot/profile/states";
import type { Vec3 } from "@/core/runtime/types";
import { carryCount, carrySlots, hasContainerOpen } from "@/shared/domain/inventory";
// stash mission — the sustain-loop "unload" leg: walk to a chest and deposit a whitelist of items.
// It is the DEPOSIT counterpart of fetch's RESTOCK (withdraw). Two phases: GOTO (greedy-walk to the
// chest, identical to fetch/goto) → STASH (open the chest, shift-click the whitelisted ids in, close).
//
// IMPORTANT — why this opens the chest and fetch does NOT: `rt.inv.open()` reflects the CURRENTLY-open
// screen (it wraps Player.openInventory()); it does not right-click a block. So a deposit/withdraw at
// a chest must first `useOnBlock` the chest to bring its GUI up — exactly what smelt's stepOpen does
// for a furnace. fetch skips this (its RESTOCK reads only the player inventory → a no-op withdraw);
// stash does it right. When fetch is wired into the autonomous resupply leg it needs the same OPEN step.
//
// Deposit rides vanilla shift-click (quick) auto-routing into the open container, the same mechanic as
// smelt's LOAD and the mine mission's DUMP. REGION-AGNOSTIC: it never names chest slots — it shift-
// clicks the carry (main+hotbar) slots whose id is on the deposit whitelist, and verifies the bag's
// count of those ids actually dropped (a silent quick() failure must not read as "deposited").
import type { Ctx } from "@/shared/kernel/capability";
import type { PartialTransitionTable } from "@/shared/kernel/fsm";
import type { Mission } from "@/shared/kernel/mission";
import { defineSlice } from "@/shared/kernel/slice";
import { greedyRelease } from "@/shared/nav";

type StashStep = "OPEN" | "DEPOSIT" | "DONE";

interface StashMem {
  chest: Vec3 | null;
  items: string[]; // whitelist of item ids to deposit ([] → nothing to do)
  step: StashStep;
  opened: boolean; // useOnBlock dispatched (OPEN fires it once)
  stepStart: number; // tick the current step began (open grace)
  deposited: number; // count of items moved into the chest
  arrived: boolean; // the GOTO leg reached the chest
  done: boolean; // mission complete (arrived+deposited OR gave up walking) → isDone
}

const STASH_SLICE = defineSlice<StashMem>("stash", () => ({
  chest: null,
  items: [],
  step: "DONE",
  opened: false,
  stepStart: 0,
  deposited: 0,
  arrived: false,
  done: false,
}));

function stashMem(ctx: Ctx): StashMem {
  return ctx.slice(STASH_SLICE);
}

const STASH_EDGES: PartialTransitionTable<State> = {
  GOTO: ["STASH", "IDLE", "PAUSED", "ERROR"],
  STASH: ["IDLE", "PAUSED", "ERROR"],
};

function setStep(ctx: Ctx, mem: StashMem, step: StashStep): void {
  mem.step = step;
  mem.stepStart = ctx.st.tickCount;
}

// OPEN — dispatch the chest right-click once, then wait for a container screen (smelt's stepOpen
// pattern). A chest with no known position assumes the screen is already up. Times out → ERROR.
function stepOpen(ctx: Ctx, mem: StashMem): void {
  const { rt, st, cfg } = ctx;
  const invR = rt.inv.open();
  if (invR.ok && hasContainerOpen(invR.value.regions())) {
    setStep(ctx, mem, "DEPOSIT");
    return;
  }
  if (mem.chest && !mem.opened) {
    void rt.interact.useOnBlock(mem.chest, "TOP");
    mem.opened = true;
    return;
  }
  if (st.tickCount - mem.stepStart > cfg.containerOpenGraceTicks) {
    ctx.transition(STATE.ERROR, "stash: chest GUI did not open");
  }
}

// DEPOSIT — shift-click every carry slot holding a whitelisted id into the open chest; verify the
// bag's whitelisted-item count actually dropped. Then close + finish.
function stepDeposit(ctx: Ctx, mem: StashMem): void {
  const { rt, st } = ctx;
  const invR = rt.inv.open();
  if (!invR.ok) {
    ctx.transition(STATE.ERROR, "stash: lost the chest screen during deposit");
    return;
  }
  const inv = invR.value;
  const ids = new Set(mem.items);
  const before = carryCount(inv, ids);
  if (before === 0) {
    finish(ctx, mem, "nothing to stash");
    return;
  }
  // Highest slot first so a compacting container impl doesn't shift indices mid-loop.
  for (const slot of carrySlots(inv, ids).sort((a, b) => b - a)) inv.quick(slot);

  const reread = rt.inv.open();
  const after = reread.ok ? carryCount(reread.value, ids) : before;
  if (after >= before) {
    ctx.log.warn(st.tickCount, "STASH_BLOCKED", {
      items: mem.items,
      onHand: before,
      hint: "chest full or shift-click rejected",
    });
    ctx.transition(STATE.ERROR, "stash: items did not deposit");
    return;
  }
  mem.deposited = before - after;
  ctx.log.info(st.tickCount, "STASH_DEPOSITED", { items: mem.items, deposited: mem.deposited });
  finish(ctx, mem, "deposited");
}

function finish(ctx: Ctx, mem: StashMem, note: string): void {
  // reliability-ok: best-effort GUI close on the way out (fire-and-forget render-thread schedule).
  void ctx.rt.interact.closeScreen();
  ctx.log.info(ctx.st.tickCount, "STASH_DONE", { note, deposited: mem.deposited });
  setStep(ctx, mem, "DONE");
  mem.done = true;
}

export const stashMission: Mission = {
  name: "stash",
  params: [
    { name: "x", type: "int", required: true, desc: "chest X" },
    { name: "y", type: "int", required: true, desc: "chest Y" },
    { name: "z", type: "int", required: true, desc: "chest Z" },
    {
      name: "items",
      type: "string",
      required: true,
      desc: 'ids to deposit — JSON array ["minecraft:raw_iron"] or comma-separated string',
    },
  ],

  // GOTO (walk) → STASH (open + deposit) → done (kernel collapses to IDLE via isDone).
  edges: STASH_EDGES,
  initialPhase: STATE.GOTO,
  movementPhases: new Set([STATE.GOTO]),

  init(ctx: Ctx, params: Record<string, unknown>): void {
    const mem = stashMem(ctx);
    const x = intParam(params, "x");
    const y = intParam(params, "y");
    const z = intParam(params, "z");
    mem.chest = x !== null && y !== null && z !== null ? { x, y, z } : null;
    mem.items = parseIdList(params["items"]);
    mem.step = "OPEN"; // reset; set live the moment we transition into STASH
    mem.opened = false;
    mem.deposited = 0;
    mem.arrived = false;
    mem.done = false;
  },

  handlers: {
    GOTO(ctx: Ctx): void {
      const { rt, st } = ctx;
      const mem = stashMem(ctx);
      if (!mem.chest) {
        mem.done = true; // nothing to stash → finish (isDone → IDLE)
        return;
      }
      const giveUp = (event: "STASH_GOTO_TIMEOUT" | "STASH_GOTO_BLOCKED"): void => {
        greedyRelease(rt);
        ctx.log.warn(st.tickCount, event, { chest: mem.chest });
        mem.done = true; // gave up walking → finish (no self-heal)
      };
      walkTo(ctx, mem.chest, {
        onArrive: () => {
          greedyRelease(rt);
          mem.arrived = true;
          setStep(ctx, mem, "OPEN");
          ctx.transition(STATE.STASH, "stash arrived");
        },
        onTimeout: () => giveUp("STASH_GOTO_TIMEOUT"),
        onBlocked: () => giveUp("STASH_GOTO_BLOCKED"),
      });
    },

    STASH(ctx: Ctx): void {
      const mem = stashMem(ctx);
      switch (mem.step) {
        case "OPEN":
          stepOpen(ctx, mem);
          return;
        case "DEPOSIT":
          stepDeposit(ctx, mem);
          return;
        case "DONE":
          return; // isDone() ends the mission
      }
    },
  },

  isDone(ctx: Ctx): boolean {
    return stashMem(ctx).done;
  },

  outputs(ctx: Ctx): Record<string, unknown> {
    return { deposited: stashMem(ctx).deposited };
  },

  onAbort(ctx: Ctx): void {
    void ctx.rt.interact.closeScreen();
    ctx.rt.nav.stop();
  },
};
