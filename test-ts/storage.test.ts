import { MINE_EDGES } from "@/bot/missions/mine";
import { storage } from "@/bot/missions/mine/storage";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import type { ItemStack } from "@/core/runtime/Runtime";
import { createMockRuntime } from "@/core/runtime/mock";
import { expectOk } from "@/core/runtime/types";
import { Bus } from "@/shared/kernel/bus";
import { Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogRecord, type LogSink, Logger } from "@/shared/kernel/logger";
import { describe, expect, it } from "vitest";

const sink: LogSink = { emit: () => {} };
const stack = (id: string): ItemStack => ({ id, count: 1, durabilityPct: 100 });

function dumpBot() {
  const rt = createMockRuntime();
  // storage owns DUMP; DUMP→RETURN is a mine-mission edge, so load MINE_EDGES.
  const kernel = new Kernel(
    rt,
    new Logger(sink, "ERR"),
    new Bus(),
    makeGerdaConfig(),
    GERDA_PHASES,
    [MINE_EDGES],
  );
  kernel.register(storage);
  const st = makeInitialState();
  st.running = true;
  st.phase = "DUMP";
  return { rt, kernel, st };
}

describe("storage DUMP", () => {
  it("deposits ore + junk into an open container, then → RETURN", () => {
    const { rt, kernel, st } = dumpBot();
    rt.state.slots.set(9, stack("gtceu:iron_ore"));
    rt.state.slots.set(10, stack("minecraft:cobblestone"));
    expectOk(rt.inv.open(), "mock inv open").regions = () => ["hotbar", "main", "container"];
    kernel.tick(st);
    expect(st.phase).toBe("RETURN");
    expect(rt.state.slots.get(9)).toBeUndefined();
    expect(rt.state.slots.get(10)).toBeUndefined();
  });

  it("with no container open, drops junk but keeps ore, then → RETURN", () => {
    const { rt, kernel, st } = dumpBot();
    rt.state.slots.set(9, stack("gtceu:iron_ore"));
    rt.state.slots.set(10, stack("minecraft:cobblestone"));
    for (let i = 0; i < 42; i++) kernel.tick(st); // past the chest grace window
    expect(st.phase).toBe("RETURN");
    expect(rt.state.slots.get(10)).toBeUndefined(); // junk dropped
    expect(rt.state.slots.get(9)?.id).toBe("gtceu:iron_ore"); // ore kept
  });

  it("WARNs DEPOSIT_INCOMPLETE when ore stays in the bag (full/blocked chest)", () => {
    // Verify-convention: a silent quick() failure must not log a clean "deposited".
    const logs: LogRecord[] = [];
    const capturing: LogSink = { emit: (line) => logs.push(JSON.parse(line) as LogRecord) };
    const rt = createMockRuntime();
    const kernel = new Kernel(
      rt,
      new Logger(capturing, "INFO"),
      new Bus(),
      makeGerdaConfig(),
      GERDA_PHASES,
      [MINE_EDGES],
    );
    kernel.register(storage);
    const st = makeInitialState();
    st.running = true;
    st.phase = "DUMP";

    rt.state.slots.set(9, stack("gtceu:iron_ore"));
    const inv = expectOk(rt.inv.open(), "mock inv open");
    inv.regions = () => ["hotbar", "main", "container"];
    inv.quick = () => {}; // simulate a full/locked chest — quick() is a no-op

    kernel.tick(st);
    const warn = logs.find((l) => l.event === "DEPOSIT_INCOMPLETE");
    expect(warn?.level).toBe("WARN");
    expect((warn?.fields as { oreLeft: number }).oreLeft).toBe(1);
    expect(st.phase).toBe("RETURN"); // still proceeds — surfaced, not stuck
  });
});
