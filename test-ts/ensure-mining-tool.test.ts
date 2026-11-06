// ensureMiningTool — re-equip a real mining tool before breaking, so the bot's own prospect/scan
// step (which leaves the prospector, a non-tool, held) can't silently no-op every break.
// Live-diagnosed: holding gtceu:prospector.hv during DESCEND → DRILL_BREAK_TIMEOUT.
import type { Container } from "@/core/runtime/Runtime";
import { createMockRuntime } from "@/core/runtime/mock";
import {
  HOTBAR_SLOTS,
  HOTBAR_VANILLA_START,
  ensureMiningTool,
  equipSlot,
  heldFrom,
  heldStack,
  isHotbar,
} from "@/shared/held";
import { describe, expect, it } from "vitest";

const stack = (id: string, durabilityPct = 100) => ({ id, count: 1, durabilityPct });

describe("isHotbar / equipSlot (the shared select-or-swap dance)", () => {
  it("isHotbar covers exactly the 9 vanilla hotbar indices 36..44", () => {
    expect(isHotbar(HOTBAR_VANILLA_START - 1)).toBe(false);
    expect(isHotbar(HOTBAR_VANILLA_START)).toBe(true);
    expect(isHotbar(HOTBAR_VANILLA_START + HOTBAR_SLOTS - 1)).toBe(true); // 44
    expect(isHotbar(HOTBAR_VANILLA_START + HOTBAR_SLOTS)).toBe(false); // 45
  });

  it("equipSlot SELECTS a hotbar slot without swapping", () => {
    const rt = createMockRuntime();
    rt.state.hotbar = 0;
    rt.state.slots.set(36, stack("minecraft:dirt"));
    rt.state.slots.set(40, stack("minecraft:cobblestone")); // hotbar index 4
    const inv = rt.inv.open();
    if (!inv.ok) throw new Error("inv");
    equipSlot(inv.value, 40);
    expect(rt.state.hotbar).toBe(4);
    expect(heldStack(rt)?.id).toBe("minecraft:cobblestone");
    expect(rt.state.slots.get(36)?.id).toBe("minecraft:dirt"); // untouched
  });

  it("equipSlot SWAPS a main-inventory slot into the held hotbar slot", () => {
    const rt = createMockRuntime();
    rt.state.hotbar = 1; // held = slot 37
    rt.state.slots.set(37, stack("minecraft:torch"));
    rt.state.slots.set(20, stack("minecraft:diamond")); // main inventory
    const inv = rt.inv.open();
    if (!inv.ok) throw new Error("inv");
    equipSlot(inv.value, 20);
    expect(rt.state.hotbar).toBe(1); // same held index
    expect(heldStack(rt)?.id).toBe("minecraft:diamond");
    expect(rt.state.slots.get(20)?.id).toBe("minecraft:torch"); // the displaced item swapped back
  });
});

describe("ensureMiningTool", () => {
  it("swaps off a held prospector to the hotbar pickaxe", () => {
    const rt = createMockRuntime();
    rt.state.hotbar = 2; // selected = vanilla slot 38
    rt.state.slots.set(36, stack("minecraft:diamond_pickaxe"));
    rt.state.slots.set(38, stack("gtceu:prospector.hv")); // held — a non-tool
    expect(heldStack(rt)?.id).toBe("gtceu:prospector.hv");

    expect(ensureMiningTool(rt)).toBe(true);
    expect(heldStack(rt)?.id).toBe("minecraft:diamond_pickaxe");
  });

  it("leaves a real tool already held alone (chop keeps its axe)", () => {
    const rt = createMockRuntime();
    rt.state.hotbar = 0;
    rt.state.slots.set(36, stack("minecraft:diamond_axe")); // held
    rt.state.slots.set(37, stack("minecraft:diamond_pickaxe")); // a pickaxe is available…
    expect(ensureMiningTool(rt)).toBe(true);
    expect(heldStack(rt)?.id).toBe("minecraft:diamond_axe"); // …but the axe is respected
  });

  it("prefers the freshest mining tool when re-equipping", () => {
    const rt = createMockRuntime();
    rt.state.hotbar = 0;
    rt.state.slots.set(36, stack("gtceu:prospector.hv")); // held non-tool
    rt.state.slots.set(37, stack("minecraft:iron_pickaxe", 20)); // worn
    rt.state.slots.set(38, stack("minecraft:diamond_pickaxe", 95)); // fresh
    expect(ensureMiningTool(rt)).toBe(true);
    expect(heldStack(rt)?.id).toBe("minecraft:diamond_pickaxe");
  });

  it("returns false (and changes nothing) when the bag has no mining tool", () => {
    const rt = createMockRuntime();
    rt.state.hotbar = 0;
    rt.state.slots.set(36, stack("gtceu:prospector.hv"));
    rt.state.slots.set(37, stack("minecraft:cobblestone"));
    expect(ensureMiningTool(rt)).toBe(false);
    expect(heldStack(rt)?.id).toBe("gtceu:prospector.hv");
  });
});

// heldFrom must survive a custom mod GUI (the prospector screen) whose region MAP still
// claims hotbar indices while the menu's REAL slot list is empty — reading slot 36+sel
// there throws "Index N out of bounds for length 0" (live FX_FAIL spam).
describe("heldFrom on an empty-menu custom GUI", () => {
  it("returns null when totalSlots()=0 even though the hotbar region claims indices", () => {
    const emptyMenu: Container = {
      regions: () => ["hotbar", "main"],
      slots: () => [36, 37, 38, 39, 40, 41, 42, 43, 44], // the map still answers
      totalSlots: () => 0, // …but the menu slot list is empty
      slot: () => {
        throw new Error("Index 37 out of bounds for length 0"); // must never be reached
      },
      selectedHotbar: () => 1,
      selectHotbar: () => {},
      quick: () => {},
      swap: () => {},
      dropSlot: () => {},
    };
    expect(heldFrom(emptyMenu)).toBeNull();
  });
});
