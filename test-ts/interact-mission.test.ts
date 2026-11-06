// interact mission — walk to a block (GOTO) then AIM (hold+lookAt) → USE (useOnBlock) → VERIFY.
// Movement is short-circuited by setPos arrival; the useOnBlock is a spliced fake (like the storage
// drawer test) that consumes the held stack, so we lock the mission's hold/aim/use/verify sequencing
// + the profile-driven verify, not in-game placement mechanics (those are live-verified).
import { core } from "@/bot/capabilities/core";
import { interactMission } from "@/bot/missions/interact";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import { type Result, ok } from "@/core/runtime/types";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogRecord, type LogSink, Logger } from "@/shared/kernel/logger";
import { resetGreedyNav } from "@/shared/nav";
import { describe, expect, it } from "vitest";

function bot(rt: MockRuntime): { kernel: Kernel; st: BotState; logs: LogRecord[] } {
  const logs: LogRecord[] = [];
  const sink: LogSink = { emit: (line) => logs.push(JSON.parse(line) as LogRecord) };
  const kernel = new Kernel(
    rt,
    new Logger(sink, "INFO"),
    new Bus(),
    makeGerdaConfig(),
    GERDA_PHASES,
  );
  kernel.register(core).registerMission(interactMission);
  const state = makeInitialState();
  kernel.init(state);
  return { kernel, st: state, logs };
}

const ev = (logs: LogRecord[], name: string) => logs.find((l) => l.event === name);

describe("interact mission", () => {
  it("display profile: holds the item, uses the block, verifies the held item was consumed", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    rt.setBlock(2, 64, 0, "modid:display_pedestal");
    rt.state.slots.set(9, { id: "minecraft:diamond", count: 3, durabilityPct: 100 }); // in the bag

    // Splice: a useOnBlock with a held stack drops one (a display/pedestal absorbs one).
    let used = 0;
    rt.interact.useOnBlock = (): Result<void> => {
      used += 1;
      const heldIdx = 36 + rt.state.hotbar;
      const s = rt.state.slots.get(heldIdx);
      if (s) {
        if (s.count <= 1) rt.state.slots.delete(heldIdx);
        else rt.state.slots.set(heldIdx, { ...s, count: s.count - 1 });
      }
      return ok(undefined);
    };

    const { kernel, st: state, logs } = bot(rt);
    rt.setPos({ x: 1, y: 64, z: 0 }); // adjacent to the display block
    kernel.startMission(state, "interact", {
      x: 2,
      y: 64,
      z: 0,
      item: "minecraft:diamond",
      profile: "display",
    });
    expect(state.phase).toBe("GOTO");

    for (let i = 0; i < 40 && kernel.activeMission() !== null; i++) kernel.tick(state);

    expect(used).toBe(1);
    expect(ev(logs, "INTERACT_DONE")).toBeDefined();
    // one diamond left the bag (3 → 2)
    let diamonds = 0;
    for (const s of rt.state.slots.values()) if (s.id === "minecraft:diamond") diamonds += s.count;
    expect(diamonds).toBe(2);
    expect(state.phase).toBe("IDLE");
  });

  it("consumed verify fails loud (GAVE_UP) when nothing was actually taken", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    rt.setBlock(2, 64, 0, "modid:display_pedestal");
    rt.state.slots.set(9, { id: "minecraft:diamond", count: 3, durabilityPct: 100 });
    rt.interact.useOnBlock = (): Result<void> => ok(undefined); // dispatches but takes nothing

    const { kernel, st: state, logs } = bot(rt);
    rt.setPos({ x: 1, y: 64, z: 0 });
    kernel.startMission(state, "interact", {
      x: 2,
      y: 64,
      z: 0,
      item: "minecraft:diamond",
      profile: "display",
    });
    for (let i = 0; i < 40 && kernel.activeMission() !== null; i++) kernel.tick(state);

    expect(ev(logs, "INTERACT_DONE")).toBeUndefined();
    expect(ev(logs, "INTERACT_GAVE_UP")).toBeDefined();
    expect(state.phase).toBe("IDLE");
  });

  it("generic profile: a dispatched right-click is placed (verify none, no consume needed)", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    rt.setBlock(2, 64, 0, "minecraft:lever");
    let used = 0;
    rt.interact.useOnBlock = (): Result<void> => {
      used += 1;
      return ok(undefined);
    };

    const { kernel, st: state, logs } = bot(rt);
    rt.setPos({ x: 1, y: 64, z: 0 });
    kernel.startMission(state, "interact", { x: 2, y: 64, z: 0, profile: "generic" });
    for (let i = 0; i < 40 && kernel.activeMission() !== null; i++) kernel.tick(state);

    expect(used).toBe(1);
    expect(ev(logs, "INTERACT_DONE")).toBeDefined();
    expect(state.phase).toBe("IDLE");
  });

  it("frame profile: resolves the frame ENTITY near the target and right-clicks it (useOnEntity)", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    // A frame entity hanging in cell (2,64,0) (against a support wall); the mock's useOnEntity
    // consumes 1 from the held stack when the uuid resolves — the empty-frame vanilla semantics.
    rt.state.frames.push({
      type: "minecraft:item_frame",
      uuid: "frame-1",
      x: 2.03,
      y: 64.5,
      z: 0.5,
      distance: 0,
    });
    rt.state.slots.set(9, { id: "minecraft:diamond", count: 3, durabilityPct: 100 });

    const { kernel, st: state, logs } = bot(rt);
    rt.setPos({ x: 1, y: 64, z: 0 });
    kernel.startMission(state, "interact", {
      x: 2,
      y: 64,
      z: 0,
      item: "minecraft:diamond",
      profile: "frame",
    });
    for (let i = 0; i < 40 && kernel.activeMission() !== null; i++) kernel.tick(state);

    expect(rt.state.lastUseEntity).toBe("frame-1"); // the ENTITY was clicked, not the block
    expect(ev(logs, "INTERACT_DONE")).toBeDefined();
    let diamonds = 0;
    for (const s of rt.state.slots.values()) if (s.id === "minecraft:diamond") diamonds += s.count;
    expect(diamonds).toBe(2); // consumed verify: 3 → 2
    expect(state.phase).toBe("IDLE");
  });

  it("frame profile with NO frame entity near the target fails loud (no silent block fallback)", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    rt.state.slots.set(9, { id: "minecraft:diamond", count: 3, durabilityPct: 100 });
    let blockClicks = 0;
    rt.interact.useOnBlock = (): Result<void> => {
      blockClicks += 1;
      return ok(undefined);
    };

    const { kernel, st: state, logs } = bot(rt);
    rt.setPos({ x: 1, y: 64, z: 0 });
    kernel.startMission(state, "interact", {
      x: 2,
      y: 64,
      z: 0,
      item: "minecraft:diamond",
      profile: "frame",
    });
    for (let i = 0; i < 40 && kernel.activeMission() !== null; i++) kernel.tick(state);

    expect(blockClicks).toBe(0); // never degraded to a block click
    expect(ev(logs, "INTERACT_GAVE_UP")?.fields).toMatchObject({
      note: "no item-frame entity near target",
    });
    expect(state.phase).toBe("IDLE");
  });

  it("gives up when the requested item is not in the bag", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    rt.setBlock(2, 64, 0, "minecraft:item_frame");
    const { kernel, st: state, logs } = bot(rt);
    rt.setPos({ x: 1, y: 64, z: 0 });
    kernel.startMission(state, "interact", {
      x: 2,
      y: 64,
      z: 0,
      item: "minecraft:diamond",
      profile: "frame",
    });
    for (let i = 0; i < 40 && kernel.activeMission() !== null; i++) kernel.tick(state);

    expect(ev(logs, "INTERACT_GAVE_UP")?.fields).toMatchObject({
      note: "no minecraft:diamond to place",
    });
    expect(state.phase).toBe("IDLE");
  });
});
