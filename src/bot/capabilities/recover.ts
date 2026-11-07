import { sendHome, verifyHome } from "@/bot/capabilities/home-teleport";
import { STATE } from "@/bot/profile/states";
// recover — the global RECOVER handler, the universal safety landing every reflex
// diverts to (vitals/air/tool/stuck/hazard). One owner, mission-agnostic:
//   tick 1            → release keys, #stop Baritone, teleport home (cfg.homeCommand)
//   after teleportWait → re-enter the active mission's initial phase, or IDLE if none
// Replaces the old safety→HOME teleport-out; HOME is now purely a mine dump-trip edge.
import { dist, floorVec } from "@/core/prim/pos";
import type { Runtime } from "@/core/runtime/Runtime";
import type { Vec3 } from "@/core/runtime/types";
import { type BlockReader, submergesAt } from "@/shared/domain/senses";
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { defineSlice } from "@/shared/kernel/slice";

interface RecoverMem {
  attempts: number; // consecutive recoveries inside the backoff window
  lastTick: number; // tick of the previous recovery (to measure the window)
  deadSince: number; // tick we first saw the player dead this episode (0 = alive)
  deathPos: Vec3 | null; // where the player died (captured on the first dead tick) — the respawn-displacement baseline
  surfacing: number; // ticks spent holding jump to rise out of water this episode (0 = not/surfaced)
}
const RECOVER_SLICE = defineSlice<RecoverMem>("recover", () => ({
  attempts: 0,
  lastTick: 0,
  deadSince: 0,
  deathPos: null,
  surfacing: 0,
}));

/** Is the (alive) player submerged over the head right now — a drown trap the teleport-out can't
 *  escape while it's still taking water damage? Reads the live world (unknown → not water). A bot
 *  that can breathe underwater never drowns → never "submerged" for this purpose. */
function submergedNow(rt: Runtime): boolean {
  const cbw = rt.player.canBreatheWater();
  if (cbw.ok && cbw.value) return false;
  const p = rt.player.pos();
  if (!p.ok) return false;
  const reader: BlockReader = (x, y, z) => {
    const r = rt.world.blockId({ x, y, z });
    return r.ok ? r.value : null;
  };
  return submergesAt(reader, floorVec(p.value));
}

export const recover: Capability = {
  name: "recover",

  handlers: {
    RECOVER(ctx: Ctx): void {
      const { rt, cfg, st } = ctx;

      // Death-first: while the player is dead it's on the DeathScreen — chat/teleport do
      // nothing, so press the Respawn button each tick and FREEZE the recovery clock at 0
      // until we're back in-world. Once alive, the phaseTicks-keyed flow below runs from the
      // top exactly as if RECOVER had just begun (no backoff budget burned while dead).
      const mem = ctx.slice(RECOVER_SLICE);
      const alive = rt.player.alive();
      if (alive.ok && !alive.value) {
        if (mem.deadSince === 0) {
          mem.deadSince = st.tickCount;
          // The corpse still reads at the death location while the DeathScreen is up —
          // remember it so the post-respawn position tells us how far the spawn threw us.
          const dp = rt.player.pos();
          mem.deathPos = dp.ok ? dp.value : null;
        }
        const clicked = rt.player.respawn();
        // Throttled: this fires every tick on the DeathScreen; emit at most ~1/s with a
        // suppressed-count, instead of the old hand-rolled `% 20`.
        ctx.log.throttle(st.tickCount, "INFO", "RECOVER_RESPAWN", {
          clicked: clicked.ok ? clicked.value : false,
          deadFor: st.tickCount - mem.deadSince,
        });
        st.phaseTicks = 0;
        return;
      }
      // Effect-verified: we were dead and are now alive → the respawn actually worked.
      // (The old log only ever said "clicked", never "it came back".)
      if (mem.deadSince !== 0) {
        const afterTicks = st.tickCount - mem.deadSince;
        mem.deadSince = 0;
        ctx.log.resetThrottle("RECOVER_RESPAWN");
        const now = rt.player.pos();
        const displaced = mem.deathPos !== null && now.ok ? dist(now.value, mem.deathPos) : null;
        mem.deathPos = null;
        ctx.bus.emit("respawned", { afterTicks });
        ctx.log.info(st.tickCount, "RECOVER_RESPAWNED", { afterTicks, displaced });
        // Respawn teleports to the spawn point — potentially tens of km from the work site
        // (live: bot_2 died mid-EXCAVATE, respawned at the void base 29 km away,
        // and chop then ground a treeless scan loop there). A displaced bot must NOT blindly
        // resume its mission: park PAUSED with an explicit reason so the hub/operator
        // relocates it. An idle bot (no mission) keeps the normal flow and settles in IDLE.
        if (
          displaced !== null &&
          displaced > cfg.safety.respawnDisplacedDist &&
          ctx.activeMission() !== null
        ) {
          mem.surfacing = 0;
          ctx.log.warn(st.tickCount, "RECOVER_RESPAWN_DISPLACED", {
            displaced: Math.round(displaced),
            limit: cfg.safety.respawnDisplacedDist,
          });
          ctx.transition(STATE.PAUSED, "respawn_displaced");
          return;
        }
      }

      // Drowning-aware surfacing (added after a live drowning: a bot pinned in a flooded pocket
      // died in RECOVER). A warmup homeCommand is cancelled by ongoing drown damage/movement, and
      // swim-out is disabled here (RECOVER ∈ REFLEX_SETTLED), so a submerged bot in RECOVER has NO
      // physical escape. FIRST get to air: hold jump to rise, freezing the teleport clock, until the
      // head clears water — THEN the teleport fires on stable, air-restoring footing. A capped pocket
      // (can't surface within cfg.safety.surfaceMaxTicks) gives up rising and falls through to the best-effort
      // teleport/backoff (→ ERROR), rather than jumping forever.
      if (submergedNow(rt)) {
        if (mem.surfacing < cfg.safety.surfaceMaxTicks) {
          mem.surfacing++;
          rt.nav.stop(); // drop any greedy drive first (it releases keys) …
          rt.keys.releaseAll();
          rt.keys.set("key.jump", true); // … then hold ONLY jump to rise straight up
          ctx.log.throttle(st.tickCount, "INFO", "RECOVER_SURFACING", { surfacing: mem.surfacing });
          st.phaseTicks = 0; // don't run the teleport-wait while we're still drowning
          return;
        }
        // Capped pocket — can't rise; stop trying and let the teleport/backoff flow run (best
        // effort). RELEASE the jump we latched here first: the flow below can leave RECOVER by a
        // path that never releases anything — the backoff escalation transitions straight to ERROR
        // BEFORE the `phaseTicks <= 1` releaseAll(), and a plain transition releases no keys. A
        // key.jump surviving that makes rt.keys.driveHeld() true forever, which suppressed the
        // human-takeover reflex forever (see src/shared/reflexes/human.ts). Idempotent per tick;
        // mem.surfacing deliberately stays at the cap so we do not start rising again.
        rt.keys.set("key.jump", false);
      } else if (mem.surfacing > 0) {
        rt.keys.set("key.jump", false);
        ctx.log.info(st.tickCount, "RECOVER_SURFACED", { afterTicks: mem.surfacing });
        mem.surfacing = 0;
      }

      if (st.phaseTicks <= 1) {
        // Backoff: if we keep landing here, the recovery isn't fixing the cause (looping on
        // the same hazard). Count recoveries inside the window; past the limit, escalate to
        // ERROR (park for a human) instead of teleporting forever.
        const withinWindow = st.tickCount - mem.lastTick <= cfg.safety.recoverBackoffWindow;
        mem.attempts = withinWindow ? mem.attempts + 1 : 1;
        mem.lastTick = st.tickCount;
        if (mem.attempts > cfg.safety.recoverMaxAttempts) {
          const attempts = mem.attempts;
          mem.attempts = 0;
          ctx.transition(STATE.ERROR, `recover_backoff_${attempts}`);
          return;
        }
        rt.keys.releaseAll();
        rt.nav.stop();
        // Teleport to safety — unless homeCommand is unset, or disabled after it kept doing nothing.
        const home = sendHome(ctx);
        ctx.log.info(st.tickCount, "RECOVER_BEGIN", {
          from: st.lastPhase,
          attempt: mem.attempts,
          home,
        });
        return;
      }
      if (st.phaseTicks >= cfg.teleportWaitTicks) {
        verifyHome(ctx, "recover");
        mem.surfacing = 0; // episode over — a later drowning surfaces from scratch
        ctx.bus.emit("recovered", { from: st.lastPhase });
        // Hand control back to the active mission; if none, settle in IDLE.
        ctx.toMissionStart("recovered");
        if (st.phase === STATE.RECOVER) ctx.transition(STATE.IDLE, "recover: no mission");
      }
    },
  },
};
