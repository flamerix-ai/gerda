// home-return — the teleport legs of the dump round trip.
//   HOME:   issue the home command (/home), wait for the teleport to settle, then
//           branch to DUMP if a dump is queued, else resume SCAN. Safety also
//           routes here for low health / critical tool, in which case nothing is
//           pending and we just resume after the cooldown.
//   RETURN: issue the back command (/back) to teleport to the mining spot, wait,
//           then SCAN — the spiral cache + origin persist so it resumes in place.
// Teleport timing is server-side and opaque, so we cool down a fixed number of ticks
// (cfg.teleportWaitTicks). Verify-convention: we ALSO snapshot the pre-teleport position
// and, once settled, confirm we actually moved — a failed /home (no home set, on cooldown)
// otherwise proceeds silently at the wrong spot. WARN-only: we still continue (the chest/
// field may legitimately be close), but the failure is now visible. The HOME leg goes through
// the shared home-teleport gate but never feeds its disable streak: only a RECOVER no-move
// counts there (home-teleport.ts). A /home that moved the bot records the "home" waypoint where
// it landed; a no-move records none. See docs/EXTENDING.md.
import { sendHome, verifyHome } from "@/bot/capabilities/home-teleport";
import { recordHome } from "@/bot/capabilities/persistence";
import { DUMP_SLICE } from "@/bot/missions/mine/dump-mem";
import { STATE } from "@/bot/profile/states";
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { defineSlice } from "@/shared/kernel/slice";

interface TeleportMem {
  fromX: number;
  fromZ: number;
  known: boolean; // false until we snapshot a valid pre-teleport position
}
const TELEPORT_SLICE = defineSlice<TeleportMem>("teleport", () => ({
  fromX: 0,
  fromZ: 0,
  known: false,
}));

/** Snapshot the player's XZ at the start of a teleport leg (tick 1). */
function snapshotFrom(ctx: Ctx): void {
  const mem = ctx.slice(TELEPORT_SLICE);
  const p = ctx.rt.player.pos();
  mem.known = p.ok;
  if (p.ok) {
    mem.fromX = p.value.x;
    mem.fromZ = p.value.z;
  }
}

/** Effect-check a settled teleport: log TELEPORT_OK with the distance moved, or WARN
 *  TELEPORT_NO_MOVE if we didn't move far enough for it to have taken. */
function verifyMoved(ctx: Ctx, leg: string): void {
  const { rt, cfg, st } = ctx;
  const mem = ctx.slice(TELEPORT_SLICE);
  const p = rt.player.pos();
  if (!mem.known || !p.ok) return; // couldn't read either end — nothing to assert
  const dx = p.value.x - mem.fromX;
  const dz = p.value.z - mem.fromZ;
  const moved = Math.hypot(dx, dz);
  if (moved < cfg.teleportMinMoveBlocks) {
    ctx.log.warn(st.tickCount, "TELEPORT_NO_MOVE", { leg, moved: Math.round(moved) });
  } else {
    ctx.log.info(st.tickCount, "TELEPORT_OK", { leg, moved: Math.round(moved) });
  }
}

export const homeReturn: Capability = {
  name: "home-return",

  handlers: {
    HOME(ctx: Ctx): void {
      const { rt, cfg, st } = ctx;
      if (st.phaseTicks === 1) {
        rt.keys.releaseAll();
        sendHome(ctx); // the shared gate: stops sending a /home that keeps doing nothing
        return;
      }
      if (st.phaseTicks < cfg.teleportWaitTicks) return;

      if (verifyHome(ctx, "home")) recordHome(ctx);
      const dump = ctx.slice(DUMP_SLICE);
      if (dump.pending) ctx.transition(STATE.DUMP, "home reached, dump queued");
      else ctx.transition(STATE.SCAN, "home reached, nothing to dump");
    },

    RETURN(ctx: Ctx): void {
      const { rt, cfg, st } = ctx;
      if (st.phaseTicks === 1) {
        snapshotFrom(ctx);
        rt.chat.say(cfg.backCommand);
        return;
      }
      if (st.phaseTicks < cfg.teleportWaitTicks) return;
      verifyMoved(ctx, "return");
      ctx.transition(STATE.SCAN, "returned to field");
    },
  },
};
