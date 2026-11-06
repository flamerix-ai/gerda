// Runtime CONTRACT — behavioural invariants the L0 facade must satisfy, asserted against an
// implementation rather than a specific impl's internals. Modelled on ipc-contract.test.ts.
// Today only the mock runs in CI (the real impl needs the game). The invariants are written
// as a table so a future MC_LIVE harness can run the same assertions against the real
// runtime over the bridge; where real and mock legitimately differ in ok-STRENGTH, the
// delta is documented inline (the type system guarantees the SURFACE matches; this guards
// the BEHAVIOUR the type system can't see).
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import { describe, expect, it } from "vitest";

function withTable(rt: MockRuntime): void {
  // Open a 3×3 table screen (what useOnBlock does live): switches the grid regions to
  // input/output, so gridSize must resolve to 9 via the shared fallback.
  rt.state.openScreen = "minecraft:crafting_table";
}

describe("runtime contract (mock; real-gated for MC_LIVE)", () => {
  it("slots() with no args returns the carry inventory (main+hotbar), never empty", () => {
    const rt = createMockRuntime();
    const inv = rt.inv.open();
    expect(inv.ok).toBe(true);
    if (!inv.ok) return;
    const carry = inv.value.slots();
    // 27 main (9..35) + 9 hotbar (36..44) = 36; the real wrapper normalizes the same way
    // (jsMacros' bare getSlots() returns empty — the facade fixes that for both impls).
    expect(carry.length).toBe(36);
  });

  it("craft.gridSize is 4 with only the player grid, 9 with a table open", () => {
    const rt = createMockRuntime();
    const before = rt.interact.craft.gridSize();
    expect(before.ok && before.value).toBe(4);
    withTable(rt);
    const after = rt.interact.craft.gridSize();
    expect(after.ok && after.value).toBe(9);
  });

  it("placeBlock with nothing held → err (both impls)", () => {
    const rt = createMockRuntime();
    const r = rt.interact.placeBlock({ x: 0, y: 64, z: 0 }, "TOP");
    expect(r.ok).toBe(false);
  });

  it("placeBlock ok ⇒ the block is observable next read (mock: synchronous; real: ~1 tick)", () => {
    const rt = createMockRuntime();
    rt.state.hotbar = 0;
    rt.state.slots.set(36, { id: "minecraft:crafting_table", count: 1, durabilityPct: 100 });
    // place against the TOP of the block at (0,63,0) → lands at (0,64,0)
    const r = rt.interact.placeBlock({ x: 0, y: 63, z: 0 }, "TOP");
    expect(r.ok).toBe(true);
    // NOTE: in the mock `ok` means "applied" (asserted here); in the REAL runtime `ok` means
    // "dispatched" and this read would need a tick of settle — the documented strength delta.
    const id = rt.world.blockId({ x: 0, y: 64, z: 0 });
    expect(id.ok && id.value).toBe("minecraft:crafting_table");
  });

  it("useOnBlock opens a screen; closeScreen clears it", () => {
    const rt = createMockRuntime();
    rt.setBlock(0, 64, 0, "minecraft:crafting_table");
    const open = rt.interact.useOnBlock({ x: 0, y: 64, z: 0 }, "TOP");
    expect(open.ok).toBe(true);
    expect(rt.state.openScreen).toBe("minecraft:crafting_table");
    const close = rt.interact.closeScreen();
    expect(close.ok).toBe(true);
    expect(rt.state.openScreen).toBeNull();
  });

  it("craft place→output→take consumes inputs and yields the seeded output", () => {
    const rt = createMockRuntime();
    rt.state.recipes.push({
      ingredients: { "minecraft:oak_log": 1 },
      output: { id: "minecraft:oak_planks", count: 4 },
    });
    rt.state.slots.set(10, { id: "minecraft:oak_log", count: 1, durabilityPct: 100 });
    expect(rt.interact.craft.place(["minecraft:oak_log"]).ok).toBe(true);
    const out = rt.interact.craft.output();
    expect(out.ok && out.value?.id).toBe("minecraft:oak_planks");
    const took = rt.interact.craft.take();
    expect(took.ok && took.value).toBe(4);
  });
});
