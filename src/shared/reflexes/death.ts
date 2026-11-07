// death reflex — the last backstop. vitals already bails to RECOVER at low HP, so a
// reached-zero death means something killed the bot faster than a tick (fall, lava
// burst, mob crit). On !alive we release inputs, #stop Baritone, emit `died`, and divert
// to RECOVER so that — once the player respawns — control returns to the active mission.
//
// This reflex DETECTS death and parks in RECOVER; RECOVER then drives the actual respawn
// (it presses the DeathScreen "Respawn" button via rt.player.respawn() each tick until the
// player is back, only then teleporting home + resuming). RECOVER, not this reflex, owns the
// respawn loop, so death.guard skips ONLY RECOVER — not all settled phases: a bot that dies
// while PAUSED or ERROR (e.g. drowned in leftover water) must still reach RECOVER to respawn.
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { LIFECYCLE } from "@/shared/kernel/phase";
import { BODY } from "@/shared/kernel/resource";

export const death: Capability = {
  name: "death",
  survival: true, // runs even with no mission — a dead IDLE bot must still respawn
  requires: [BODY],

  guard(ctx: Ctx): boolean {
    const { st } = ctx;
    if (st.phase === LIFECYCLE.RECOVER) return false;
    if (ctx.res(BODY).alive) return false;

    ctx.bus.emit("died", { phase: st.phase });
    ctx.divert(LIFECYCLE.RECOVER, "died");
    return true;
  },
};
