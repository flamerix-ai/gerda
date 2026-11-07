import { makeGerdaConfig } from "@/bot/profile/config";
import { ContractError } from "@/core/prim/invariant";
// Sane-default guards for the tunables the magic-number sweep moved into the schema
// SSOT. Not exhaustive — just the invariants a leaked literal would have silently broken.
import { DEFAULT_CONFIG, assertConfigOverrideKeys, makeConfig } from "@/shared/config/schema";
import { describe, expect, it } from "vitest";

describe("config defaults — nav sweep keys", () => {
  it("break/pillar/parkour tunables have the swept-in values", () => {
    expect(DEFAULT_CONFIG.nav.breakVerticalEps).toBe(0.35);
    expect(DEFAULT_CONFIG.nav.pillarMaxAttempts).toBe(3);
    expect(DEFAULT_CONFIG.nav.parkourFarEdge).toBe(0.7);
    expect(DEFAULT_CONFIG.nav.parkourMinCells).toBe(1.5);
  });

  it("the swept keys are sane (positive, in-range fractions)", () => {
    expect(DEFAULT_CONFIG.nav.breakVerticalEps).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.nav.breakVerticalEps).toBeLessThan(1);
    expect(DEFAULT_CONFIG.nav.parkourFarEdge).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.nav.parkourFarEdge).toBeLessThanOrEqual(1);
    expect(DEFAULT_CONFIG.nav.pillarMaxAttempts).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_CONFIG.nav.parkourMinCells).toBeGreaterThan(1); // must exceed a 1-cell adjacent step
  });

  it("makeConfig overrides a single key, keeping the rest", () => {
    const cfg = makeConfig({ nav: { pillarMaxAttempts: 5 } });
    expect(cfg.nav.pillarMaxAttempts).toBe(5);
    expect(cfg.nav.parkourFarEdge).toBe(DEFAULT_CONFIG.nav.parkourFarEdge);
  });
});

// Tier seam: no mod ids outside the bot tier. SHARED code (src/shared/config/schema.ts) must
// never name a mod id: `makeConfig()` yields a pack-NEUTRAL config, and every pack fact arrives
// via the BOT-tier profile (src/bot/profile/pack.ts) that `makeGerdaConfig()` layers on. A fork
// swaps that ONE file.
describe("pack tiering — shared defaults are pack-NEUTRAL", () => {
  it("makeConfig() carries no pack data", () => {
    const cfg = makeConfig();
    expect(cfg.ore.ids.size).toBe(0);
    expect(cfg.ore.minPickRank).toEqual({});
    expect(cfg.containerKinds).toEqual([]);
    expect(cfg.nav.fillerBlocks).toEqual([]);
    expect(cfg.chop.logIds.size).toBe(0);
    expect(cfg.inventory.junkItems).toEqual([]);
    expect(cfg.safety.foodItems).toEqual([]);
    expect(cfg.hunt.targets).toEqual([]);
    expect(cfg.craft.defaultChain).toEqual([]);
    expect(cfg.sustain.oreItem).toBe("");
    expect(cfg.homeCommand).toBe("");
  });

  it("no shared default mentions a mod/item id", () => {
    // The whole point of the tier: grep the neutral config for a namespaced id and find nothing.
    const serialized = JSON.stringify(makeConfig(), (_k, v) => (v instanceof Set ? [...v] : v));
    expect(serialized).not.toMatch(/minecraft:|gtceu:|functionalstorage:/);
  });

  it("makeGerdaConfig() carries the pack — and keeps the shared tunables", () => {
    const cfg = makeGerdaConfig();
    expect(cfg.ore.ids.size).toBeGreaterThan(0);
    expect(cfg.containerKinds.some((r) => r.match === "functionalstorage:")).toBe(true);
    expect(cfg.nav.fillerBlocks).toContain("minecraft:cobblestone");
    expect(cfg.safety.waterBucketId).toBe("minecraft:water_bucket");
    expect(cfg.homeCommand).toBe("/home base");
    // pack-neutral tunables untouched by the pack layer
    expect(cfg.nav.parkourFarEdge).toBe(DEFAULT_CONFIG.nav.parkourFarEdge);
  });

  it("a caller layer wins over the pack layer, per key", () => {
    const cfg = makeGerdaConfig({ homeCommand: "/spawn", sustain: { oreItem: "x:ore" } });
    expect(cfg.homeCommand).toBe("/spawn");
    expect(cfg.sustain.oreItem).toBe("x:ore");
    expect(cfg.sustain.ingotItem).toBe("minecraft:iron_ingot"); // pack sibling survives
  });
});

// The regression the VARIADIC signature exists to prevent: two layers touching DIFFERENT keys of
// the SAME section must BOTH survive. Flattening the layers into one blob first (a top-level
// spread) would let the later layer's section replace the earlier one wholesale.
describe("makeConfig — cumulative per-section layering", () => {
  it("two layers on the same section both survive", () => {
    const cfg = makeConfig({ nav: { sprint: false } }, { nav: { pillarMaxAttempts: 9 } });
    expect(cfg.nav.sprint).toBe(false);
    expect(cfg.nav.pillarMaxAttempts).toBe(9);
    expect(cfg.nav.parkourFarEdge).toBe(DEFAULT_CONFIG.nav.parkourFarEdge); // defaults kept too
  });

  it("the later layer wins on a key both set", () => {
    const cfg = makeConfig({ nav: { pillarMaxAttempts: 5 } }, { nav: { pillarMaxAttempts: 7 } });
    expect(cfg.nav.pillarMaxAttempts).toBe(7);
  });

  it("the pack layer's ore.ids survives a later layer touching ore.minPickRank", () => {
    const cfg = makeGerdaConfig({ ore: { minPickRank: { naquadah: 4 } } });
    expect(cfg.ore.ids.size).toBeGreaterThan(0);
    expect(cfg.ore.minPickRank).toEqual({ naquadah: 4 });
  });
});

describe("assertConfigOverrideKeys — build-time override gate", () => {
  it("accepts a valid deep-partial and passes it through to makeConfig", () => {
    const ov = assertConfigOverrideKeys({ nav: { sprint: false } });
    const cfg = makeConfig(ov);
    expect(cfg.nav.sprint).toBe(false);
    expect(cfg.nav.parkour).toBe(DEFAULT_CONFIG.nav.parkour); // siblings kept
  });

  it("accepts an empty object (the absent-file default)", () => {
    expect(assertConfigOverrideKeys({})).toEqual({});
  });

  it("throws NAMING an unknown top-level key", () => {
    expect(() => assertConfigOverrideKeys({ nav: { sprint: false }, nvaigation: {} })).toThrow(
      ContractError,
    );
    expect(() => assertConfigOverrideKeys({ nvaigation: {} })).toThrow(/nvaigation/);
  });

  it("names the source in the error", () => {
    expect(() => assertConfigOverrideKeys({ bogus: 1 }, "config/local.overrides.json")).toThrow(
      /config\/local\.overrides\.json/,
    );
  });

  it("throws on non-object input (array, null, primitive)", () => {
    expect(() => assertConfigOverrideKeys([])).toThrow(ContractError);
    expect(() => assertConfigOverrideKeys(null)).toThrow(ContractError);
    expect(() => assertConfigOverrideKeys(42)).toThrow(/expected a JSON object/);
    expect(() => assertConfigOverrideKeys("nav")).toThrow(ContractError);
  });
});
