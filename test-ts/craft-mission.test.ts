// craft mission — runs a recipe chain on the mock via MANUAL GRID PLACEMENT (the recipe-book
// API is dead on Monifactory). The mock "server" matches the placed grid's ingredient
// multiset against seeded recipes and fills craft_out; crafting is tick-driven (place →
// output → take). Verifies the chain consumes inputs, produces the output, and places +
// opens a table for the 3×3 final step. The real facade is verified live.
import { craftMission } from "@/bot/missions/craft";
import { describe, expect, it } from "vitest";
import { type BotHarness, countItem as count, makeBot } from "./harness";

function bot(): BotHarness {
  const h = makeBot({ missions: [craftMission] });
  // Vanilla early-game recipes for the default chest chain, keyed by ingredient multiset.
  h.rt.state.recipes.push(
    { ingredients: { "minecraft:oak_log": 1 }, output: { id: "minecraft:oak_planks", count: 4 } },
    {
      ingredients: { "minecraft:oak_planks": 4 },
      output: { id: "minecraft:crafting_table", count: 1 },
    },
    { ingredients: { "minecraft:oak_planks": 8 }, output: { id: "minecraft:chest", count: 1 } },
  );
  // A floor under the placement neighbors — PLACE_TABLE only targets a supported cell
  // (air with solid below), so the all-air mock default would leave nowhere to place.
  for (let x = -1; x <= 1; x++)
    for (let z = -1; z <= 1; z++) h.rt.state.blocks.set(`${x},63,${z}`, "minecraft:stone");
  return h;
}

describe("craft mission", () => {
  it("crafts a chest from logs: planks (2×2) → table (2×2) → place/open → chest (3×3)", () => {
    const { rt, kernel, st } = bot();
    rt.state.slots.set(10, { id: "minecraft:oak_log", count: 3, durabilityPct: 100 });

    kernel.startMission(st, "craft", {}); // default chain → chest
    expect(st.phase).toBe("CRAFT");

    for (let i = 0; i < 60 && kernel.activeMission() !== null; i++) kernel.tick(st);

    expect(count(rt, "minecraft:chest")).toBe(1);
    expect(count(rt, "minecraft:oak_planks")).toBe(0); // 12 made, 4 (table) + 8 (chest) consumed
    expect(count(rt, "minecraft:oak_log")).toBe(0); // 3 logs → 12 planks
    expect(rt.state.blocks.get("0,64,1")).toBe("minecraft:crafting_table"); // placed in front
    expect(rt.state.openScreen).toBeNull(); // table screen closed at the end
    expect(kernel.activeMission()).toBeNull();
    expect(st.phase).toBe("IDLE");
  });

  it("crafts a drawer via TWO consecutive 3×3 steps (chest → drawer), the live-broken case", () => {
    const { rt, kernel, st } = bot();
    // Drawer recipe needs a chest in the centre, itself a 3×3 craft — so the chain has two
    // 3×3 steps. The bug: only the LAST step opened the table, so the chest (a non-final 3×3)
    // stalled in the 2×2 player grid (gridSize 4 < 9) → PRE/PLACE timeout.
    rt.state.recipes.push({
      ingredients: { "minecraft:oak_planks": 8, "minecraft:chest": 1 },
      output: { id: "functionalstorage:oak_1", count: 1 },
    });
    rt.state.slots.set(10, { id: "minecraft:oak_log", count: 5, durabilityPct: 100 });

    const plank = "minecraft:oak_planks";
    const ring = [plank, plank, plank, plank, null, plank, plank, plank, plank];
    const drawer = [plank, plank, plank, plank, "minecraft:chest", plank, plank, plank, plank];
    kernel.startMission(st, "craft", {
      chain: [
        { grid: ["minecraft:oak_log"], times: 5 }, // 20 planks
        { grid: [plank, plank, plank, plank], times: 1 }, // table (4)
        { grid: ring, times: 1 }, // chest (8) — 3×3
        { grid: drawer, times: 1 }, // drawer (8 + chest) — 3×3
      ],
    });

    for (let i = 0; i < 120 && kernel.activeMission() !== null; i++) kernel.tick(st);

    expect(count(rt, "functionalstorage:oak_1")).toBe(1);
    expect(count(rt, "minecraft:chest")).toBe(0); // the crafted chest was consumed by the drawer
    expect(rt.state.openScreen).toBeNull();
    expect(st.phase).toBe("IDLE");
  });

  it("errors loudly when a required ingredient is missing", () => {
    const { kernel, st } = bot();
    // No logs → the first pre-craft (planks) has nothing to place.
    kernel.startMission(st, "craft", {});
    for (let i = 0; i < 20 && st.phase !== "ERROR"; i++) kernel.tick(st);
    expect(st.phase).toBe("ERROR");
  });

  it("crafts a single 3×3 item directly with a one-step chain", () => {
    const { rt, kernel, st } = bot();
    rt.state.slots.set(10, { id: "minecraft:oak_planks", count: 8, durabilityPct: 100 });
    rt.state.slots.set(11, { id: "minecraft:crafting_table", count: 1, durabilityPct: 100 });

    const chestGrid = [
      "minecraft:oak_planks",
      "minecraft:oak_planks",
      "minecraft:oak_planks",
      "minecraft:oak_planks",
      null,
      "minecraft:oak_planks",
      "minecraft:oak_planks",
      "minecraft:oak_planks",
      "minecraft:oak_planks",
    ];
    kernel.startMission(st, "craft", { chain: [{ grid: chestGrid, times: 1 }] });
    for (let i = 0; i < 40 && kernel.activeMission() !== null; i++) kernel.tick(st);

    expect(count(rt, "minecraft:chest")).toBe(1);
    expect(count(rt, "minecraft:oak_planks")).toBe(0);
    expect(st.phase).toBe("IDLE");
  });

  it("reuses an adjacent already-placed table instead of consuming one from the bag", () => {
    const { rt, kernel, st } = bot();
    rt.state.slots.set(10, { id: "minecraft:oak_planks", count: 8, durabilityPct: 100 });
    // A table left standing by a prior (failed) run — and NO table item in the bag: the old
    // blind-place path would ERROR "no crafting table to place" here.
    rt.state.blocks.set("0,64,1", "minecraft:crafting_table");

    const plank = "minecraft:oak_planks";
    const ring = [plank, plank, plank, plank, null, plank, plank, plank, plank];
    kernel.startMission(st, "craft", { chain: [{ grid: ring, times: 1 }] });
    for (let i = 0; i < 40 && kernel.activeMission() !== null; i++) kernel.tick(st);

    expect(count(rt, "minecraft:chest")).toBe(1);
    expect(st.phase).toBe("IDLE");
  });

  it("places the table on a SUPPORTED free cell, skipping occupied/floorless neighbors", () => {
    const { rt, kernel, st } = bot();
    rt.state.slots.set(10, { id: "minecraft:oak_planks", count: 8, durabilityPct: 100 });
    rt.state.slots.set(11, { id: "minecraft:crafting_table", count: 1, durabilityPct: 100 });
    // Front (+Z) is a hillside (the live t76 failure aimed INTO terrain); back (−Z) hangs
    // over a hole. The first supported free neighbor is +X.
    rt.state.blocks.set("0,64,1", "minecraft:dirt");
    rt.state.blocks.delete("0,63,-1");

    const plank = "minecraft:oak_planks";
    const ring = [plank, plank, plank, plank, null, plank, plank, plank, plank];
    kernel.startMission(st, "craft", { chain: [{ grid: ring, times: 1 }] });
    for (let i = 0; i < 40 && kernel.activeMission() !== null; i++) kernel.tick(st);

    expect(rt.state.blocks.get("1,64,0")).toBe("minecraft:crafting_table");
    expect(count(rt, "minecraft:chest")).toBe(1);
    expect(st.phase).toBe("IDLE");
  });

  it("boxed in a 1-deep pit, places the table on the RIM (the live stump-hole failure)", () => {
    const { rt, kernel, st } = bot();
    rt.state.slots.set(10, { id: "minecraft:oak_planks", count: 8, durabilityPct: 100 });
    rt.state.slots.set(11, { id: "minecraft:crafting_table", count: 1, durabilityPct: 100 });
    // Stump mining leaves the bot in a hole: every foot-level neighbor is solid terrain.
    for (const [x, z] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ])
      rt.state.blocks.set(`${x},64,${z}`, "minecraft:dirt");

    const plank = "minecraft:oak_planks";
    const ring = [plank, plank, plank, plank, null, plank, plank, plank, plank];
    kernel.startMission(st, "craft", { chain: [{ grid: ring, times: 1 }] });
    for (let i = 0; i < 40 && kernel.activeMission() !== null; i++) kernel.tick(st);

    expect(rt.state.blocks.get("0,65,1")).toBe("minecraft:crafting_table");
    expect(count(rt, "minecraft:chest")).toBe(1);
    expect(st.phase).toBe("IDLE");
  });

  // Conditional restock mode (#22): a `want` item turns craft into a SKIP-able top-up so the
  // unattended sustain loop never stalls or ERRORs on it. Iron-nugget recipe: 1 ingot → 9 nuggets.
  describe("conditional restock (want/min)", () => {
    const NUGGET = "minecraft:iron_nugget";
    const INGOT = "minecraft:iron_ingot";
    const nuggetChain = [{ grid: [INGOT], times: 1 }];
    function restockBot(): BotHarness {
      const h = makeBot({ missions: [craftMission] });
      h.rt.state.recipes.push({
        ingredients: { [INGOT]: 1 },
        output: { id: NUGGET, count: 9 },
      });
      return h;
    }

    it("no-ops when already carrying ≥min (no craft, completes immediately)", () => {
      const { rt, kernel, st } = restockBot();
      rt.state.slots.set(10, { id: NUGGET, count: 16, durabilityPct: 100 });
      rt.state.slots.set(11, { id: INGOT, count: 5, durabilityPct: 100 });
      kernel.startMission(st, "craft", { want: NUGGET, min: 16, chain: nuggetChain, table: false });
      for (let i = 0; i < 10 && kernel.activeMission() !== null; i++) kernel.tick(st);
      expect(count(rt, INGOT)).toBe(5); // untouched — nothing crafted
      expect(kernel.activeMission()).toBeNull();
      expect(st.phase).toBe("IDLE");
    });

    it("crafts when below min and the ingredients are present", () => {
      const { rt, kernel, st } = restockBot();
      rt.state.slots.set(10, { id: NUGGET, count: 2, durabilityPct: 100 });
      rt.state.slots.set(11, { id: INGOT, count: 5, durabilityPct: 100 });
      kernel.startMission(st, "craft", { want: NUGGET, min: 16, chain: nuggetChain, table: false });
      for (let i = 0; i < 20 && kernel.activeMission() !== null; i++) kernel.tick(st);
      expect(count(rt, NUGGET)).toBe(11); // 2 + 9 crafted
      expect(count(rt, INGOT)).toBe(4); // one ingot consumed
      expect(st.phase).toBe("IDLE");
    });

    it("skips (no ERROR) when below min but the ingredients are missing", () => {
      const { rt, kernel, st } = restockBot();
      rt.state.slots.set(10, { id: NUGGET, count: 0, durabilityPct: 100 }); // no nuggets, no ingots
      kernel.startMission(st, "craft", { want: NUGGET, min: 16, chain: nuggetChain, table: false });
      for (let i = 0; i < 10 && kernel.activeMission() !== null; i++) kernel.tick(st);
      expect(st.phase).toBe("IDLE"); // gracefully skipped, NOT ERROR (an unattended loop continues)
      expect(kernel.activeMission()).toBeNull();
    });

    it("skips (no ERROR) a 3×3 tool craft when no crafting table is carried (#23 skip-safety)", () => {
      const { rt, kernel, st } = restockBot();
      const PICK = "minecraft:iron_pickaxe";
      const pickGrid = [
        INGOT,
        INGOT,
        INGOT,
        null,
        "minecraft:stick",
        null,
        null,
        "minecraft:stick",
        null,
      ];
      rt.state.slots.set(10, { id: INGOT, count: 3, durabilityPct: 100 });
      rt.state.slots.set(11, { id: "minecraft:stick", count: 2, durabilityPct: 100 });
      // Ingredients present but NO crafting_table → PLACE_TABLE would ERROR; want-mode must skip.
      kernel.startMission(st, "craft", {
        want: PICK,
        min: 1,
        chain: [{ grid: pickGrid, times: 1 }],
      });
      for (let i = 0; i < 10 && kernel.activeMission() !== null; i++) kernel.tick(st);
      expect(st.phase).toBe("IDLE");
      expect(st.phase).not.toBe("ERROR");
      expect(count(rt, PICK)).toBe(0); // nothing crafted, no table consumed
    });
  });
});
