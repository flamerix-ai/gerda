import { createMockRuntime } from "@/core/runtime/mock";
// place-cell — the shared filler-equip helper. The subtle part is NOT clobbering the held mining
// tool: a hotbar filler is just selected; a backpack filler is swapped into an EMPTY hotbar slot
// (the tool keeps its slot), falling back to the current slot only when the hotbar is full.
import { equipFiller } from "@/shared/nav/place-cell";
import { describe, expect, it } from "vitest";

const FILLERS = ["minecraft:cobblestone", "minecraft:dirt"];
const tool = { id: "minecraft:diamond_pickaxe", count: 1, durabilityPct: 100 };
const cobble = (count: number) => ({ id: "minecraft:cobblestone", count, durabilityPct: 100 });

describe("equipFiller", () => {
  it("selects a filler already in the hotbar without moving the tool", () => {
    const rt = createMockRuntime();
    rt.state.hotbar = 0;
    rt.state.slots.set(36, tool); // hotbar 0 = tool (held)
    rt.state.slots.set(38, cobble(64)); // hotbar 2 = cobblestone
    const inv = rt.inv.open();
    if (!inv.ok) throw new Error("inv");
    expect(equipFiller(inv.value, FILLERS)).toBe("minecraft:cobblestone");
    expect(rt.state.hotbar).toBe(2); // selected the filler slot
    expect(rt.state.slots.get(36)).toEqual(tool); // tool untouched in its slot
  });

  it("swaps a backpack filler into an EMPTY hotbar slot (keeps the tool)", () => {
    const rt = createMockRuntime();
    rt.state.hotbar = 0;
    rt.state.slots.set(36, tool); // hotbar 0 = tool
    rt.state.slots.set(20, cobble(64)); // backpack (main inventory)
    const inv = rt.inv.open();
    if (!inv.ok) throw new Error("inv");
    expect(equipFiller(inv.value, FILLERS)).toBe("minecraft:cobblestone");
    expect(rt.state.slots.get(36)).toEqual(tool); // tool NOT clobbered
    // cobble landed in some empty hotbar slot, now selected.
    const sel = 36 + rt.state.hotbar;
    expect(rt.state.slots.get(sel)?.id).toBe("minecraft:cobblestone");
    expect(sel).not.toBe(36);
  });

  it("prefers the higher-priority filler when several are present", () => {
    const rt = createMockRuntime();
    rt.state.slots.set(37, { id: "minecraft:dirt", count: 64, durabilityPct: 100 });
    rt.state.slots.set(38, cobble(64));
    const inv = rt.inv.open();
    if (!inv.ok) throw new Error("inv");
    expect(equipFiller(inv.value, FILLERS)).toBe("minecraft:cobblestone"); // rank 0 beats dirt
    expect(rt.state.hotbar).toBe(2);
  });

  it("returns null when the bag has no filler", () => {
    const rt = createMockRuntime();
    rt.state.slots.set(36, tool);
    const inv = rt.inv.open();
    if (!inv.ok) throw new Error("inv");
    expect(equipFiller(inv.value, FILLERS)).toBeNull();
  });
});
