import { type MiningMem, initMiningMem } from "@/bot/missions/mine/mining-mem";
import {
  isLowStock,
  lowStockGuard,
  stockOf,
  veinExhausted,
  veinExhaustedGuard,
  veinReading,
} from "@/bot/orchestrator/sensors";
import { makeGerdaConfig } from "@/bot/profile/config";
import type { Container, ItemStack } from "@/core/runtime/Runtime";
import { type Result, err, ok } from "@/core/runtime/types";
import type { Ctx } from "@/shared/kernel/capability";
import { describe, expect, it } from "vitest";

function stack(id: string, count: number): ItemStack {
  return { id, count, durabilityPct: 100 };
}

// A minimal Container: carry slots 0..n-1, optional storage at 100.. under a "chest" region.
function fakeContainer(
  carry: readonly (ItemStack | null)[],
  storage: readonly (ItemStack | null)[] = [],
): Container {
  const STORE_BASE = 100;
  return {
    regions: () => (storage.length > 0 ? ["hotbar", "main", "chest"] : ["hotbar", "main"]),
    slots: (...rs) => {
      if (rs.length === 0) return carry.map((_, i) => i); // no-arg = carry
      const out: number[] = [];
      if (rs.includes("chest")) out.push(...storage.map((_, i) => STORE_BASE + i));
      return out;
    },
    totalSlots: () => 46,
    slot: (i) => (i >= STORE_BASE ? (storage[i - STORE_BASE] ?? null) : (carry[i] ?? null)),
    selectedHotbar: () => 0,
    selectHotbar: () => {},
    quick: () => {},
    swap: () => {},
    dropSlot: () => {},
  };
}

// A fake Ctx carrying a controlled mining slice + an inventory result. Mirrors the lightweight
// resolver-ctx pattern in nav-engine.test.ts — these sensors are pure reads over Ctx.
function fakeCtx(opts: {
  mem?: Partial<MiningMem>;
  inv?: Result<Container>;
  cfg?: ReturnType<typeof makeGerdaConfig>;
}): Ctx {
  const mem = { ...initMiningMem(), ...opts.mem };
  return {
    cfg: opts.cfg ?? makeGerdaConfig(),
    slice: () => mem,
    rt: { inv: { open: () => opts.inv ?? err("no inv") } },
  } as unknown as Ctx;
}

describe("vein-exhaustion sensor", () => {
  it("a fresh / idle slice is NOT exhausted", () => {
    const r = veinReading(fakeCtx({}));
    expect(r.exhausted).toBe(false);
    expect(r.scanCycle).toBe(0);
    expect(r.maxCycles).toBe(makeGerdaConfig().scan.maxCycles);
  });

  it("exhausted once scanCycle hits cfg.scan.maxCycles with an empty queue in SPIRAL", () => {
    const cfg = makeGerdaConfig();
    const ctx = fakeCtx({ mem: { scanCycle: cfg.scan.maxCycles, mode: "SPIRAL", veinQueue: [] } });
    expect(veinExhausted(ctx)).toBe(true);
  });

  it("NOT exhausted while a local cluster is still queued, even at max cycles", () => {
    const cfg = makeGerdaConfig();
    const ctx = fakeCtx({
      // one cell still to mine → don't declare the vein dead
      mem: {
        scanCycle: cfg.scan.maxCycles,
        mode: "SPIRAL",
        veinQueue: [{ x: 0, y: 0, z: 0, id: "minecraft:iron_ore" }],
      },
    });
    expect(veinExhausted(ctx)).toBe(false);
  });

  it("NOT exhausted mid-vein (mode VEIN) regardless of cycle count", () => {
    const cfg = makeGerdaConfig();
    const ctx = fakeCtx({
      mem: { scanCycle: cfg.scan.maxCycles + 2, mode: "VEIN", veinQueue: [] },
    });
    expect(veinExhausted(ctx)).toBe(false);
  });

  it("the guard reports a reason while the vein is live", () => {
    const ok0 = veinExhaustedGuard().check(fakeCtx({}));
    expect(ok0.ok).toBe(false);
    if (!ok0.ok) expect(ok0.reason).toContain("vein live");
    const cfg = makeGerdaConfig();
    const done = veinExhaustedGuard().check(
      fakeCtx({ mem: { scanCycle: cfg.scan.maxCycles, mode: "SPIRAL", veinQueue: [] } }),
    );
    expect(done.ok).toBe(true);
  });
});

describe("stock sensor", () => {
  it("counts an item across the carry inventory", () => {
    const inv = fakeContainer([
      stack("minecraft:iron_ingot", 5),
      null,
      stack("minecraft:iron_ingot", 3),
    ]);
    expect(stockOf(fakeCtx({ inv: ok(inv) }), "minecraft:iron_ingot")).toBe(8);
  });

  it("returns 0 when no inventory is readable", () => {
    expect(stockOf(fakeCtx({}), "minecraft:iron_ingot")).toBe(0);
  });

  it("carry-only ignores storage unless includeStorage", () => {
    const inv = fakeContainer([stack("minecraft:coal", 2)], [stack("minecraft:coal", 64)]);
    const ctx = fakeCtx({ inv: ok(inv) });
    expect(stockOf(ctx, "minecraft:coal")).toBe(2); // carry only
    expect(stockOf(ctx, "minecraft:coal", { includeStorage: true })).toBe(66); // + chest
  });

  it("isLowStock / lowStockGuard fire below the threshold", () => {
    const inv = fakeContainer([stack("minecraft:torch", 4)]);
    const ctx = fakeCtx({ inv: ok(inv) });
    expect(isLowStock(ctx, "minecraft:torch", 16)).toBe(true);
    expect(isLowStock(ctx, "minecraft:torch", 4)).toBe(false); // exactly at threshold = not low

    const low = lowStockGuard("minecraft:torch", 16).check(ctx);
    expect(low.ok).toBe(true);
    const enough = lowStockGuard("minecraft:torch", 4).check(ctx);
    expect(enough.ok).toBe(false);
    if (!enough.ok) expect(enough.reason).toContain("≥");
  });
});
