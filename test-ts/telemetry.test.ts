import { RING_KINDS } from "@/bot/capabilities/event-export";
import { telemetry } from "@/bot/capabilities/telemetry";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { EVENT_KINDS } from "@/core/ipc/ipc";
import { createMockRuntime } from "@/core/runtime/mock";
import { err, ok } from "@/core/runtime/types";
import { Metrics } from "@/shared/domain/metrics";
import { Bus } from "@/shared/kernel/bus";
import { Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogSink, Logger } from "@/shared/kernel/logger";
import { describe, expect, it } from "vitest";

const sink: LogSink = { emit: () => {} };

describe("metrics domain", () => {
  it("renders counters and gauges with TYPE lines", () => {
    const m = new Metrics();
    m.inc("blocks_mined_total");
    m.inc("blocks_mined_total", {}, 2);
    m.setGauge("health", 17);
    const text = m.render("miner_");
    expect(text).toContain("# TYPE miner_blocks_mined_total counter");
    expect(text).toContain("miner_blocks_mined_total 3");
    expect(text).toContain("# TYPE miner_health gauge");
    expect(text).toContain("miner_health 17");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("keys series by sorted labels and escapes label values", () => {
    const m = new Metrics();
    m.inc("t", { b: "2", a: "1" });
    m.inc("t", { a: "1", b: "2" }); // same series despite key order
    m.inc("t", { q: 'a"\\b' });
    const text = m.render();
    expect(text).toContain('t{a="1",b="2"} 2');
    expect(text).toContain('t{q="a\\"\\\\b"} 1');
  });

  it("clear() drops a whole labeled family (no stale series)", () => {
    const m = new Metrics();
    m.setGauge("phase", 1, { phase: "MINE" });
    m.clear("phase");
    m.setGauge("phase", 1, { phase: "SCAN" });
    const text = m.render();
    expect(text).toContain('phase{phase="SCAN"} 1');
    expect(text).not.toContain("MINE");
  });

  it("skips illegal metric names rather than emitting broken text", () => {
    const m = new Metrics();
    m.inc("x");
    expect(m.render("123-bad ")).toBe("\n");
  });
});

function bot(over = {}) {
  const rt = createMockRuntime();
  const bus = new Bus();
  const cfg = makeGerdaConfig(over);
  const kernel = new Kernel(rt, new Logger(sink, "ERR"), bus, cfg, GERDA_PHASES);
  kernel.register(telemetry);
  const st = makeInitialState();
  st.running = true;
  kernel.init(st); // telemetry subscribes to the bus here
  return { rt, bus, kernel, st };
}

describe("telemetry capability", () => {
  const PUSH_URL = "http://127.0.0.1:8428/api/v1/import/prometheus";

  it("accumulates bus events and pushes exposition text on the interval", () => {
    const { rt, bus, kernel, st } = bot({
      telemetry: { pushUrl: PUSH_URL, interval: 1, prefix: "miner_" },
    });
    bus.emit("blockMined", { x: 1, y: 1, z: 1 });
    bus.emit("blockMined", { x: 2, y: 1, z: 1 });
    bus.emit("phaseChanged", { from: "SCAN", to: "MINE", reason: "x" });
    bus.emit("missionStarted", { name: "mine", params: {} });

    kernel.tick(st); // tick 1 % 1 === 0 → push

    expect(rt.state.httpPosts).toHaveLength(1);
    const post = rt.state.httpPosts[0];
    if (!post) throw new Error("expected a push");
    expect(post.url).toBe(PUSH_URL);
    const prom = post.body;
    expect(prom).toContain("miner_blocks_mined_total 2");
    expect(prom).toContain('miner_phase_transitions_total{to="MINE"} 1');
    expect(prom).toContain('miner_mission_started_total{name="mine"} 1');
    expect(prom).toContain('miner_mission{mission="mine"} 1');
    expect(prom).toContain("miner_health 20"); // mock default
    expect(prom).toContain("miner_running 1");
  });

  it("keeps pushing a heartbeat while idle (no mission running)", () => {
    const { rt, kernel, st } = bot({
      telemetry: { pushUrl: PUSH_URL, interval: 1, prefix: "miner_" },
    });
    st.running = false; // idle / paused — the bug: the old guard pass was skipped here

    kernel.tick(st);

    expect(rt.state.httpPosts).toHaveLength(1);
    const post = rt.state.httpPosts[0];
    if (!post) throw new Error("expected an idle heartbeat push");
    expect(post.body).toContain("miner_up 1"); // liveness present even while idle
    expect(post.body).toContain("miner_running 0");
  });

  it("is a no-op when cfg.telemetry.pushUrl is null", () => {
    const { rt, bus, kernel, st } = bot({ telemetry: { pushUrl: null, interval: 1 } });
    bus.emit("blockMined", { x: 1, y: 1, z: 1 });
    kernel.tick(st);
    expect(rt.state.httpPosts).toHaveLength(0);
  });

  it("the `metrics` command pushes a snapshot immediately", () => {
    // the guard won't push on its own
    const { rt, kernel, st } = bot({ telemetry: { pushUrl: PUSH_URL, interval: 100_000 } });
    kernel.command(st, { type: "metrics" });
    expect(rt.state.httpPosts).toHaveLength(1);
  });

  it("clears the mission gauge on missionDone", () => {
    const { rt, bus, kernel, st } = bot({ telemetry: { pushUrl: PUSH_URL, interval: 1 } });
    bus.emit("missionStarted", { name: "mine", params: {} });
    bus.emit("missionDone", { name: "mine" });
    kernel.tick(st);
    const post = rt.state.httpPosts[0];
    if (!post) throw new Error("expected a push");
    expect(post.body).not.toContain('miner_mission{mission="mine"} 1');
    expect(post.body).toContain('miner_mission_done_total{name="mine"} 1');
  });

  it("counts aborts, deaths, low-air/food and craft yield, and records duration", () => {
    const { rt, bus, kernel, st } = bot({ telemetry: { pushUrl: PUSH_URL, interval: 1 } });
    st.tickCount = 100;
    bus.emit("missionStarted", { name: "mine", params: {} });
    st.tickCount = 160; // 60 ticks later
    bus.emit("missionAborted", { name: "mine" });
    bus.emit("died", { phase: "MINE" });
    bus.emit("lowAir", { air: 20, maxAir: 300, phase: "GOTO" });
    bus.emit("lowFood", { food: 3, phase: "SCAN" });
    bus.emit("crafted", { id: "minecraft:oak_planks", count: 4 });
    bus.emit("crafted", { id: "minecraft:oak_planks", count: 4 });

    kernel.tick(st);
    const post = rt.state.httpPosts[0];
    if (!post) throw new Error("expected a push");
    const prom = post.body;
    expect(prom).toContain('miner_mission_aborted_total{name="mine"} 1');
    expect(prom).toContain("miner_deaths_total 1");
    expect(prom).toContain("miner_low_air_total 1");
    expect(prom).toContain("miner_low_food_total 1");
    expect(prom).toContain('miner_items_crafted_total{id="minecraft:oak_planks"} 8');
    expect(prom).toContain('miner_mission_last_duration_ticks{name="mine",outcome="aborted"} 60');
  });

  it("counts effect-verified autonomy events (ate / respawned) with latency gauges", () => {
    const { rt, bus, kernel, st } = bot({ telemetry: { pushUrl: PUSH_URL, interval: 1 } });
    bus.emit("ate", { food: 20, ticks: 18 });
    bus.emit("ate", { food: 19, ticks: 24 });
    bus.emit("respawned", { afterTicks: 7 });

    kernel.tick(st);
    const post = rt.state.httpPosts[0];
    if (!post) throw new Error("expected a push");
    const prom = post.body;
    expect(prom).toContain("miner_ate_total 2");
    expect(prom).toContain("miner_respawned_total 1");
    expect(prom).toContain("miner_last_meal_ticks 24"); // last meal's latency
    expect(prom).toContain("miner_last_respawn_ticks 7");
  });
});

describe("telemetry defaults and push failures", () => {
  function botWithLog(over = {}) {
    const rt = createMockRuntime();
    const log = new Logger(sink, "TRC");
    const cfg = makeGerdaConfig(over);
    const kernel = new Kernel(rt, log, new Bus(), cfg, GERDA_PHASES);
    kernel.register(telemetry);
    const st = makeInitialState();
    kernel.init(st);
    const events = () => log.recent(500).map((r) => r.event);
    return { rt, kernel, st, events };
  }

  it("ships with telemetry off: no pushUrl, no push, no TELEMETRY_PUSH_FAIL", () => {
    const cfg = makeGerdaConfig({});
    expect(cfg.telemetry.pushUrl).toBeNull();
    const { rt, kernel, st, events } = botWithLog();
    for (let i = 0; i < 3 * cfg.telemetry.interval; i++) kernel.tick(st);
    expect(rt.state.httpPosts).toHaveLength(0);
    expect(events()).not.toContain("TELEMETRY_PUSH_FAIL");
  });

  it("a dead endpoint warns once per outage, and the recovery says how many pushes failed", () => {
    const { rt, kernel, st, events } = botWithLog({
      telemetry: { pushUrl: "http://127.0.0.1:9/none", interval: 1 },
    });
    let up = false;
    rt.http.post = (url, body, contentType) => {
      rt.state.httpPosts.push({ url, body, contentType });
      return up ? ok(undefined) : err("java.net.ConnectException: Connection refused");
    };
    for (let i = 0; i < 5; i++) kernel.tick(st);
    expect(rt.state.httpPosts).toHaveLength(5); // it keeps trying
    expect(events().filter((e) => e === "TELEMETRY_PUSH_FAIL")).toHaveLength(1);
    up = true;
    kernel.tick(st);
    expect(events().filter((e) => e === "TELEMETRY_PUSH_RECOVERED")).toHaveLength(1);
    up = false;
    kernel.tick(st);
    expect(events().filter((e) => e === "TELEMETRY_PUSH_FAIL")).toHaveLength(2); // a new outage
  });
});

describe("event ring schema (drift guard)", () => {
  it("RING_KINDS (what event-export wires) exactly matches EVENT_KINDS (the ring schema)", () => {
    expect(new Set(RING_KINDS)).toEqual(new Set(EVENT_KINDS));
  });
});
