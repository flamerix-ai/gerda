import { core } from "@/bot/capabilities/core";
import { mineMission } from "@/bot/missions/mine";
import type { MiningMem } from "@/bot/missions/mine/mining-mem";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogRecord, type LogSink, Logger } from "@/shared/kernel/logger";
import { reflexes } from "@/shared/reflexes";
import { describe, expect, it } from "vitest";

// Chunk-aware SCAN re-anchor: the spiral search index persists across ticks but is anchored at the
// live player pos, so a SCAN resumed far from the last anchor must reset the index → near rings
// around the new spot get searched first. Drive a real mine-mission SCAN with an EMPTY world (no ore
// → stays in SPIRAL, never transitions out) and teleport the bot mid-scan.
function bot(): { rt: MockRuntime; kernel: Kernel; st: BotState; logs: LogRecord[] } {
  const logs: LogRecord[] = [];
  const sink: LogSink = { emit: (line) => logs.push(JSON.parse(line) as LogRecord) };
  const rt = createMockRuntime();
  const kernel = new Kernel(
    rt,
    new Logger(sink, "INFO"),
    new Bus(),
    makeGerdaConfig(),
    GERDA_PHASES,
  );
  kernel.register(core);
  for (const r of reflexes) kernel.register(r);
  kernel.registerMission(mineMission);
  const st = makeInitialState();
  kernel.init(st);
  kernel.startMission(st, "mine");
  return { rt, kernel, st, logs };
}

const mem = (st: BotState): MiningMem => st.bb["mining"] as MiningMem;
const reanchors = (logs: LogRecord[]) => logs.filter((l) => l.event === "SCAN_REANCHOR");

describe("chunk-aware SCAN re-anchor", () => {
  it("resets the spiral index when the bot resumes SCAN ≥ one chunk from the anchor", () => {
    const { rt, kernel, st, logs } = bot();
    expect(st.phase).toBe("SCAN");

    // First SCAN tick anchors at the start pos (0,64,0) and advances the spiral index.
    kernel.tick(st);
    expect(st.phase).toBe("SCAN"); // empty world → no ore → stays scanning
    expect(mem(st).scanAnchor).toEqual({ x: 0, y: 64, z: 0 });
    expect(mem(st).spiralIdx).toBeGreaterThan(0);

    // Teleport the bot a full chunk away (simulating a mined-out vein / waypoint walk), then tick.
    rt.setPos({ x: 40, y: 64, z: 0 });
    kernel.tick(st);

    expect(reanchors(logs)).toHaveLength(1);
    expect((reanchors(logs)[0]?.fields as { droppedIdx: number }).droppedIdx).toBeGreaterThan(0);
    expect(mem(st).scanAnchor).toEqual({ x: 40, y: 64, z: 0 });
  });

  it("does NOT re-anchor while the bot holds position (stationary SCAN)", () => {
    const { kernel, st, logs } = bot();
    for (let i = 0; i < 5; i++) kernel.tick(st);
    expect(reanchors(logs)).toHaveLength(0);
    expect(mem(st).scanAnchor).toEqual({ x: 0, y: 64, z: 0 });
  });

  it("does NOT re-anchor for a sub-threshold hop (< cfg.scan.reanchorDist)", () => {
    const { rt, kernel, st, logs } = bot();
    kernel.tick(st);
    rt.setPos({ x: 8, y: 64, z: 0 }); // half a chunk — below the 16-block default
    kernel.tick(st);
    expect(reanchors(logs)).toHaveLength(0);
  });
});
