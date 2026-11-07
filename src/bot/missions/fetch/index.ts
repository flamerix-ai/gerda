import { walkTo } from "@/bot/missions/_goto-leg";
import { intParam, parseIdList } from "@/bot/missions/_params";
import { STATE } from "@/bot/profile/states";
import type { Container } from "@/core/runtime/Runtime";
import type { Vec3 } from "@/core/runtime/types";
// The fetch/restock mission — the second mission, proving the bot is UNIVERSAL, not
// a mining-only bot. Walk to a chest at a given position, withdraw its
// contents into the player inventory, done. It shares NOTHING with the mine mission
// except the kernel, the reflex layer and the GOTO movement phase — a completely
// different goal-machine, switchable at runtime with `mission_start fetch {x,y,z}`
// and no reload.
//
// RESTOCK opens the chest the SAME way stash/smelt do — `useOnBlock` to bring the GUI up, THEN read
// its container slots. (Earlier this skipped the open: `rt.inv.open()` only reflects the CURRENTLY-open
// screen — it wraps Player.openInventory(), it does not right-click a block — so the withdraw read an
// empty "container" region and pulled nothing. The open step is the fix; it is the withdraw counterpart
// of stash's deposit.) Optional `items` whitelist narrows the withdraw to specific ids (the sustain
// loop's targeted resupply); omit it to withdraw everything (the original contract).
//
// Hand-written (not missionFromCaps) to show a mission can be authored directly.
import { hasContainerOpen } from "@/shared/domain/inventory";
import type { Ctx } from "@/shared/kernel/capability";
import type { Mission } from "@/shared/kernel/mission";
import { defineSlice } from "@/shared/kernel/slice";
import { greedyRelease } from "@/shared/nav";

// RESTOCK runs an internal open→withdraw sub-step machine (one kernel STATE.RESTOCK), like stash's STASH.
type RestockStep = "OPEN" | "WITHDRAW";

interface FetchMem {
  target: Vec3 | null;
  items: string[]; // whitelist of ids to withdraw ([] → withdraw everything in the chest)
  step: RestockStep;
  opened: boolean; // useOnBlock dispatched (OPEN fires it once)
  stepStart: number; // tick the current step began (open grace)
  done: boolean;
  withdrew: number;
}

const FETCH_SLICE = defineSlice<FetchMem>("fetch", () => ({
  target: null,
  items: [],
  step: "OPEN",
  opened: false,
  stepStart: 0,
  done: false,
  withdrew: 0,
}));

function fetchMem(ctx: Ctx): FetchMem {
  return ctx.slice(FETCH_SLICE);
}

/** Container slots holding one of `ids` (or all container slots when the whitelist is empty). */
function containerSlotsToTake(inv: Container, ids: ReadonlySet<string>): number[] {
  const slots = inv.slots("container");
  if (ids.size === 0) return slots;
  return slots.filter((slot) => {
    const s = inv.slot(slot);
    return s !== null && ids.has(s.id);
  });
}

// OPEN — dispatch the chest right-click once, then wait for a container screen (stash/smelt's pattern).
// Times out → ERROR (fail loud rather than silently withdrawing nothing — the old bug).
function stepOpen(ctx: Ctx, mem: FetchMem): void {
  const { rt, st, cfg } = ctx;
  const invR = rt.inv.open();
  if (invR.ok && hasContainerOpen(invR.value.regions())) {
    mem.step = "WITHDRAW";
    mem.stepStart = st.tickCount;
    return;
  }
  if (mem.target && !mem.opened) {
    void rt.interact.useOnBlock(mem.target, "TOP");
    mem.opened = true;
    return;
  }
  if (st.tickCount - mem.stepStart > cfg.containerOpenGraceTicks) {
    ctx.transition(STATE.ERROR, "fetch: chest GUI did not open");
  }
}

// WITHDRAW — shift-click the (whitelisted) container slots into the bag, then close + finish.
function stepWithdraw(ctx: Ctx, mem: FetchMem): void {
  const { rt, st } = ctx;
  const invR = rt.inv.open();
  if (!invR.ok) {
    ctx.transition(STATE.ERROR, "fetch: lost the chest screen during withdraw");
    return;
  }
  const inv = invR.value;
  const slots = containerSlotsToTake(inv, new Set(mem.items));
  for (const slot of slots) inv.quick(slot);
  mem.withdrew = slots.length;
  ctx.log.info(st.tickCount, "FETCH_RESTOCK", { withdrew: mem.withdrew, items: mem.items });
  void rt.interact.closeScreen();
  mem.done = true;
}

export const fetchMission: Mission = {
  name: "fetch",
  params: [
    { name: "x", type: "int", required: true, desc: "chest X" },
    { name: "y", type: "int", required: true, desc: "chest Y" },
    { name: "z", type: "int", required: true, desc: "chest Z" },
    {
      name: "items",
      type: "string",
      required: false,
      desc: 'ids to withdraw — JSON array ["minecraft:coal"] or comma-string; omit → withdraw all',
    },
  ],

  // GOTO (walk) → RESTOCK (open + withdraw) → done (kernel collapses to IDLE via isDone).
  edges: {
    [STATE.GOTO]: [STATE.RESTOCK, STATE.IDLE],
    [STATE.RESTOCK]: [STATE.IDLE],
  },
  initialPhase: STATE.GOTO,
  movementPhases: new Set([STATE.GOTO]),

  init(ctx: Ctx, params: Record<string, unknown>): void {
    const mem = fetchMem(ctx);
    const x = intParam(params, "x");
    const y = intParam(params, "y");
    const z = intParam(params, "z");
    mem.target = x !== null && y !== null && z !== null ? { x, y, z } : null;
    mem.items = parseIdList(params["items"]);
    mem.step = "OPEN";
    mem.opened = false;
    mem.done = false;
    mem.withdrew = 0;
  },

  handlers: {
    GOTO(ctx: Ctx): void {
      const mem = fetchMem(ctx);
      if (!mem.target) {
        mem.done = true; // nothing to fetch → finish (isDone → IDLE)
        return;
      }
      // Greedy-walk to the chest as a column approach (Y-free): the chest Y is the goal, the bot
      // approaches its XZ over the surface. A block ends the fetch (no ore-style dig escalation here).
      walkTo(ctx, mem.target, {
        onArrive: () => {
          greedyRelease(ctx.rt);
          mem.step = "OPEN";
          mem.stepStart = ctx.st.tickCount;
          ctx.transition(STATE.RESTOCK, "fetch arrived");
        },
        onBlocked: () => {
          greedyRelease(ctx.rt);
          mem.done = true; // can't path to the chest (or timed out) → finish (no self-heal)
        },
      });
    },

    RESTOCK(ctx: Ctx): void {
      const mem = fetchMem(ctx);
      if (mem.step === "OPEN") stepOpen(ctx, mem);
      else stepWithdraw(ctx, mem);
    },
  },

  isDone(ctx: Ctx): boolean {
    return fetchMem(ctx).done;
  },

  onAbort(ctx: Ctx): void {
    void ctx.rt.interact.closeScreen();
    ctx.rt.nav.stop();
  },
};
