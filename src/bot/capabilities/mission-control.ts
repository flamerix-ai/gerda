import { asRecord } from "@/core/prim/typed-object";
// mission-control — the bridge-facing commands that drive the mission layer. A thin
// always-on capability whose commands call back into the kernel (it closes over the
// Kernel instance, which the other capabilities never need). Commands flow the normal
// dispatch path, so `mission_start` is just another command the container routes.
//
// Query results are returned as STRUCTURED DATA on the correlated bridge ack via
// ctx.reply() (surfaced as `result.data`) AND logged to the journal; the command set
// itself is exposed through `describe()` (worker-bundle.ts).
import type { Capability, Ctx } from "@/shared/kernel/capability";
import type { Kernel } from "@/shared/kernel/capability";

export function makeMissionControl(kernel: Kernel): Capability {
  return {
    name: "mission-control",

    commands: {
      mission_start(ctx: Ctx, cmd: Record<string, unknown>): void {
        const rawName = cmd["name"];
        const rawParams = cmd["params"];
        const name = typeof rawName === "string" ? rawName : "";
        kernel.startMission(ctx.st, name, asRecord(rawParams));
      },

      mission_abort(ctx: Ctx): void {
        kernel.abortMission(ctx.st);
      },

      mission_status(ctx: Ctx): void {
        // Fleet coordination: expose the drill's current vein target so the fleet hub (a bridge
        // CLIENT — bots have no outbound networking) can observe it and lease the vein column on
        // this bot's behalf (claimedVeins pushed to peers). Read generically off the blackboard —
        // mission-control must not import mission modules (layering).
        const drillBB = asRecord(ctx.st.bb["drill"]);
        const vein = asRecord(drillBB["vein"]);
        const drill =
          typeof vein["x"] === "number" && typeof vein["z"] === "number"
            ? {
                vein: { x: vein["x"], z: vein["z"] },
                ore: typeof drillBB["ore"] === "string" ? drillBB["ore"] : null,
              }
            : null;
        const status = {
          active: kernel.activeMission(),
          phase: ctx.st.phase,
          running: ctx.st.running,
          drill,
        };
        ctx.reply(status);
        ctx.log.info(ctx.st.tickCount, "MISSION_STATUS", status);
      },

      missions(ctx: Ctx): void {
        const available = kernel.missionNames();
        ctx.reply({ available });
        ctx.log.info(ctx.st.tickCount, "MISSIONS", { available });
      },
    },
  };
}
