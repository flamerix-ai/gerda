// Example: a minimal ALWAYS-ON capability — the smallest real unit of bot behaviour.
//
// This file typechecks against the actual kernel contracts (it's included in
// `bun run check`), but is NOT registered in the bundle. To run it for real:
//   1. copy it into src/bot/capabilities/heartbeat.ts
//   2. register it in src/bot/entry/worker-bundle.ts:  kernel.register(makeHeartbeat())
//   3. `just sync`, then from the host:  python3 scripts/ops/bridge_ctl.py send hello
//
// What it demonstrates:
//   - `always: true` → the guard runs EVERY tick, even while the bot idles (an
//     observability heartbeat, not a reflex — it never preempts anything).
//   - a typed blackboard slice (defineSlice) instead of stringly ctx.st.bb access.
//   - the Result convention: runtime reads return {ok, value} — no nulls, no fakes.
//   - a bridge command: anything you `register` in `commands` is instantly callable
//     over TCP/MCP (bridge_ctl `send hello` / mc_send("hello")) with a correlated ack.
//
// Conventions that reviews enforce (see CONTRIBUTING.md): every tunable comes from
// cfg (src/shared/config/schema.ts) — a magic number in capability code is a bug; runtime
// access only through ctx.rt (the mockable facade), never jsMacros globals.

import type { Capability, Ctx } from "@/shared/kernel/capability";
import { defineSlice } from "@/shared/kernel/slice";

const heartbeatSlice = defineSlice("exampleHeartbeat", () => ({ beats: 0 }));

export function makeHeartbeat(): Capability {
  return {
    name: "example-heartbeat",
    always: true,

    guard(ctx: Ctx): boolean {
      const hb = ctx.slice(heartbeatSlice);
      // Real code would read the interval from cfg — hardcoding here only to keep
      // the example self-contained.
      const everyTicks = 100; // 5 s at 20 tps
      if (ctx.st.tickCount % everyTicks === 0) {
        hb.beats += 1;
        const pos = ctx.rt.player.pos();
        if (pos.ok) {
          ctx.log.info(ctx.st.tickCount, "HEARTBEAT", {
            beat: hb.beats,
            x: pos.value.x,
            y: pos.value.y,
            z: pos.value.z,
          });
        }
      }
      return false; // never short-circuit the tick — heartbeats observe, reflexes preempt
    },

    commands: {
      hello(ctx: Ctx, cmd: Record<string, unknown>): void {
        const who = typeof cmd["name"] === "string" ? cmd["name"] : "world";
        ctx.reply({ hello: who, beats: ctx.slice(heartbeatSlice).beats, phase: ctx.st.phase });
      },
    },
  };
}
