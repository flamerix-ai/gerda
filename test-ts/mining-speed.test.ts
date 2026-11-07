// Locks the mining-speed model against canonical vanilla break
// times. Pure — no runtime. Values cross-checked with the well-known MC dig-time table.
import { UNBREAKABLE, breakTicks, breakTicksForKnown } from "@/shared/domain/mining-speed";
import { describe, expect, it } from "vitest";

describe("breakTicks (vanilla break-time formula)", () => {
  it("stone with a stone pickaxe ≈ 0.56s (12 ticks)", () => {
    // 4/1.5/30 = 0.0889 progress/tick → ceil(11.25) = 12
    expect(breakTicks({ hardness: 1.5, toolSpeed: 4, canHarvest: true })).toBe(12);
  });
  it("punching stone (wrong tool, no drop) ≈ 7.5s (150 ticks)", () => {
    expect(breakTicks({ hardness: 1.5, toolSpeed: 1, canHarvest: false })).toBe(150);
  });
  it("obsidian with a diamond pickaxe ≈ 9.4s (188 ticks)", () => {
    expect(breakTicks({ hardness: 50, toolSpeed: 8, canHarvest: true })).toBe(188);
  });
  it("efficiency III speeds it up (eff²+1)", () => {
    // speed 4 + (9+1) = 14 → 14/1.5/30 = 0.311 → ceil(3.21) = 4
    expect(breakTicks({ hardness: 1.5, toolSpeed: 4, canHarvest: true, efficiency: 3 })).toBe(4);
  });
  it("haste II multiplies speed by 1.4", () => {
    // 4*1.4 = 5.6 → 5.6/1.5/30 = 0.1244 → ceil(8.04) = 9
    expect(breakTicks({ hardness: 1.5, toolSpeed: 4, canHarvest: true, hasteLevel: 2 })).toBe(9);
  });
  it("airborne / underwater mine 5× slower", () => {
    const base = breakTicks({ hardness: 1.5, toolSpeed: 4, canHarvest: true });
    const air = breakTicks({ hardness: 1.5, toolSpeed: 4, canHarvest: true, onGround: false });
    expect(air).toBe(57); // 5 × 11.25 = 56.25 → ceil 57
    expect(air).toBeGreaterThan(base * 4);
  });
  it("unbreakable hardness → UNBREAKABLE; hardness 0 → instant (1)", () => {
    expect(breakTicks({ hardness: -1, toolSpeed: 8, canHarvest: true })).toBe(UNBREAKABLE);
    expect(breakTicks({ hardness: 0, toolSpeed: 1, canHarvest: true })).toBe(1);
  });
});

describe("breakTicksForKnown (vanilla hardness seed)", () => {
  it("resolves a seeded block, UNBREAKABLE for unknown", () => {
    expect(breakTicksForKnown("minecraft:stone", { toolSpeed: 4, canHarvest: true })).toBe(12);
    expect(breakTicksForKnown("minecraft:bedrock", { toolSpeed: 8, canHarvest: true })).toBe(
      UNBREAKABLE,
    );
    expect(breakTicksForKnown("gtceu:some_ore", { toolSpeed: 6, canHarvest: true })).toBe(
      UNBREAKABLE,
    );
  });
});
