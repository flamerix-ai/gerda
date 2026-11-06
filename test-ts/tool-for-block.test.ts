import { warnIfMissingTool } from "@/bot/missions/tool-check";
import { makeGerdaConfig } from "@/bot/profile/config";
import { createMockRuntime } from "@/core/runtime/mock";
// Tool-aware breaking ("sand with a shovel, wood with an axe, not a pickaxe") — the block→tool-class
// classifier, the tier ladder, and ensureToolFor's equip-the-right-tool behaviour on the mock.
import { oreMinPickRank, toolClassForBlock, toolTierRank } from "@/shared/domain/tooling";
import { ensureToolFor, heldStack } from "@/shared/held";
import { describe, expect, it } from "vitest";

const stack = (id: string, durabilityPct = 100) => ({ id, count: 1, durabilityPct });

// Ore harvest tiers are PACK data (tier seam: no mod ids outside the bot tier) — assert against the pack-loaded config.
const PACK_CFG = makeGerdaConfig();

describe("toolClassForBlock", () => {
  it("wood family → axe", () => {
    expect(toolClassForBlock("minecraft:oak_log")).toBe("axe");
    expect(toolClassForBlock("minecraft:stripped_spruce_wood")).toBe("axe");
    expect(toolClassForBlock("minecraft:birch_planks")).toBe("axe");
    expect(toolClassForBlock("minecraft:warped_stem")).toBe("axe");
  });

  it("granular ground → shovel (but sandSTONE stays pickaxe)", () => {
    expect(toolClassForBlock("minecraft:sand")).toBe("shovel");
    expect(toolClassForBlock("minecraft:gravel")).toBe("shovel");
    expect(toolClassForBlock("minecraft:dirt")).toBe("shovel");
    expect(toolClassForBlock("minecraft:grass_block")).toBe("shovel");
    expect(toolClassForBlock("minecraft:soul_sand")).toBe("shovel");
    expect(toolClassForBlock("minecraft:sandstone")).toBe("pickaxe");
    expect(toolClassForBlock("minecraft:red_sandstone")).toBe("pickaxe");
  });

  it("stone/ore family → pickaxe (vanilla + GTCEu ids)", () => {
    expect(toolClassForBlock("minecraft:stone")).toBe("pickaxe");
    expect(toolClassForBlock("minecraft:deepslate")).toBe("pickaxe");
    expect(toolClassForBlock("minecraft:iron_ore")).toBe("pickaxe");
    expect(toolClassForBlock("gtceu:deepslate_silver_ore")).toBe("pickaxe");
    expect(toolClassForBlock("minecraft:stone_bricks")).toBe("pickaxe");
  });

  it("plants/unknown → none (any tool / hand)", () => {
    expect(toolClassForBlock("minecraft:short_grass")).toBe("none");
    expect(toolClassForBlock("minecraft:oak_leaves")).toBe("none");
    expect(toolClassForBlock(null)).toBe("none");
  });
});

describe("tier ladder (not every ore breaks with any pickaxe)", () => {
  it("ranks tools by material", () => {
    expect(toolTierRank("minecraft:wooden_pickaxe")).toBe(0);
    expect(toolTierRank("minecraft:stone_pickaxe")).toBe(1);
    expect(toolTierRank("minecraft:iron_pickaxe")).toBe(2);
    expect(toolTierRank("minecraft:diamond_pickaxe")).toBe(3);
    expect(toolTierRank("gtceu:diamond_mining_hammer")).toBe(3);
  });

  it("ore groups demand their harvest rank (against the PACK-loaded table)", () => {
    const ranks = PACK_CFG.ore.minPickRank;
    // coal is 0 (wooden pick) in the LIVE group_ranks — the merged table is the production truth
    // every call site already passed; the old default-parameter form saw only the fallback ladder,
    // where coal is absent → 1. Same shipped behaviour, honest expectation.
    expect(oreMinPickRank("coal", ranks)).toBe(0);
    expect(oreMinPickRank("iron", ranks)).toBe(1);
    expect(oreMinPickRank("diamond", ranks)).toBe(2);
    expect(oreMinPickRank("gold", ranks)).toBe(2);
    expect(oreMinPickRank("silver", ranks)).toBe(2);
    expect(oreMinPickRank(undefined, ranks)).toBe(1);
  });

  it("a live-derived table (cfg.ore.minPickRank) overrides the static fallback", () => {
    const derived = { naquadah: 4, iron: 2 }; // mod ore + a pack that re-tiers iron
    expect(oreMinPickRank("naquadah", derived)).toBe(4);
    expect(oreMinPickRank("iron", derived)).toBe(2);
    expect(oreMinPickRank("unlisted", derived)).toBe(1); // absent everywhere → stone tier
  });

  it("suffix-walks pruned variant names (deepslate_gold resolves via gold)", () => {
    const derived = { gold: 2, nether_gold: 1 }; // generator keeps a longer name only when it differs
    expect(oreMinPickRank("deepslate_gold", derived)).toBe(2); // pruned → suffix chain
    expect(oreMinPickRank("nether_gold", derived)).toBe(1); // kept — genuinely different
  });

  it("the PACK-loaded config carries the merged live+fallback group-rank table", () => {
    // Static fallback groups are always present, whatever the generated data adds. The SHARED
    // defaults carry none of this — the table comes from src/bot/profile/pack.ts.
    expect(oreMinPickRank("gold", PACK_CFG.ore.minPickRank)).toBeGreaterThanOrEqual(2);
  });
});

describe("ensureToolFor (equip the RIGHT tool for the block)", () => {
  it("swaps a held pickaxe for the axe when the target is a log", () => {
    const rt = createMockRuntime();
    rt.state.hotbar = 0;
    rt.state.slots.set(36, stack("minecraft:diamond_pickaxe")); // held
    rt.state.slots.set(37, stack("minecraft:diamond_axe"));
    expect(ensureToolFor(rt, "minecraft:oak_log")).toBe(true);
    expect(heldStack(rt)?.id).toBe("minecraft:diamond_axe");
  });

  it("swaps a held axe for the shovel when the target is sand", () => {
    const rt = createMockRuntime();
    rt.state.hotbar = 0;
    rt.state.slots.set(36, stack("minecraft:diamond_axe")); // held
    rt.state.slots.set(38, stack("minecraft:diamond_shovel"));
    expect(ensureToolFor(rt, "minecraft:sand")).toBe(true);
    expect(heldStack(rt)?.id).toBe("minecraft:diamond_shovel");
  });

  it("keeps the held pickaxe on stone (already the right class)", () => {
    const rt = createMockRuntime();
    rt.state.hotbar = 0;
    rt.state.slots.set(36, stack("minecraft:diamond_pickaxe")); // held
    rt.state.slots.set(37, stack("minecraft:diamond_shovel"));
    expect(ensureToolFor(rt, "minecraft:stone")).toBe(true);
    expect(heldStack(rt)?.id).toBe("minecraft:diamond_pickaxe");
  });

  it("a GTCEu hammer satisfies the pickaxe class (family, not exact kind)", () => {
    const rt = createMockRuntime();
    rt.state.hotbar = 0;
    rt.state.slots.set(36, stack("gtceu:diamond_mining_hammer")); // held
    rt.state.slots.set(37, stack("minecraft:diamond_pickaxe"));
    expect(ensureToolFor(rt, "gtceu:silver_ore")).toBe(true);
    expect(heldStack(rt)?.id).toBe("gtceu:diamond_mining_hammer"); // respected — no churn
  });

  it("class missing from the bag → degrades to any-mining-tool (no bare fist)", () => {
    const rt = createMockRuntime();
    rt.state.hotbar = 0;
    rt.state.slots.set(36, stack("gtceu:prospector.hv")); // held non-tool
    rt.state.slots.set(37, stack("minecraft:diamond_pickaxe")); // no shovel anywhere
    expect(ensureToolFor(rt, "minecraft:dirt")).toBe(true);
    expect(heldStack(rt)?.id).toBe("minecraft:diamond_pickaxe");
  });

  it("'none'-class target keeps the old contract (held real tool respected)", () => {
    const rt = createMockRuntime();
    rt.state.hotbar = 0;
    rt.state.slots.set(36, stack("minecraft:diamond_axe")); // held
    rt.state.slots.set(37, stack("minecraft:diamond_pickaxe"));
    expect(ensureToolFor(rt, "minecraft:oak_leaves")).toBe(true);
    expect(heldStack(rt)?.id).toBe("minecraft:diamond_axe");
  });
});

describe("warnIfMissingTool (pre-flight warning)", () => {
  function checkedCtx(rt: ReturnType<typeof createMockRuntime>) {
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    const ctx = {
      rt,
      st: { tickCount: 7 },
      cfg: PACK_CFG,
      log: {
        warn: (_t: number, event: string, fields: Record<string, unknown>) =>
          events.push({ event, fields }),
      },
    } as unknown as Parameters<typeof warnIfMissingTool>[0];
    return { ctx, events };
  }

  it("no axe in the bag → MISSION_TOOL_MISSING", () => {
    const rt = createMockRuntime();
    rt.state.slots.set(36, stack("minecraft:diamond_pickaxe"));
    const { ctx, events } = checkedCtx(rt);
    warnIfMissingTool(ctx, "axe");
    expect(events.map((e) => e.event)).toEqual(["MISSION_TOOL_MISSING"]);
  });

  it("axe present → silent", () => {
    const rt = createMockRuntime();
    rt.state.slots.set(36, stack("minecraft:diamond_axe"));
    const { ctx, events } = checkedCtx(rt);
    warnIfMissingTool(ctx, "axe");
    expect(events).toEqual([]);
  });

  it("only a stone pickaxe vs a diamond drill order → MISSION_TOOL_TIER", () => {
    const rt = createMockRuntime();
    rt.state.slots.set(36, stack("minecraft:stone_pickaxe"));
    const { ctx, events } = checkedCtx(rt);
    warnIfMissingTool(ctx, "pickaxe", { ore: "diamond" });
    expect(events.map((e) => e.event)).toEqual(["MISSION_TOOL_TIER"]);
  });

  it("iron pickaxe covers gold/silver — silent", () => {
    const rt = createMockRuntime();
    rt.state.slots.set(36, stack("minecraft:iron_pickaxe"));
    const { ctx, events } = checkedCtx(rt);
    warnIfMissingTool(ctx, "pickaxe", { ore: "silver" });
    expect(events).toEqual([]);
  });
});
