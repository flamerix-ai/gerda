import { parseIdList } from "@/bot/missions/_params";
import { STATE, type State } from "@/bot/profile/states";
// hunt mission — find a huntable mob, chase it (greedy re-path as it moves), melee it to
// death, then loop until a kill-count is met (or no targets remain → graceful end). The
// target feed is the render-thread mob snapshot (world.mobs(), bridged main→worker exactly
// like dropped items); the strike is the crosshair attack primitive (interact.attack()),
// aimed by lookAt — so no live entity reference is ever needed off the worker thread.
//
// FSM:  SEEK → CHASE → STRIKE → (kill) → SEEK …
//   SEEK   pick the nearest huntable mob; lock its uuid; → CHASE. None → graceful done.
//   CHASE  greedy-walk toward the mob's (moving) cell until within melee reach → STRIKE.
//          Target left the snapshot before any hit (fled) or chase timed out → SEEK.
//   STRIKE aim + swing on the attack-cooldown; target gone from snapshot = killed → count it,
//          linger briefly for vanilla auto-pickup, → SEEK. Moved out of reach → back to CHASE.
//
// Drops are vanilla auto-pickup (the bot kills at melee range, standing on/next to the drop),
// so there is no explicit LOOT phase here — the kill-spot linger covers it. Reflexes (vitals/
// air/stuck/hazard) stay global, so "chase a pig across a river" is the air reflex's problem.
import { pickTarget } from "@/shared/domain/hunt";
import { approachCell, byUuid, withinRange } from "@/shared/domain/pursuit";
import { holdItemById } from "@/shared/held";
import type { Ctx } from "@/shared/kernel/capability";
import type { PartialTransitionTable } from "@/shared/kernel/fsm";
import type { Mission } from "@/shared/kernel/mission";
import { defineSlice } from "@/shared/kernel/slice";
import { greedyRelease, greedyStep, isBlocked } from "@/shared/nav";

const HUNT_EDGES: PartialTransitionTable<State> = {
  SEEK: ["CHASE", "PAUSED", "ERROR"],
  CHASE: ["STRIKE", "SEEK", "PAUSED", "ERROR"],
  STRIKE: ["CHASE", "SEEK", "PAUSED", "ERROR"],
};

interface HuntMem {
  huntable: string[]; // resolved target id whitelist (params override → cfg default)
  goalCount: number; // kills to stop after; 0 = until no targets remain
  kills: number;
  targetUuid: string | null; // the mob we're locked onto (re-found by uuid each tick)
  chaseStart: number; // tick CHASE began for the current target (timeout reference)
  lastSwing: number; // tick of the last attack() (swing cooldown reference)
  lootUntil: number; // tick to linger after a kill so auto-pickup grabs the drops
  emptySince: number; // first tick SEEK saw an empty snapshot (-1 = not currently empty)
  done: boolean;
}

const HUNT_SLICE = defineSlice<HuntMem>("hunt", () => ({
  huntable: [],
  goalCount: 0,
  kills: 0,
  targetUuid: null,
  chaseStart: 0,
  lastSwing: -9999,
  lootUntil: 0,
  emptySince: -1,
  done: false,
}));

const mem = (ctx: Ctx): HuntMem => ctx.slice(HUNT_SLICE);

/** Parse a CSV/JSON-array of ids (the `targets` param), else null → use the cfg default. */
function parseTargets(raw: unknown): string[] | null {
  const ids = parseIdList(raw);
  return ids.length > 0 ? ids : null;
}

/** Best-effort: hold a sword if the bot is carrying one (hunting "with a sword"). Fists work
 *  too — never fail the mission over a missing weapon. Matches any "*_sword" id, longest-named
 *  first so netherite/diamond win over wooden when several are carried. */
function equipSword(ctx: Ctx): void {
  const invR = ctx.rt.inv.open();
  if (!invR.ok) return;
  const inv = invR.value;
  let best: string | null = null;
  for (const slot of inv.slots()) {
    const s = inv.slot(slot);
    if (s?.id.endsWith("_sword")) {
      if (best === null || s.id.length > best.length) best = s.id;
    }
  }
  if (best) {
    const held = holdItemById(inv, best);
    if (held >= 0) ctx.log.info(ctx.st.tickCount, "HUNT_WEAPON", { id: best });
  }
}

/** Aim point: the mob's torso (feet y + 0.5) so the crosshair raycast intersects the hitbox
 *  for both tall (cow) and short (chicken/rabbit) mobs. */
function aimAt(mob: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: mob.x, y: mob.y + 0.5, z: mob.z };
}

export const huntMission: Mission = {
  name: "hunt",
  params: [
    {
      name: "count",
      type: "int",
      required: false,
      desc: "stop after N kills (0/omit = until none)",
    },
    {
      name: "targets",
      type: "string",
      required: false,
      desc: 'override huntable ids — JSON array ["minecraft:cow"] or CSV (default cfg.hunt.targets)',
    },
  ],

  edges: HUNT_EDGES,
  initialPhase: STATE.SEEK,
  movementPhases: new Set([STATE.CHASE]),

  init(ctx: Ctx, params: Record<string, unknown>): void {
    const m = mem(ctx);
    m.kills = 0;
    m.targetUuid = null;
    m.lootUntil = 0;
    m.lastSwing = -9999;
    m.emptySince = -1;
    m.done = false;
    const c = params["count"];
    m.goalCount = typeof c === "number" && c > 0 ? Math.floor(c) : 0;
    m.huntable = parseTargets(params["targets"]) ?? [...ctx.cfg.hunt.targets];
    equipSword(ctx);
    ctx.log.info(ctx.st.tickCount, "HUNT_START", { goal: m.goalCount, targets: m.huntable.length });
  },

  handlers: {
    SEEK(ctx: Ctx): void {
      const { rt, cfg, st } = ctx;
      const m = mem(ctx);
      // Linger on the kill spot so vanilla auto-pickup grabs the drops before moving on.
      if (st.tickCount < m.lootUntil) return;
      if (m.goalCount > 0 && m.kills >= m.goalCount) {
        m.done = true;
        return;
      }
      const mobsR = rt.world.mobs(cfg.hunt.senseRadius);
      const mobs = mobsR.ok ? mobsR.value : [];
      const target = pickTarget(mobs, new Set(m.huntable));
      if (!target) {
        // Tolerate a transient empty snapshot (5-tick publish cadence, a worker-start sync race,
        // a target momentarily off-list) — only END after the grace window stays dry. A single
        // empty read must NOT permanently abort the hunt.
        if (m.emptySince < 0) m.emptySince = st.tickCount;
        if (st.tickCount - m.emptySince < cfg.hunt.seekGraceTicks) return;
        ctx.log.info(st.tickCount, "HUNT_NO_TARGETS", { kills: m.kills, sensed: mobs.length });
        m.done = true; // graceful end — nothing to hunt (never ERROR)
        return;
      }
      m.emptySince = -1;
      m.targetUuid = target.uuid;
      m.chaseStart = st.tickCount;
      ctx.log.info(st.tickCount, "HUNT_TARGET", {
        type: target.type,
        dist: Math.round(target.distance * 10) / 10,
      });
      ctx.transition(STATE.CHASE, "target locked");
    },

    CHASE(ctx: Ctx): void {
      const { rt, cfg, st } = ctx;
      const m = mem(ctx);
      const mobsR = rt.world.mobs(cfg.hunt.senseRadius);
      const mob = m.targetUuid ? byUuid(mobsR.ok ? mobsR.value : [], m.targetUuid) : null;
      const posR = rt.player.pos();
      if (!mob || !posR.ok) {
        greedyRelease(rt);
        ctx.log.info(st.tickCount, "HUNT_LOST", { phase: "CHASE" });
        m.targetUuid = null;
        ctx.transition(STATE.SEEK, "target lost");
        return;
      }
      if (withinRange(posR.value, mob, cfg.hunt.reach)) {
        greedyRelease(rt);
        ctx.transition(STATE.STRIKE, "in reach");
        return;
      }
      if (st.tickCount - m.chaseStart > cfg.hunt.chaseTimeoutTicks) {
        greedyRelease(rt);
        ctx.log.warn(st.tickCount, "HUNT_CHASE_TIMEOUT", { uuid: m.targetUuid });
        m.targetUuid = null;
        ctx.transition(STATE.SEEK, "chase timeout");
        return;
      }
      const step = greedyStep(rt, cfg, approachCell(mob), {
        column: true,
        bestEffort: true,
        arrivalRadius: cfg.hunt.reach,
      });
      if (step === "arrived") ctx.transition(STATE.STRIKE, "arrived");
      else if (isBlocked(step)) {
        greedyRelease(rt);
        ctx.log.warn(st.tickCount, "HUNT_BLOCKED", { uuid: m.targetUuid });
        m.targetUuid = null;
        ctx.transition(STATE.SEEK, "path blocked");
      }
    },

    STRIKE(ctx: Ctx): void {
      const { rt, cfg, st } = ctx;
      const m = mem(ctx);
      const mobsR = rt.world.mobs(cfg.hunt.senseRadius);
      const mob = m.targetUuid ? byUuid(mobsR.ok ? mobsR.value : [], m.targetUuid) : null;
      // Target gone from the snapshot while we were striking it at melee range = killed.
      if (!mob) {
        m.kills += 1;
        m.targetUuid = null;
        m.lootUntil = st.tickCount + cfg.hunt.lootSettleTicks;
        ctx.log.info(st.tickCount, "HUNT_KILL", { kills: m.kills, goal: m.goalCount });
        ctx.transition(STATE.SEEK, "killed");
        return;
      }
      const posR = rt.player.pos();
      if (posR.ok && !withinRange(posR.value, mob, cfg.hunt.reach)) {
        ctx.transition(STATE.CHASE, "target moved off"); // re-chase
        return;
      }
      // In reach: face the mob (cosmetic — attack(uuid) is range-checked server-side, not
      // crosshair-based) and swing on the attack cooldown (a too-fast swing does reduced damage).
      // reliability-ok: aim is fire-and-forget — the kill is confirmed by the target leaving
      // world.mobs() next tick, not by this call's Result; a failed look just whiffs one swing.
      void rt.interact.lookAt(aimAt(mob));
      if (st.tickCount - m.lastSwing >= cfg.hunt.swingEvery) {
        // reliability-ok: best-effort melee swing — effect verified by the mob's health/absence
        // in the next world.mobs() snapshot, never by this fire-and-forget call's Result.
        void rt.interact.attack(mob.uuid);
        m.lastSwing = st.tickCount;
        ctx.log.throttle(st.tickCount, "INFO", "HUNT_STRIKE", { hp: Math.round(mob.health) }, 10);
      }
    },
  },

  isDone(ctx: Ctx): boolean {
    const m = mem(ctx);
    return m.done;
  },

  outputs(ctx: Ctx): Record<string, unknown> {
    return { kills: mem(ctx).kills };
  },

  onAbort(ctx: Ctx): void {
    greedyRelease(ctx.rt);
    ctx.rt.keys.releaseAll();
    ctx.rt.nav.stop();
  },
};
