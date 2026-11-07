import { STATE, type State } from "@/bot/profile/states";
import { dist, encodePos, floorVec } from "@/core/prim/pos";
// follow mission — trail a peer (a human like `Steve`, or another bot) as they move, holding
// a follow-gap so we walk WITH them rather than shove into them. The target feed is the render-
// thread peer snapshot (world.peers(), bridged main→worker exactly like mobs/items); movement is
// the greedy navigator re-pathing to the peer's MOVING cell. This is the "follow me to scout a
// base" tool — and the first consumer of the peer sensor (fleet coordination).
//
// Single phase, PERSISTENT: FOLLOW runs until the operator stops it (halt/stop). Losing the peer
// (out of sense range, logged off) does NOT end the mission — it stands and re-acquires by name,
// so "I ran ahead / teleported back" just resumes. Reflexes (vitals/air/stuck/hazard) stay global,
// so following across hazards is their problem, exactly as for hunt.
import { pickPeer } from "@/shared/domain/follow";
import { approachCell, byUuid } from "@/shared/domain/pursuit";
import type { Ctx } from "@/shared/kernel/capability";
import type { PartialTransitionTable } from "@/shared/kernel/fsm";
import type { Mission } from "@/shared/kernel/mission";
import { defineSlice } from "@/shared/kernel/slice";
import { greedyRelease, greedyStep, isBlocked } from "@/shared/nav";

const FOLLOW_EDGES: PartialTransitionTable<State> = {
  FOLLOW: ["PAUSED", "ERROR"],
};

interface FollowMem {
  targetName: string | null; // peer username to follow (null = nearest peer)
  gap: number; // hold distance (params override → cfg.follow.gap)
  lockedUuid: string | null; // the peer we're locked onto (re-found by uuid each tick)
  walking: boolean; // hysteresis latch: are we currently driving toward the peer?
  lostSince: number; // first tick the peer went off-snapshot (-1 = currently sensed)
  warnedLost: boolean; // emitted FOLLOW_WAIT once for the current lost spell (don't spam)
}

const FOLLOW_SLICE = defineSlice<FollowMem>("follow", () => ({
  targetName: null,
  gap: 3,
  lockedUuid: null,
  walking: false,
  lostSince: -1,
  warnedLost: false,
}));

const mem = (ctx: Ctx): FollowMem => ctx.slice(FOLLOW_SLICE);

export const followMission: Mission = {
  name: "follow",
  params: [
    {
      name: "target",
      type: "string",
      required: false,
      desc: "peer username to follow (e.g. Steve); omit = nearest player/bot",
    },
    {
      name: "gap",
      type: "int",
      required: false,
      desc: "hold this many blocks back (default cfg.follow.gap)",
    },
  ],

  edges: FOLLOW_EDGES,
  initialPhase: STATE.FOLLOW,
  movementPhases: new Set([STATE.FOLLOW]),

  // Universal progress contract: FOLLOW is a movement phase, so without a policy it would
  // get the DEFAULT feet backstop — which false-fires on a LEGITIMATE hold (the leader standing still
  // within the gap, or the peer off-snapshot: standing still is correct, indefinitely). So gate the
  // feet signature on the `walking` latch (prior art: the stuck-reflex gates on movementHeld): exempt
  // whenever we're holding/waiting/blocked-waiting, and only watch the feet while we are ACTIVELY
  // driving toward the peer. A true walk-wedge (greedy answers "moving" but the feet never advance)
  // trips at the FOLLOW walk-stall budget → PAUSED (loud + recoverable; follow never ERRORs).
  progress: {
    FOLLOW: {
      name: "follow-walk",
      signature: (ctx: Ctx) => {
        if (!mem(ctx).walking) return null; // holding / lost-wait / blocked-wait → standing still is fine
        const p = ctx.rt.player.pos();
        if (!p.ok) return null;
        const f = floorVec(p.value);
        return encodePos(f.x, f.y, f.z);
      },
      budgetTicks: (cfg) => cfg.safety.phaseStallTicks,
    },
  },

  init(ctx: Ctx, params: Record<string, unknown>): void {
    const m = mem(ctx);
    const t = params["target"];
    m.targetName = typeof t === "string" && t.trim() !== "" ? t.trim() : null;
    const g = params["gap"];
    m.gap = typeof g === "number" && g > 0 ? g : ctx.cfg.follow.gap;
    m.lockedUuid = null;
    m.walking = false;
    m.lostSince = -1;
    m.warnedLost = false;
    ctx.log.info(ctx.st.tickCount, "FOLLOW_START", {
      target: m.targetName ?? "(nearest)",
      gap: m.gap,
    });
  },

  handlers: {
    FOLLOW(ctx: Ctx): void {
      const { rt, cfg, st } = ctx;
      const m = mem(ctx);
      const peersR = rt.world.peers(cfg.follow.senseRadius);
      const peers = peersR.ok ? peersR.value : [];
      // Re-find the locked peer by uuid (it moves); if it left the snapshot, re-acquire by name.
      const peer =
        (m.lockedUuid ? byUuid(peers, m.lockedUuid) : null) ?? pickPeer(peers, m.targetName);

      if (!peer) {
        // Peer not sensed — stand and wait (follow is persistent, never ends on a lost peer).
        if (m.walking) {
          greedyRelease(rt);
          m.walking = false;
        }
        if (m.lostSince < 0) m.lostSince = st.tickCount;
        if (!m.warnedLost && st.tickCount - m.lostSince >= cfg.follow.lostWaitTicks) {
          ctx.log.info(st.tickCount, "FOLLOW_WAIT", {
            target: m.targetName ?? "(nearest)",
            sensed: peers.length,
          });
          m.warnedLost = true;
        }
        return;
      }

      m.lostSince = -1;
      m.warnedLost = false;
      m.lockedUuid = peer.uuid;

      const posR = rt.player.pos();
      if (!posR.ok) return; // no self position this tick — try again next
      const range = dist(posR.value, peer);

      // Hysteresis: hold once inside the gap; only resume walking once the peer pulls past
      // gap+slack, so a leader standing still doesn't make us stutter walk/stop every tick.
      if (m.walking && range <= m.gap) {
        greedyRelease(rt);
        m.walking = false;
        ctx.log.throttle(
          st.tickCount,
          "INFO",
          "FOLLOW_HOLD",
          { dist: Math.round(range * 10) / 10 },
          40,
        );
        return;
      }
      if (!m.walking && range <= m.gap + cfg.follow.resumeSlack) {
        // Within the comfort band and not walking → keep holding (no step this tick).
        return;
      }

      m.walking = true;
      const step = greedyStep(rt, cfg, approachCell(peer), {
        column: true,
        bestEffort: true,
        arrivalRadius: m.gap,
      });
      if (step === "arrived") {
        greedyRelease(rt);
        m.walking = false;
      } else if (isBlocked(step)) {
        // Can't path this tick (peer behind a wall / mid-air). Release and wait — the peer is
        // moving, so next tick's cell is usually reachable. Follow is forgiving; never ERROR.
        greedyRelease(rt);
        m.walking = false;
        ctx.log.throttle(
          st.tickCount,
          "WARN",
          "FOLLOW_BLOCKED",
          { dist: Math.round(range * 10) / 10 },
          40,
        );
      }
    },
  },

  // Persistent: only halt/stop ends it. (The operator drives the scout, then stops the bot.)
  isDone(): boolean {
    return false;
  },

  outputs(ctx: Ctx): Record<string, unknown> {
    return { target: mem(ctx).targetName ?? "(nearest)" };
  },

  onAbort(ctx: Ctx): void {
    greedyRelease(ctx.rt);
    ctx.rt.keys.releaseAll();
    ctx.rt.nav.stop();
  },
};
