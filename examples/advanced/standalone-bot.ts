// Example (advanced): a COMPLETE standalone bot from just the Runtime facade.
//
// The three-layer story, bottom to top:
//
//   1. harness/  (plain JS)  — game access: bridge, worker, eyes/hands. Runs ANY
//      `Module` object — see harness/bot_template.js for the no-build JS path.
//   2. src/core/runtime/          — the typed jsMacros boundary (`Runtime`) + its mock
//      twin. THIS is the only layer this example uses: full TypeScript typing over
//      the game, and everything below `Module` is yours to design.
//   3. src/shared/kernel + missions — OUR machinery (FSM, capabilities, reflexes, nav,
//      missions). Optional! The shipped Gerda Bot entry
//      (src/bot/entry/worker-bundle.ts) assembles all of it; this file deliberately
//      uses none, to show the floor is much lower than it looks.
//
// What this bot does: a tiny "sentry" — once started it watches its own position
// and health, reports over chat every reportEveryTicks, and complains if it took
// damage since the last report. ~60 lines of logic, fully typed.
//
// Run it for real:
//   1. Point the build at this entry (one line in tsup.config.ts):
//        entry: { "__gerda_bot.bundle": "examples/advanced/standalone-bot.ts" }
//      (worker.js loads the bundle by that fixed name — building YOUR entry under
//       it is how any custom bot replaces ours; swap the line back to restore.)
//   2. `bun run build && ./gerda sync`
//   3. `./gerda reload-worker` loads the new bundle into the running worker.
//   4. Over the bridge: `./gerda ctl send sentry_start` → chat reports begin;
//      `./gerda ctl send sentry_stop` stops them. `describe` lists your commands in
//      mc://api automatically — the MCP server needs no redeploy for a new bot.
//      Do not reuse the container's own command names (`start`, `stop`, `halt`, `status`,
//      `goto`, … — `./gerda ctl send describe` lists them): main.js answers those itself, and
//      your command() never sees them.
//
// Unit-test it the same way the real bot is tested: construct it with the MOCK
// runtime (src/core/runtime/mock.ts) instead of createJsMacrosRuntime — the facade is
// the seam that makes any bot on it testable without Minecraft.

import type { Runtime } from "@/core/runtime/Runtime";
import { createJsMacrosRuntime } from "@/core/runtime/jsmacros";

// All bot memory lives in the state object the harness threads through
// init → tick → command. Never in module-level variables: the worker can
// reload the bundle at any time, and only this state survives the contract.
interface SentryState {
  running: boolean;
  lastReportTick: number;
  lastHealth: number | null;
}

const REPORT_EVERY_TICKS = 100; // 5s — a tunable would live in a config SSOT in a real bot

function makeSentry(rt: Runtime) {
  return {
    name: "sentry_example",

    init(): SentryState {
      rt.chat.log("[sentry] loaded — send `sentry_start` over the bridge to begin");
      return { running: false, lastReportTick: 0, lastHealth: null };
    },

    // Called every Minecraft tick by worker.js. Must stay fast (one tick budget)
    // and must RETURN the (new) state.
    tick(st: SentryState): SentryState {
      if (!st.running) return st;
      const now = rt.tick();
      if (now - st.lastReportTick < REPORT_EVERY_TICKS) return st;

      // Facade reads return Result<T> — the game can always be mid-teleport or
      // menu-locked, so every read is explicitly fallible. No silent defaults.
      const pos = rt.player.pos();
      const health = rt.player.health();
      if (!pos.ok || !health.ok) return st; // not in-world this tick; try later

      const dmg =
        st.lastHealth !== null && health.value < st.lastHealth
          ? ` — TOOK ${(st.lastHealth - health.value).toFixed(1)} DAMAGE`
          : "";
      rt.chat.log(
        `[sentry] at ${Math.floor(pos.value.x)},${Math.floor(pos.value.y)},${Math.floor(pos.value.z)} hp=${health.value.toFixed(1)}${dmg}`,
      );
      return { running: true, lastReportTick: now, lastHealth: health.value };
    },

    // Bridge passthrough: anything main.js doesn't handle itself lands here
    // (`./gerda ctl send <type>` / MCP mc_send).
    command(st: SentryState, cmd: { type: string }): SentryState {
      switch (cmd.type) {
        case "sentry_start":
          rt.chat.log("[sentry] watching");
          return { ...st, running: true };
        case "sentry_stop":
          rt.chat.log("[sentry] paused");
          return { ...st, running: false };
        default:
          rt.chat.log(`[sentry] unknown command: ${cmd.type}`);
          return st;
      }
    },

    // Self-description → merged into the container's command manifest (mc://api),
    // so an LLM operator discovers your bot's commands without reading code.
    describe(): Record<string, { where: string; desc: string; params: unknown[] }> {
      return {
        sentry_start: { where: "worker", desc: "start the sentry report loop", params: [] },
        sentry_stop: { where: "worker", desc: "stop the sentry report loop", params: [] },
      };
    },

    stop(st: SentryState): void {
      st.running = false;
      rt.chat.log("[sentry] unloaded");
    },
  };
}

// The one bundle↔harness handoff: assign `Module` on the global scope; worker.js
// eval-loads the file and picks it up. Facade failures are surfaced via the
// callback (a real bot would log them; see worker-bundle.ts for the full version).
const runtime = createJsMacrosRuntime((op, error) => {
  runtime.chat.log(`[sentry] FX_FAIL ${op}: ${error}`);
});
(globalThis as { Module?: unknown }).Module = makeSentry(runtime);
