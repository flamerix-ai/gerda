import { STATE } from "@/bot/profile/states";
// core — global lifecycle commands (start/pause/resume/halt). Declarative command
// handlers instead of a switch in the entry point. Mission-agnostic: start/resume
// re-enter the ACTIVE mission's initial phase via ctx.toMissionStart (a no-op when no
// mission is active), so core carries no mining vocabulary. The old IDLE→SCAN
// bootstrap moved into the mission (startMission seeds the initial phase directly).
import type { Capability, Ctx } from "@/shared/kernel/capability";

export const core: Capability = {
  name: "core",

  // Register the global shutdown teardown so Module.stop is declarative (kernel.dispose()
  // drains it) instead of a hand-maintained list of facade calls in the entry point.
  init(ctx: Ctx): void {
    ctx.onStop(() => {
      ctx.rt.keys.releaseAll();
      ctx.rt.nav.stop();
      ctx.rt.hud.clear();
    });
  },

  commands: {
    start(ctx: Ctx): void {
      if (ctx.st.running) return;
      ctx.st.running = true;
      if (ctx.st.phase === STATE.IDLE || ctx.st.phase === STATE.PAUSED) {
        ctx.toMissionStart("module start");
      }
    },
    pause(ctx: Ctx): void {
      if (ctx.st.running && ctx.st.phase !== STATE.PAUSED) {
        ctx.transition(STATE.PAUSED, "module pause");
      }
    },
    resume(ctx: Ctx): void {
      if (ctx.st.phase === STATE.PAUSED) {
        ctx.toMissionStart("module resume");
      }
    },
    halt(ctx: Ctx): void {
      ctx.rt.keys.releaseAll();
      ctx.st.running = false;
      ctx.rt.nav.stop();
      if (ctx.st.phase !== STATE.PAUSED) ctx.transition(STATE.PAUSED, "module halt");
    },
  },
};
