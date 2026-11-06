import type { Container, ItemStack } from "@/core/runtime/Runtime";
import { carryCount, carrySlots, readEntries } from "@/shared/domain/inventory";
import { describe, expect, it } from "vitest";

/** A minimal carry-only fake Container backed by a slot→stack map (the helpers only read
 *  `slots()` / `slot(i)`). */
function fakeCarry(entries: Record<number, ItemStack>): Container {
  const map = new Map(Object.entries(entries).map(([k, v]) => [Number(k), v]));
  return {
    regions: () => ["hotbar", "main"],
    slots: () => [...map.keys()],
    totalSlots: () => map.size,
    slot: (i) => map.get(i) ?? null,
    selectedHotbar: () => 0,
    selectHotbar: () => {},
    quick: () => {},
    swap: () => {},
    dropSlot: () => {},
  };
}

const stack = (id: string, count: number): ItemStack => ({ id, count }) as ItemStack;

describe("carryCount", () => {
  const c = fakeCarry({ 0: stack("a", 3), 1: stack("b", 2), 5: stack("a", 4) });

  it("sums counts across slots holding any id in the set", () => {
    expect(carryCount(c, new Set(["a"]))).toBe(7);
    expect(carryCount(c, new Set(["a", "b"]))).toBe(9);
  });

  it("returns 0 when nothing matches / empty set", () => {
    expect(carryCount(c, new Set(["z"]))).toBe(0);
    expect(carryCount(c, new Set())).toBe(0);
  });
});

describe("carrySlots", () => {
  const c = fakeCarry({ 0: stack("a", 3), 1: stack("b", 2), 5: stack("a", 4) });

  it("returns slot indices holding a matching id in slot order", () => {
    expect(carrySlots(c, new Set(["a"]))).toEqual([0, 5]);
    expect(carrySlots(c, new Set(["b"]))).toEqual([1]);
    expect(carrySlots(c, new Set(["z"]))).toEqual([]);
  });
});

describe("readEntries", () => {
  const c = fakeCarry({ 0: stack("a", 3), 2: stack("b", 2) });

  it("builds {slot,id} entries over the whole carry inventory by default", () => {
    expect(readEntries(c)).toEqual([
      { slot: 0, id: "a" },
      { slot: 2, id: "b" },
    ]);
  });

  it("honours an explicit slot list and skips empty slots", () => {
    expect(readEntries(c, [0, 1, 2])).toEqual([
      { slot: 0, id: "a" },
      { slot: 2, id: "b" },
    ]);
  });
});
