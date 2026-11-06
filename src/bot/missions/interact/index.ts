import { intParam } from "@/bot/missions/_params";
import { STATE } from "@/bot/profile/states";
import { dist } from "@/core/prim/pos";
import {
  type ResolvedInteract,
  faceCenterPoint,
  nearestFrameUuid,
  resolveInteract,
  verifyPlaced,
} from "@/shared/domain/interact";
// interact mission — the generalized "right-click a held item onto a target": walk to a target
// block (GOTO), then AIM (hold the item + lookAt) → USE → VERIFY per the target's profile. The
// `frame` profile targets a vanilla item-frame ENTITY: AIM resolves the frame uuid nearest the
// target cell (world.frames — the mc_frames snapshot bridge) and USE right-clicks it via
// interact.useOnEntity; the block profiles (display/generic) go through useOnBlock as before. It's the mission-shaped, kernel-native counterpart of the storage drawer's
// look-aimed use and the `interact_place` ext primitive — put an item into a frame, drop it onto a
// display/pedestal/showcase, or flip a lever. The verify seam (`cfg.interact.profiles`) is what
// makes it target-agnostic: frame/display consume the held item (`consumed`), a bare right-click
// just dispatches (`none`). All the placement policy is the pure domain/interact core; this file
// only sequences the runtime calls across ticks (the placement is server-authoritative, so USE and
// its VERIFY read must straddle a grace window, exactly like the storage drawer deposit).
import { carryCount } from "@/shared/domain/inventory";
import { heldFrom, holdItemById } from "@/shared/held";
import type { Ctx } from "@/shared/kernel/capability";
import type { Mission } from "@/shared/kernel/mission";
import { defineSlice } from "@/shared/kernel/slice";
import { greedyRelease, greedyStep, isBlocked } from "@/shared/nav";

type Sub = "AIM" | "USE" | "VERIFY";

interface InteractMem {
  target: ResolvedInteract | null;
  /** The id whose bag-count the `consumed` verify tracks: the requested item, or (item unset) the
   *  id that was held at AIM time. null → nothing to count, `consumed` degrades to a dispatch check. */
  placeId: string | null;
  /** Frame-profile only: the item-frame entity uuid AIM resolved (USE right-clicks it). */
  frameUuid: string | null;
  sub: Sub;
  subStart: number;
  before: number;
  dispatched: boolean;
  placed: boolean;
  done: boolean;
  startTick: number;
}

const INTERACT_SLICE = defineSlice<InteractMem>("interact", () => ({
  target: null,
  placeId: null,
  frameUuid: null,
  sub: "AIM",
  subStart: 0,
  before: 0,
  dispatched: false,
  placed: false,
  done: false,
  startTick: 0,
}));

function mem(ctx: Ctx): InteractMem {
  return ctx.slice(INTERACT_SLICE);
}

function finish(
  ctx: Ctx,
  m: InteractMem,
  placed: boolean,
  event: "INTERACT_DONE" | "INTERACT_GAVE_UP",
  note: string,
): void {
  greedyRelease(ctx.rt);
  m.placed = placed;
  m.done = true;
  const payload = {
    target: m.target?.pos,
    profile: m.target?.profile,
    verify: m.target?.verify,
    note,
  };
  if (placed) ctx.log.info(ctx.st.tickCount, event, payload);
  else ctx.log.warn(ctx.st.tickCount, event, payload);
}

function setSub(ctx: Ctx, m: InteractMem, sub: Sub): void {
  m.sub = sub;
  m.subStart = ctx.st.tickCount;
}

export const interactMission: Mission = {
  name: "interact",
  params: [
    { name: "x", type: "int", required: true, desc: "target block X" },
    { name: "y", type: "int", required: true, desc: "target block Y" },
    { name: "z", type: "int", required: true, desc: "target block Z" },
    {
      name: "item",
      type: "string",
      required: false,
      desc: "item id to hold + place (default: keep held)",
    },
    {
      name: "face",
      type: "string",
      required: false,
      desc: "face to right-click (default: toward the bot)",
    },
    {
      name: "profile",
      type: "string",
      required: false,
      desc: "target kind: frame | display | generic",
    },
    { name: "verify", type: "string", required: false, desc: "override verify: consumed | none" },
  ],

  // GOTO (approach the block) → INTERACT (aim → use → verify) → done (kernel collapses to IDLE).
  edges: {
    [STATE.GOTO]: [STATE.INTERACT, STATE.IDLE],
    [STATE.INTERACT]: [STATE.IDLE],
  },
  initialPhase: STATE.GOTO,
  movementPhases: new Set([STATE.GOTO]),

  init(ctx: Ctx, params: Record<string, unknown>): void {
    const m = mem(ctx);
    const x = intParam(params, "x");
    const y = intParam(params, "y");
    const z = intParam(params, "z");
    const posR = ctx.rt.player.pos();
    m.target =
      x !== null && y !== null && z !== null
        ? resolveInteract(
            { ...params, pos: { x, y, z } },
            ctx.cfg.interact.profiles,
            posR.ok ? posR.value : undefined,
          )
        : null;
    m.placeId = m.target?.item ?? null;
    m.frameUuid = null;
    m.sub = "AIM";
    m.subStart = ctx.st.tickCount;
    m.before = 0;
    m.dispatched = false;
    m.placed = false;
    m.done = false;
    m.startTick = ctx.st.tickCount;
  },

  handlers: {
    GOTO(ctx: Ctx): void {
      const { rt, cfg, st } = ctx;
      const m = mem(ctx);
      if (!m.target) {
        finish(ctx, m, false, "INTERACT_GAVE_UP", "no target");
        return;
      }
      const posR = rt.player.pos();
      if (posR.ok && dist(posR.value, m.target.pos) <= cfg.interact.reach) {
        greedyRelease(rt);
        setSub(ctx, m, "AIM");
        ctx.transition(STATE.INTERACT, "interact: within reach of target");
        return;
      }
      if (st.tickCount - m.startTick > cfg.interact.timeoutTicks) {
        finish(ctx, m, false, "INTERACT_GAVE_UP", "timeout reaching target");
        return;
      }
      const step = greedyStep(rt, cfg, m.target.pos, {
        column: true,
        bestEffort: true,
        arrivalRadius: cfg.interact.reach,
      });
      if (step === "arrived") {
        greedyRelease(rt);
        setSub(ctx, m, "AIM");
        ctx.transition(STATE.INTERACT, "interact: within reach of target");
      } else if (isBlocked(step)) {
        // Blocked short of the block — if we're already within reach, interact anyway; else give up.
        const p = rt.player.pos();
        if (p.ok && dist(p.value, m.target.pos) <= cfg.interact.reach) {
          greedyRelease(rt);
          setSub(ctx, m, "AIM");
          ctx.transition(STATE.INTERACT, "interact: within reach of target");
        } else {
          finish(ctx, m, false, "INTERACT_GAVE_UP", "blocked, no path to target");
        }
      }
    },

    INTERACT(ctx: Ctx): void {
      const { rt, cfg, st } = ctx;
      const m = mem(ctx);
      const target = m.target;
      if (!target) {
        finish(ctx, m, false, "INTERACT_GAVE_UP", "no target");
        return;
      }
      if (st.tickCount - m.startTick > cfg.interact.timeoutTicks) {
        finish(ctx, m, false, "INTERACT_GAVE_UP", "timeout");
        return;
      }

      if (m.sub === "AIM") {
        const invR = rt.inv.open();
        if (!invR.ok) {
          finish(ctx, m, false, "INTERACT_GAVE_UP", "inventory unreadable");
          return;
        }
        const inv = invR.value;
        // Equip the requested item (if any); nothing to place → give up rather than fake a click.
        if (target.item) {
          if (holdItemById(inv, target.item) < 0) {
            finish(ctx, m, false, "INTERACT_GAVE_UP", `no ${target.item} to place`);
            return;
          }
          m.placeId = target.item;
        } else {
          m.placeId = heldFrom(inv)?.id ?? null;
        }
        m.before = m.placeId ? carryCount(inv, new Set([m.placeId])) : 0;
        // Frame profile targets an ENTITY, not a block: resolve the item-frame uuid nearest the
        // target cell from the mc_frames snapshot. No frame near the target → fail loud (never
        // fall back to a block click that silently does nothing).
        if (target.profile === "frame") {
          const framesR = rt.world.frames(cfg.interact.reach + cfg.interact.frameRadius);
          const uuid = framesR.ok
            ? nearestFrameUuid(framesR.value, target.pos, cfg.interact.frameRadius)
            : null;
          if (!uuid) {
            finish(ctx, m, false, "INTERACT_GAVE_UP", "no item-frame entity near target");
            return;
          }
          m.frameUuid = uuid;
        }
        // Aim THIS tick (the frame entity's cell centre, or the block face centre); the use fires
        // next tick so the rotation flushes first (same split the storage drawer needs).
        void rt.interact.lookAt(faceCenterPoint(target.pos, m.frameUuid ? "CENTER" : target.face));
        setSub(ctx, m, "USE");
        return;
      }

      if (m.sub === "USE") {
        // Frame → right-click the resolved entity; block profiles → the block face.
        m.dispatched = m.frameUuid
          ? rt.interact.useOnEntity(m.frameUuid).ok
          : rt.interact.useOnBlock(target.pos, target.face).ok;
        setSub(ctx, m, "VERIFY");
        return;
      }

      // VERIFY — the interaction is server-authoritative; a same-tick read is stale, so wait the grace.
      if (st.tickCount - m.subStart < cfg.interact.graceTicks) return;
      // `consumed` with no known id to count can't be read → fall back to the dispatch check.
      const effectiveVerify = target.verify === "consumed" && !m.placeId ? "none" : target.verify;
      const after = m.placeId
        ? (() => {
            const r = rt.inv.open();
            return r.ok ? carryCount(r.value, new Set([m.placeId])) : m.before;
          })()
        : 0;
      const placed = verifyPlaced(effectiveVerify, m.dispatched, m.before, after);
      if (placed) finish(ctx, m, true, "INTERACT_DONE", `verify=${effectiveVerify}`);
      else finish(ctx, m, false, "INTERACT_GAVE_UP", `no effect (verify=${effectiveVerify})`);
    },
  },

  isDone(ctx: Ctx): boolean {
    return mem(ctx).done;
  },

  outputs(ctx: Ctx): Record<string, unknown> {
    return { placed: mem(ctx).placed };
  },

  onAbort(ctx: Ctx): void {
    ctx.rt.nav.stop();
  },
};
