import { hasItems, inventoryHasRoom } from "@/bot/orchestrator/guards";
import { createMockRuntime } from "@/core/runtime/mock";
// Step-guard predicates over the mock inventory. hasItems backs the acquisition layer's
// "gather/craft until count" loop (repeatWhile: not hasItems), so its counting across the
// carry inventory (main + hotbar, stacks summed) must be exact.
import type { Ctx } from "@/shared/kernel/capability";
import { describe, expect, it } from "vitest";

const ctxOf = (rt: ReturnType<typeof createMockRuntime>): Ctx => ({ rt }) as unknown as Ctx;

describe("hasItems guard", () => {
  it("fails when the item is absent", () => {
    const rt = createMockRuntime();
    const r = hasItems("minecraft:iron_ingot", 12).check(ctxOf(rt));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("have 0/12");
  });

  it("sums stacks across slots and passes at the threshold", () => {
    const rt = createMockRuntime();
    rt.state.slots.set(10, { id: "minecraft:iron_ingot", count: 5, durabilityPct: 100 });
    rt.state.slots.set(11, { id: "minecraft:iron_ingot", count: 7, durabilityPct: 100 });
    rt.state.slots.set(12, { id: "minecraft:gold_ingot", count: 64, durabilityPct: 100 });
    expect(hasItems("minecraft:iron_ingot", 12).check(ctxOf(rt)).ok).toBe(true);
    expect(hasItems("minecraft:iron_ingot", 13).check(ctxOf(rt)).ok).toBe(false);
  });

  it("counts hotbar slots too", () => {
    const rt = createMockRuntime();
    rt.state.slots.set(36, { id: "rehooked:wood_hook", count: 1, durabilityPct: 100 });
    expect(hasItems("rehooked:wood_hook", 1).check(ctxOf(rt)).ok).toBe(true);
  });

  it("encodes id and n in the guard name", () => {
    expect(hasItems("minecraft:iron_ingot", 12).name).toBe("hasItems(minecraft:iron_ingot,12)");
  });
});

describe("inventoryHasRoom guard (regression alongside hasItems)", () => {
  it("passes on an empty bag", () => {
    const rt = createMockRuntime();
    expect(inventoryHasRoom(0.9).check(ctxOf(rt)).ok).toBe(true);
  });
});
