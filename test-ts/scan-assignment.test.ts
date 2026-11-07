import { core } from "@/bot/capabilities/core";
import { mineMission } from "@/bot/missions/mine";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import type { Box } from "@/core/runtime/types";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogRecord, type LogSink, Logger } from "@/shared/kernel/logger";
import { reflexes } from "@/shared/reflexes";
import { describe, expect, it } from "vitest";

// Fleet-assignment scan filter (fleet hub assignment): the mine scan drops ore outside this bot's region
// / inside a peer's claim BEFORE it escalates to a vein, so two bots never converge on one ore.
// Drive a real mine-mission SCAN with a single ore seeded near the bot and assert ORE_FOUND fires
// only when the assignment permits that ore's XZ.
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

const ORE = { x: 3, y: 64, z: 0 }; // within the first spiral rings of the start pos (0,64,0)
const found = (logs: LogRecord[]) => logs.filter((l) => l.event === "ORE_FOUND");

function run(assignment: { allowed: Box | null; forbidden: Box[] } | null): LogRecord[] {
  const { rt, kernel, st, logs } = bot();
  rt.setBlock(ORE.x, ORE.y, ORE.z, "gtceu:iron_ore"); // air world ⇒ neighbours air ⇒ exposed
  if (assignment) rt.setAssignment(assignment);
  for (let i = 0; i < 40 && st.phase === "SCAN"; i++) kernel.tick(st);
  return logs;
}

describe("mine scan honours the fleet assignment", () => {
  it("finds the ore when there is no assignment (single-bot identity)", () => {
    expect(found(run(null)).length).toBeGreaterThan(0);
  });

  it("finds the ore when the allowed region contains it", () => {
    expect(
      found(run({ allowed: { minX: -8, maxX: 8, minZ: -8, maxZ: 8 }, forbidden: [] })).length,
    ).toBeGreaterThan(0);
  });

  it("does NOT find the ore when it lies outside the allowed region", () => {
    expect(
      found(run({ allowed: { minX: 50, maxX: 60, minZ: 50, maxZ: 60 }, forbidden: [] })),
    ).toHaveLength(0);
  });

  it("does NOT find the ore when a forbidden (peer-claimed) region covers it", () => {
    expect(
      found(run({ allowed: null, forbidden: [{ minX: 0, maxX: 6, minZ: -2, maxZ: 2 }] })),
    ).toHaveLength(0);
  });
});
