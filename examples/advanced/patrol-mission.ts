// Example (advanced): a complete MISSION — a pluggable goal state-machine.
//
// A mission is what `mission_start` activates: it brings its own FSM edges,
// per-phase handlers, params, completion check and outputs, and the kernel swaps
// it in/out at runtime with no reload (src/shared/kernel/mission.ts). This one
// patrols between the bot's starting position and a target point for N laps —
// small enough to read in one sitting, but it exercises every part of the
// mission contract that the real missions (drill, fetch, search…) use:
//
//   - `params`        — self-described `mission_start` payload (surfaced by the
//                       `missions` bridge command, validated by helpers).
//   - `edges`         — the phases this mission adds to the global FSM while
//                       active. Phases come from the fixed STATE SSOT
//                       (src/bot/profile/states.ts) — missions reuse states, they
//                       don't invent new ones.
//   - a typed slice   — ALL mission memory lives in one defineSlice bag, never
//                       in module-level variables (a reload must not leak state).
//   - `movementPhases`— tells the reflex layer "movement here is bot-driven",
//                       so the stuck/human-input reflexes interpret it right.
//   - walkTo          — the shared GOTO leg (src/bot/missions/_goto-leg.ts): every
//                       mission that walks uses this ONE routine so arrive/
//                       timeout/blocked handling can't drift between missions.
//   - `isDone`/`outputs` — completion is polled by the kernel after each tick;
//                       outputs feed the sequencer (mission chaining).
//   - a mission command — `patrol_status` answers over the bridge with DATA
//                       (ctx.reply), not just a log line.
//   - `onAbort`       — cleanup when the user swaps missions mid-run.
//
// Run it for real:
//   1. copy to src/bot/missions/patrol/index.ts
//   2. register in src/bot/entry/worker-bundle.ts: kernel.registerMission(patrolMission)
//   3. `just sync`, then `./gerda reload-worker` (the running worker keeps the old bundle, and
//      `mission_start patrol` answers "unknown mission: patrol" until it reloads), then:
//        ./gerda ctl send mission_start '{"name":"patrol","params":{"x":120,"y":64,"z":-30,"laps":3}}'
//        ./gerda ctl send patrol_status
//
// Conventions on display (CONTRIBUTING.md): no magic numbers (laps default via
// param helper; budgets/radii live in cfg for real missions), fail-loud (bad
// params end the mission with a WARN, never a silent guess), runtime access only
// through ctx.rt (Result-typed — see the pos() read in init).

import { walkTo } from "@/bot/missions/_goto-leg";
import { intParam, intParamOr } from "@/bot/missions/_params";
import { STATE } from "@/bot/profile/states";
import type { Vec3 } from "@/core/runtime/types";
import type { Ctx } from "@/shared/kernel/capability";
import type { Mission } from "@/shared/kernel/mission";
import { defineSlice } from "@/shared/kernel/slice";

interface PatrolMem {
  /** Where the patrol started (captured at init) — the "home" end of the leg. */
  home: Vec3 | null;
  /** The far end of the leg, from params. */
  target: Vec3 | null;
  /** Which end we're currently walking toward. */
  heading: "target" | "home";
  /** A lap = home → target → home. */
  lapsDone: number;
  lapsWanted: number;
  done: boolean;
}

const PATROL_SLICE = defineSlice<PatrolMem>("examplePatrol", () => ({
  home: null,
  target: null,
  heading: "target",
  lapsDone: 0,
  lapsWanted: 0,
  done: false,
}));

function mem(ctx: Ctx): PatrolMem {
  return ctx.slice(PATROL_SLICE);
}

/** One waypoint reached: flip direction; count a lap each time we're back home. */
function onWaypoint(ctx: Ctx, m: PatrolMem): void {
  if (m.heading === "target") {
    m.heading = "home";
    return;
  }
  m.heading = "target";
  m.lapsDone += 1;
  ctx.log.info(ctx.st.tickCount, "PATROL_LAP", { lap: m.lapsDone, of: m.lapsWanted });
  if (m.lapsDone >= m.lapsWanted) m.done = true;
}

export const patrolMission: Mission = {
  name: "patrol",
  params: [
    { name: "x", type: "int", required: true, desc: "far-end X" },
    { name: "y", type: "int", required: true, desc: "far-end Y" },
    { name: "z", type: "int", required: true, desc: "far-end Z" },
    { name: "laps", type: "int", desc: "round trips to walk (default 1)" },
  ],

  // The whole mission lives in the shared GOTO movement phase; when isDone fires
  // the kernel collapses to IDLE, so GOTO → IDLE is the only edge we add.
  edges: {
    [STATE.GOTO]: [STATE.IDLE],
  },
  initialPhase: STATE.GOTO,
  movementPhases: new Set([STATE.GOTO]),

  init(ctx: Ctx, params: Record<string, unknown>): void {
    const m = mem(ctx);
    const x = intParam(params, "x");
    const y = intParam(params, "y");
    const z = intParam(params, "z");
    m.target = x !== null && y !== null && z !== null ? { x, y, z } : null;
    m.lapsWanted = intParamOr(params, "laps", 1);
    m.lapsDone = 0;
    m.heading = "target";
    m.done = false;
    // Runtime reads return a Result — no nulls to forget, no fabricated fallback.
    // Can't read our own feet → the mission ends instead of patrolling from (0,0,0).
    const pos = ctx.rt.player.pos();
    m.home = pos.ok
      ? { x: Math.floor(pos.value.x), y: Math.floor(pos.value.y), z: Math.floor(pos.value.z) }
      : null;
  },

  handlers: {
    GOTO(ctx: Ctx): void {
      const m = mem(ctx);
      const dest = m.heading === "target" ? m.target : m.home;
      if (!dest) {
        ctx.log.warn(ctx.st.tickCount, "PATROL_GAVE_UP", { reason: "missing target or home" });
        m.done = true;
        return;
      }
      walkTo(ctx, dest, {
        onArrive: () => onWaypoint(ctx, m),
        // Best-effort like goto/fetch: terrain trouble ends the patrol loudly
        // rather than grinding forever — the stall watchdog would
        // catch a silent spin anyway, but we'd rather say why we stopped.
        onTimeout: () => {
          ctx.log.warn(ctx.st.tickCount, "PATROL_GAVE_UP", {
            reason: "leg timeout",
            heading: m.heading,
          });
          m.done = true;
        },
        onBlocked: () => {
          ctx.log.warn(ctx.st.tickCount, "PATROL_GAVE_UP", {
            reason: "blocked, no path",
            heading: m.heading,
          });
          m.done = true;
        },
      });
    },
  },

  commands: {
    // Mission-scoped: exists on the bridge only while patrol is active, and
    // answers with structured data in the correlated ack (ctx.reply), so a
    // caller gets fields to read — not a log line to scrape.
    patrol_status(ctx: Ctx): void {
      const m = mem(ctx);
      ctx.reply({ heading: m.heading, laps: m.lapsDone, of: m.lapsWanted, done: m.done });
    },
  },

  isDone(ctx: Ctx): boolean {
    return mem(ctx).done;
  },

  outputs(ctx: Ctx): Record<string, unknown> {
    // Read by the sequencer when chaining missions (e.g. patrol → report).
    return { laps: mem(ctx).lapsDone };
  },

  onAbort(ctx: Ctx): void {
    // The user swapped missions mid-leg — stop the navigator so the next
    // mission starts from a standing bot, not one mid-stride.
    ctx.rt.nav.stop();
  },
};
