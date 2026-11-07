// telemetry — game-KPI observability. A global, never
// short-circuiting capability that:
//   - subscribes to the event bus and accumulates counters (blocks mined, veins
//     found, dumps, recoveries, mission starts/dones, …);
//   - each tick refreshes gauges (health, running, current phase/mission);
//   - every cfg.telemetry.interval ticks POSTs the rendered Prometheus exposition text
//     to cfg.telemetry.pushUrl (null = off) — VictoriaMetrics' /api/v1/import/prometheus
//     → query with any PromQL client. Push model: self-contained, no node_exporter.
// All metrics are derived from existing bus events + state — no new instrumentation
// leaks into the mission/reflex code (except the mine blockMined event).
import { Metrics } from "@/shared/domain/metrics";
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { defineSlice } from "@/shared/kernel/slice";

interface TeleMem {
  m: Metrics;
  mission: string | null;
  missionStartTick: number;
  subscribed: boolean;
  /** Consecutive failed pushes: the first logs a WARN, the rest stay quiet until one succeeds. */
  pushFailures: number;
}

const TELEMETRY_SLICE = defineSlice<TeleMem>("telemetry", () => ({
  m: new Metrics(),
  mission: null,
  missionStartTick: 0,
  subscribed: false,
  pushFailures: 0,
}));

function mem(ctx: Ctx): TeleMem {
  return ctx.slice(TELEMETRY_SLICE);
}

// Refresh the gauges that reflect "right now" (counters are event-driven). Labeled
// gauges (phase/mission) are cleared first so only the current member is present.
function refreshGauges(ctx: Ctx, t: TeleMem): void {
  const { rt, st } = ctx;
  t.m.setGauge("up", 1); // liveness: present ⇔ the bot is ticking + pushing (idle or not)
  t.m.setGauge("running", st.running ? 1 : 0);
  t.m.setGauge("tick", st.tickCount);
  t.m.setGauge("phase_ticks", st.phaseTicks);
  const health = rt.player.health();
  if (health.ok) t.m.setGauge("health", health.value);
  t.m.clear("phase");
  t.m.setGauge("phase", 1, { phase: st.phase });
  t.m.clear("mission");
  if (t.mission) t.m.setGauge("mission", 1, { mission: t.mission });
}

function write(ctx: Ctx, t: TeleMem): void {
  const url = ctx.cfg.telemetry.pushUrl;
  if (!url) return;
  const r = ctx.rt.http.post(url, t.m.render(ctx.cfg.telemetry.prefix), "text/plain");
  // One WARN per outage, not one per push: a dead endpoint used to fill the chat and the
  // get_logs window with the same line every interval. The recovery line carries the count.
  if (!r.ok) {
    if (t.pushFailures === 0) {
      ctx.log.warn(ctx.st.tickCount, "TELEMETRY_PUSH_FAIL", { url, error: r.error });
    }
    t.pushFailures++;
    return;
  }
  if (t.pushFailures > 0) {
    ctx.log.info(ctx.st.tickCount, "TELEMETRY_PUSH_RECOVERED", { url, failed: t.pushFailures });
    t.pushFailures = 0;
  }
}

export const telemetry: Capability = {
  name: "telemetry",
  // Heartbeat: refresh gauges + push on the interval EVERY tick, even with no mission
  // running — otherwise an idle/paused bot stops pushing and its series age out of the
  // metrics store (5 min lookback), making "idle" indistinguishable from "dead".
  always: true,

  init(ctx: Ctx): void {
    const t = mem(ctx);
    if (t.subscribed) return;
    t.subscribed = true;
    const m = t.m;
    ctx.bus.on("phaseChanged", (e) => m.inc("phase_transitions_total", { to: e.to }));
    ctx.bus.on("blockMined", () => m.inc("blocks_mined_total"));
    ctx.bus.on("oreFound", () => m.inc("ore_found_total"));
    ctx.bus.on("lootSpotted", () => m.inc("loot_spotted_total"));
    ctx.bus.on("lowHealth", () => m.inc("low_health_total"));
    ctx.bus.on("lowAir", () => m.inc("low_air_total"));
    ctx.bus.on("lowFood", () => m.inc("low_food_total"));
    ctx.bus.on("died", () => m.inc("deaths_total"));
    ctx.bus.on("stuck", () => m.inc("stuck_total"));
    ctx.bus.on("recovered", () => m.inc("recovered_total"));
    // autonomy upkeep (effect-verified): meals reached target, respawns that landed
    // back in-world. Gauges track the last latency so a dashboard shows "how long the
    // last respawn/meal took", counters show "how often".
    ctx.bus.on("ate", (e) => {
      m.inc("ate_total");
      m.setGauge("last_meal_ticks", e.ticks);
    });
    ctx.bus.on("respawned", (e) => {
      m.inc("respawned_total");
      m.setGauge("last_respawn_ticks", e.afterTicks);
    });
    // craft yield — count actual items produced (by id), so a chest run shows planks+chest.
    ctx.bus.on("crafted", (e) => m.inc("items_crafted_total", { id: e.id }, e.count));
    // mission lifecycle + duration. The duration gauge is labeled by name+outcome so a
    // dashboard can read "how long did the last mine take, and did it finish or abort".
    const recordDuration = (name: string, outcome: string): void => {
      m.setGauge("mission_last_duration_ticks", ctx.st.tickCount - t.missionStartTick, {
        name,
        outcome,
      });
    };
    ctx.bus.on("missionStarted", (e) => {
      t.mission = e.name;
      t.missionStartTick = ctx.st.tickCount;
      m.inc("mission_started_total", { name: e.name });
    });
    ctx.bus.on("missionDone", (e) => {
      t.mission = null;
      m.inc("mission_done_total", { name: e.name });
      recordDuration(e.name, "done");
    });
    ctx.bus.on("missionAborted", (e) => {
      t.mission = null;
      m.inc("mission_aborted_total", { name: e.name });
      recordDuration(e.name, "aborted");
    });
  },

  guard(ctx: Ctx): boolean {
    const t = mem(ctx);
    refreshGauges(ctx, t);
    if (ctx.st.tickCount % ctx.cfg.telemetry.interval === 0) write(ctx, t);
    return false;
  },

  commands: {
    // Force an immediate push + log a one-line summary (the structured
    // get_state{level} surface is wired in stage 6).
    metrics(ctx: Ctx): void {
      const t = mem(ctx);
      refreshGauges(ctx, t);
      write(ctx, t);
      ctx.log.info(ctx.st.tickCount, "METRICS", { url: ctx.cfg.telemetry.pushUrl });
    },
  },
};
