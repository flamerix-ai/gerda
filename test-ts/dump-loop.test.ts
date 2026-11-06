import { core } from "@/bot/capabilities/core";
import { MINE_EDGES } from "@/bot/missions/mine";
import { homeReturn } from "@/bot/missions/mine/home-return";
import { inventory } from "@/bot/missions/mine/inventory";
import { storage } from "@/bot/missions/mine/storage";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import type { ItemStack } from "@/core/runtime/Runtime";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import { expectOk } from "@/core/runtime/types";
import { classify, fullness, hasContainerOpen, isJunk } from "@/shared/domain/inventory";
import { findBackupTool, strategyForTool, toolKind } from "@/shared/domain/tooling";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogSink, Logger } from "@/shared/kernel/logger";
import { describe, expect, it } from "vitest";

const sink: LogSink = { emit: () => {} };
const stack = (id: string): ItemStack => ({ id, count: 1, durabilityPct: 100 });

// These caps own the HOME/DUMP/RETURN handlers (mine-mission internal). The test
// drives phases directly, so it loads MINE_EDGES to make those transitions legal.
function dumpBot(): { rt: MockRuntime; kernel: Kernel; st: BotState } {
  const rt = createMockRuntime();
  const kernel = new Kernel(
    rt,
    new Logger(sink, "ERR"),
    new Bus(),
    makeGerdaConfig(),
    GERDA_PHASES,
    [MINE_EDGES],
  );
  kernel.register(core).register(inventory).register(homeReturn).register(storage);
  const st = makeInitialState();
  kernel.init(st);
  st.running = true;
  return { rt, kernel, st };
}

describe("tooling strategy", () => {
  it("classifies tools by id substring", () => {
    expect(toolKind("gtceu:iron_hammer")).toBe("hammer");
    expect(toolKind("gtceu:steel_drill")).toBe("drill");
    expect(toolKind("minecraft:diamond_pickaxe")).toBe("pickaxe");
    expect(toolKind(null)).toBe("none");
  });
  it("hammer → SIDE face-break, drill → CENTER bore, else → TOP", () => {
    expect(strategyForTool("gtceu:iron_hammer").breakTargetFace).toBe("SIDE");
    expect(strategyForTool("gtceu:steel_drill").breakTargetFace).toBe("CENTER");
    expect(strategyForTool("minecraft:diamond_pickaxe").breakTargetFace).toBe("TOP");
    expect(strategyForTool(null).breakTargetFace).toBe("TOP");
  });

  it("findBackupTool prefers same kind, then freshest; excludes worn/held/non-tools", () => {
    const tools = [
      { slot: 36, id: "gtceu:iron_drill", durabilityPct: 8 }, // worn, held
      { slot: 12, id: "gtceu:steel_drill", durabilityPct: 90 }, // fresh, same kind
      { slot: 13, id: "minecraft:diamond_pickaxe", durabilityPct: 95 }, // fresh, other kind
      { slot: 14, id: "minecraft:cobblestone", durabilityPct: 100 }, // not a tool
    ];
    expect(findBackupTool(tools, "drill", 36, 10)).toBe(12); // same kind wins
    expect(findBackupTool(tools, "hammer", 36, 10)).toBe(13); // no hammer → freshest tool
    // nothing above the floor → null (restock at home)
    expect(findBackupTool([tools[0] as (typeof tools)[number]], "drill", 36, 10)).toBeNull();
  });
});

describe("inventory domain", () => {
  const cfg = makeGerdaConfig();
  it("isJunk matches the configured junk list", () => {
    expect(isJunk("minecraft:cobblestone", cfg.inventory.junkItems)).toBe(true);
    expect(isJunk("gtceu:iron_ore", cfg.inventory.junkItems)).toBe(false);
  });
  it("classify splits ore vs junk by slot", () => {
    const { oreSlots, junkSlots } = classify(
      [
        { slot: 9, id: "gtceu:iron_ore" },
        { slot: 10, id: "minecraft:cobblestone" },
        { slot: 11, id: "minecraft:torch" },
      ],
      cfg,
    );
    expect(oreSlots).toEqual([9]);
    expect(junkSlots).toEqual([10]);
  });
  it("fullness is occupied/total, 0 when empty capacity", () => {
    expect(fullness(9, 36)).toBeCloseTo(0.25);
    expect(fullness(5, 0)).toBe(0);
  });
  it("hasContainerOpen ignores player-only regions", () => {
    expect(hasContainerOpen(["hotbar", "main"])).toBe(false);
    expect(hasContainerOpen(["hotbar", "main", "container"])).toBe(true);
  });
});

describe("dump round trip on the mock", () => {
  it("full bag → HOME → DUMP → RETURN → SCAN, ore deposited to chest", () => {
    const { rt, kernel, st } = dumpBot();
    // Fill main (9..35) + most of the hotbar with ore so fullness ≥ 0.85; leave
    // slot 36 (selected hotbar = held tool) as a pickaxe.
    rt.state.slots.set(36, stack("minecraft:diamond_pickaxe"));
    for (let i = 9; i <= 35; i++) rt.state.slots.set(i, stack("gtceu:iron_ore"));
    for (let i = 37; i <= 44; i++) rt.state.slots.set(i, stack("gtceu:iron_ore"));
    // Force into SCAN so the inventory guard is eligible (widened so TS doesn't
    // pin st.phase to the "SCAN" literal across the mutating tick loop).
    const scanSeed: BotState["phase"] = "SCAN";
    st.phase = scanSeed;
    st.running = true;

    // Open a chest screen during DUMP by widening the container's regions.
    const inv = expectOk(rt.inv.open(), "mock inv open");
    const realRegions = inv.regions;
    let chestOpen = false;
    inv.regions = () => (chestOpen ? [...realRegions(), "container"] : realRegions());

    const seen = new Set<string>();
    for (let i = 0; i < 600; i++) {
      kernel.tick(st);
      const phase: string = st.phase;
      seen.add(phase);
      if (phase === "DUMP") chestOpen = true; // chest is up while dumping
      if (phase === "SCAN" && seen.has("RETURN")) break; // completed a full trip
    }

    expect(seen.has("HOME")).toBe(true);
    expect(seen.has("DUMP")).toBe(true);
    expect(seen.has("RETURN")).toBe(true);
    // Everything was shift-clicked into the chest.
    let nonEmpty = 0;
    for (let i = 9; i <= 35; i++) if (rt.state.slots.get(i)) nonEmpty++;
    expect(nonEmpty).toBe(0);
  });

  it("junk is shed in the field without a home trip", () => {
    const { rt, kernel, st } = dumpBot();
    for (let i = 9; i <= 20; i++) rt.state.slots.set(i, stack("minecraft:cobblestone"));
    rt.state.slots.set(21, stack("gtceu:iron_ore"));
    const scanSeed: BotState["phase"] = "SCAN";
    st.phase = scanSeed;
    st.running = true;

    // One guard check fires at the 40-tick boundary.
    for (let i = 0; i < 41; i++) kernel.tick(st);

    // Cobble dropped, ore kept, still SCAN (not enough to warrant a dump).
    for (let i = 9; i <= 20; i++) expect(rt.state.slots.get(i)).toBeUndefined();
    expect(rt.state.slots.get(21)?.id).toBe("gtceu:iron_ore");
    expect(st.phase).toBe("SCAN");
  });
});
