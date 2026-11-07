import { hud } from "@/bot/capabilities/hud";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { createMockRuntime } from "@/core/runtime/mock";
import { type HudData, formatHudLines } from "@/shared/domain/hud";
import { Bus } from "@/shared/kernel/bus";
import { Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogSink, Logger } from "@/shared/kernel/logger";
import { describe, expect, it } from "vitest";

const sink: LogSink = { emit: () => {} };

describe("hud domain", () => {
  it("formats three status lines; STOPPED when not running", () => {
    const base: HudData = {
      phase: "MINE",
      running: true,
      phaseTicks: 12,
      toolId: "gtceu:iron_drill",
      toolPct: 73,
      waypoints: 4,
      dumps: 2,
      veinsFound: 9,
    };
    const lines = formatHudLines(base);
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("MINE (12t)");
    expect(lines[1]).toContain("iron_drill 73%");
    expect(lines[2]).toBe("WP:4 Dump:2 Vein:9");
    expect(formatHudLines({ ...base, running: false })[0]).toContain("STOPPED");
  });
});

describe("hud capability", () => {
  it("pushes overlay lines to the runtime on the refresh interval", () => {
    const rt = createMockRuntime();
    const cfg = makeGerdaConfig({ hudInterval: 5 });
    const kernel = new Kernel(rt, new Logger(sink, "ERR"), new Bus(), cfg, GERDA_PHASES);
    kernel.register(hud);
    const st = makeInitialState();
    st.running = true;
    for (let i = 0; i < 5; i++) kernel.tick(st); // tick 5 hits the interval
    expect(rt.state.hudLines.length).toBe(3);
    expect(rt.state.hudLines[0]).toContain("Miner");
  });

  it("still renders while idle (no mission running) — shows STOPPED", () => {
    const rt = createMockRuntime();
    const cfg = makeGerdaConfig({ hudInterval: 5 });
    const kernel = new Kernel(rt, new Logger(sink, "ERR"), new Bus(), cfg, GERDA_PHASES);
    kernel.register(hud);
    const st = makeInitialState();
    st.running = false; // the bug: a normal guard is skipped here, so the HUD vanished
    for (let i = 0; i < 5; i++) kernel.tick(st);
    expect(rt.state.hudLines.length).toBe(3);
    expect(rt.state.hudLines[0]).toContain("Miner");
    expect(rt.state.hudLines[0]).toContain("STOPPED");
  });

  it("stays silent when disabled", () => {
    const rt = createMockRuntime();
    const cfg = makeGerdaConfig({ hudEnabled: false });
    const kernel = new Kernel(rt, new Logger(sink, "ERR"), new Bus(), cfg, GERDA_PHASES);
    kernel.register(hud);
    const st = makeInitialState();
    st.running = true;
    for (let i = 0; i < 20; i++) kernel.tick(st);
    expect(rt.state.hudLines.length).toBe(0);
  });
});
