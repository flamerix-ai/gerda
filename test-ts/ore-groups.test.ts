// ore-groups — the drill's ore-intent → block-id predicate. A drill sent for "gold" must mine only
// gold and ignore the copper/iron it grazes; GTCEu veins scatter several materials under one intent
// (galena = silver+lead) whose block ids don't all contain the intent word, so the alias table has to
// cover them while the plain-substring fallback handles the obvious cases.
import { oreMatchesGroup } from "@/shared/domain/ore-groups";
import { describe, expect, it } from "vitest";

describe("oreMatchesGroup — substring groups (intent is in the id)", () => {
  it("matches gold across raw/deepslate/plain forms", () => {
    expect(oreMatchesGroup("gtceu:gold_ore", "gold")).toBe(true);
    expect(oreMatchesGroup("gtceu:deepslate_gold_ore", "gold")).toBe(true);
    expect(oreMatchesGroup("minecraft:raw_gold", "gold")).toBe(true);
  });

  it("rejects a different ore for a substring group", () => {
    expect(oreMatchesGroup("gtceu:copper_ore", "gold")).toBe(false);
    expect(oreMatchesGroup("gtceu:magnetite_ore", "gold")).toBe(false);
  });

  it("is case-insensitive on the intent", () => {
    expect(oreMatchesGroup("gtceu:gold_ore", "GOLD")).toBe(true);
    expect(oreMatchesGroup("gtceu:gold_ore", " Gold ")).toBe(true);
  });
});

describe("oreMatchesGroup — alias groups (intent word not in the id)", () => {
  it("iron matches its GTCEu member minerals", () => {
    for (const id of [
      "gtceu:magnetite_ore",
      "gtceu:deepslate_hematite_ore",
      "gtceu:limonite_ore",
      "gtceu:yellow_limonite_ore",
    ]) {
      expect(oreMatchesGroup(id, "iron")).toBe(true);
    }
    // plain minecraft iron still matches (substring of the member 'iron'? no — via fallback)
    expect(oreMatchesGroup("minecraft:iron_ore", "iron")).toBe(true);
  });

  it("galena counts as BOTH silver and lead (shared vein)", () => {
    expect(oreMatchesGroup("gtceu:galena_ore", "silver")).toBe(true);
    expect(oreMatchesGroup("gtceu:galena_ore", "lead")).toBe(true);
  });

  it("an alias group rejects an unrelated ore", () => {
    expect(oreMatchesGroup("gtceu:gold_ore", "iron")).toBe(false);
    expect(oreMatchesGroup("gtceu:cassiterite_ore", "iron")).toBe(false);
  });

  it("tin matches cassiterite; zinc matches sphalerite", () => {
    expect(oreMatchesGroup("gtceu:cassiterite_ore", "tin")).toBe(true);
    expect(oreMatchesGroup("gtceu:sphalerite_ore", "zinc")).toBe(true);
  });
});

describe("oreMatchesGroup — empty intent", () => {
  it("an empty/whitespace group matches anything (no constraint)", () => {
    expect(oreMatchesGroup("gtceu:gold_ore", "")).toBe(true);
    expect(oreMatchesGroup("gtceu:anything_ore", "   ")).toBe(true);
  });
});
