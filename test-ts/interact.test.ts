// Interaction facade (mock) — place/use/look/craft. Verifies the mock mutates the
// in-memory world deterministically so missions that place blocks and craft can be
// unit-tested without a live game. The real impl is verified live (see the spike).
import { encodePos } from "@/core/prim/pos";
import type { ItemStack } from "@/core/runtime/Runtime";
import { createMockRuntime } from "@/core/runtime/mock";
import { describe, expect, it } from "vitest";

const stack = (id: string, count = 1): ItemStack => ({ id, count, durabilityPct: 100 });

describe("interact.placeBlock", () => {
  it("places the held block on the target face and decrements the stack", () => {
    const rt = createMockRuntime();
    rt.state.slots.set(36, stack("minecraft:crafting_table", 2)); // hotbar slot 0
    const r = rt.interact.placeBlock({ x: 0, y: 63, z: 0 }, "TOP");
    expect(r.ok).toBe(true);
    expect(rt.state.blocks.get(encodePos(0, 64, 0))).toBe("minecraft:crafting_table");
    expect(rt.state.slots.get(36)?.count).toBe(1);
  });

  it("errors with nothing held", () => {
    const rt = createMockRuntime();
    expect(rt.interact.placeBlock({ x: 0, y: 63, z: 0 }, "TOP").ok).toBe(false);
  });

  it("errors when the destination is occupied", () => {
    const rt = createMockRuntime();
    rt.state.slots.set(36, stack("minecraft:stone"));
    rt.setBlock(0, 64, 0, "minecraft:dirt");
    expect(rt.interact.placeBlock({ x: 0, y: 63, z: 0 }, "TOP").ok).toBe(false);
  });
});

describe("interact.useOnBlock / useItem / lookAt", () => {
  it("useOnBlock records the opened screen from the target block", () => {
    const rt = createMockRuntime();
    rt.setBlock(1, 64, 1, "minecraft:crafting_table");
    rt.interact.useOnBlock({ x: 1, y: 64, z: 1 }, "TOP");
    expect(rt.state.openScreen).toBe("minecraft:crafting_table");
  });

  it("useItem records the held item id", () => {
    const rt = createMockRuntime();
    rt.state.slots.set(36, stack("minecraft:ender_pearl"));
    rt.interact.useItem();
    expect(rt.state.lastUseItem).toBe("minecraft:ender_pearl");
  });

  it("lookAt records the target", () => {
    const rt = createMockRuntime();
    rt.interact.lookAt({ x: 3, y: 64, z: 5 });
    expect(rt.state.lookTarget).toEqual({ x: 3, y: 64, z: 5 });
  });

  it("closeScreen clears the open screen", () => {
    const rt = createMockRuntime();
    rt.state.openScreen = "minecraft:crafting_table";
    expect(rt.interact.closeScreen().ok).toBe(true);
    expect(rt.state.openScreen).toBeNull();
  });
});

describe("interact.craft (manual grid)", () => {
  it("place → output → take crafts via the server-computed result", () => {
    const rt = createMockRuntime();
    rt.state.recipes.push({
      ingredients: { "minecraft:oak_log": 1 },
      output: { id: "minecraft:oak_planks", count: 4 },
    });
    rt.state.slots.set(10, stack("minecraft:oak_log", 1));

    expect(rt.interact.craft.place(["minecraft:oak_log"]).ok).toBe(true);
    const out = rt.interact.craft.output();
    expect(out.ok && out.value?.id).toBe("minecraft:oak_planks");
    const took = rt.interact.craft.take();
    expect(took.ok && took.value).toBe(4);

    let planks = 0;
    let logs = 0;
    for (const s of rt.state.slots.values()) {
      if (s.id === "minecraft:oak_planks") planks += s.count;
      if (s.id === "minecraft:oak_log") logs += s.count;
    }
    expect(planks).toBe(4);
    expect(logs).toBe(0);
  });

  it("output is null when the placed grid matches no recipe (fail loud, not a fake)", () => {
    const rt = createMockRuntime();
    rt.state.slots.set(10, stack("minecraft:dirt", 1));
    expect(rt.interact.craft.place(["minecraft:dirt"]).ok).toBe(true);
    const out = rt.interact.craft.output();
    expect(out.ok && out.value).toBeNull();
    const took = rt.interact.craft.take();
    expect(took.ok && took.value).toBe(0);
  });

  it("place errors when a required ingredient is missing", () => {
    const rt = createMockRuntime();
    expect(rt.interact.craft.place(["minecraft:oak_log"]).ok).toBe(false);
  });

  it("clearGrid returns placed items to the inventory", () => {
    const rt = createMockRuntime();
    rt.state.slots.set(10, stack("minecraft:oak_log", 1));
    rt.interact.craft.place(["minecraft:oak_log"]);
    expect(rt.interact.craft.clearGrid().ok).toBe(true);
    let logs = 0;
    for (const s of rt.state.slots.values()) if (s.id === "minecraft:oak_log") logs += s.count;
    expect(logs).toBe(1);
  });
});
