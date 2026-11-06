import { craftGridSlots, craftOutSlot } from "@/core/runtime/craft-regions";
import { describe, expect, it } from "vitest";

// Pins the player→table region FALLBACK that ships live (the real impl can't run in CI, and
// the mock now resolves through this same helper). Before this, the table branch — the one
// most likely to break on Monifactory — had zero coverage.
const slotsFrom = (regions: Record<string, number[]>) => (r: string) => regions[r] ?? [];

describe("craft-regions resolver", () => {
  it("uses the player 2×2 names when the inventory grid is open", () => {
    const get = slotsFrom({ crafting_in: [1, 2, 3, 4], craft_out: [0], main: [9] });
    expect(craftGridSlots(get)).toEqual([1, 2, 3, 4]);
    expect(craftOutSlot(get)).toBe(0);
  });

  it("falls back to the table 3×3 names when crafting_in is empty", () => {
    // An open 3×3 crafting table reports input/output and NO crafting_in/craft_out.
    const get = slotsFrom({ input: [100, 101, 102, 103, 104, 105, 106, 107, 108], output: [0] });
    expect(craftGridSlots(get)).toHaveLength(9);
    expect(craftOutSlot(get)).toBe(0);
  });

  it("prefers the player grid when BOTH are somehow present (never silently picks the table)", () => {
    const get = slotsFrom({
      crafting_in: [1, 2, 3, 4],
      input: [100, 101],
      craft_out: [0],
      output: [5],
    });
    expect(craftGridSlots(get)).toEqual([1, 2, 3, 4]);
    expect(craftOutSlot(get)).toBe(0);
  });

  it("returns empty / undefined when no crafting grid is open", () => {
    const get = slotsFrom({ main: [9, 10], hotbar: [36] });
    expect(craftGridSlots(get)).toEqual([]);
    expect(craftOutSlot(get)).toBeUndefined();
  });
});
