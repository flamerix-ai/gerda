// Storage-network domain (@/shared/domain/storage): category heuristic, routing priority
// (type-match → category → empty, nearest within a tier), and drawer slot quadrant
// geometry (the X_2 points match the live drawer_deposit probe). Pure — no runtime.
// (Distinct from storage.test.ts, which covers the mine-mission DUMP capability.)
import {
  type StorageState,
  type StoredItem,
  categoryOf,
  drawerQuadrantPoint,
  pickStorageTarget,
  planDeposits,
} from "@/shared/domain/storage";
import { describe, expect, it } from "vitest";

const drawer = (x: number, z: number, slots: (StoredItem | null)[]): StorageState => ({
  marker: { kind: "drawer", x, y: 101, z, facing: "west" },
  slots,
});
const chest = (x: number, z: number, slots: (StoredItem | null)[]): StorageState => ({
  marker: { kind: "chest", x, y: 101, z },
  slots,
});
const item = (id: string, count = 1): StoredItem => ({ id, count });
const IRON = "minecraft:raw_iron";
const COPPER = "minecraft:raw_copper";
const COAL = "minecraft:coal";
const FROM = { x: 0, y: 101, z: 0 };

describe("categoryOf", () => {
  it("buckets the ore economy by substring", () => {
    expect(categoryOf("minecraft:raw_iron")).toBe("ore");
    expect(categoryOf("minecraft:iron_ore")).toBe("ore");
    expect(categoryOf("gtceu:deepslate_iron_ore")).toBe("ore");
    expect(categoryOf("minecraft:iron_ingot")).toBe("ingot");
    expect(categoryOf("gtceu:iron_dust")).toBe("dust");
    expect(categoryOf("minecraft:coal")).toBe("fuel");
    expect(categoryOf("minecraft:oak_log")).toBe("wood");
    expect(categoryOf("minecraft:diamond")).toBe("gem");
    expect(categoryOf("minecraft:cobblestone")).toBe("misc");
  });
});

describe("pickStorageTarget", () => {
  it("prefers an exact type-match over an empty drawer", () => {
    const states = [
      drawer(2, 0, [item(IRON, 10), null]), // already homes raw_iron in slot 0
      drawer(1, 0, [null, null]), // closer + empty, but no affinity
    ];
    const t = pickStorageTarget(IRON, states, FROM);
    expect(t).toMatchObject({ marker: { x: 2 }, slot: 0, reason: "type-match" });
  });

  it("falls back to a same-category container before a bare-empty one", () => {
    const states = [
      drawer(5, 0, [item(COPPER, 4), null]), // ore neighbour (copper) + an empty slot
      drawer(1, 0, [item("minecraft:oak_log", 8), null]), // closer, but wood — different category
    ];
    const t = pickStorageTarget(IRON, states, FROM);
    expect(t).toMatchObject({ marker: { x: 5 }, reason: "category" });
    expect(t?.slot).toBe(1); // the empty drawer slot it assigns
  });

  it("uses a bare empty slot when there is no type or category affinity", () => {
    const states = [drawer(3, 0, [item("minecraft:stick", 1), null])];
    const t = pickStorageTarget(IRON, states, FROM);
    expect(t).toMatchObject({ reason: "empty", slot: 1 });
  });

  it("picks the nearest within the same affinity tier", () => {
    const states = [
      drawer(9, 0, [item(IRON, 5), null]),
      drawer(3, 0, [item(IRON, 5), null]), // nearer type-match
    ];
    expect(pickStorageTarget(IRON, states, FROM)?.marker.x).toBe(3);
  });

  it("routes a chest type-match with slot -1 (shift-click finds the slot)", () => {
    const states = [chest(4, 0, [item(IRON, 30), null, null])];
    const t = pickStorageTarget(IRON, states, FROM);
    expect(t).toMatchObject({ reason: "type-match", slot: -1, marker: { kind: "chest" } });
  });

  it("skips a drawer with no matching and no empty slot", () => {
    const states = [drawer(2, 0, [item(COPPER, 5), item(COAL, 5)])]; // both slots typed to others
    expect(pickStorageTarget(IRON, states, FROM)).toBeNull();
  });

  it("skips a chest that is full (no room, no empty)", () => {
    const full: StoredItem[] = Array.from({ length: 3 }, () => item(COPPER, 64));
    expect(pickStorageTarget(IRON, [chest(2, 0, full)], FROM)).toBeNull();
  });

  it("returns null when there are no storages", () => {
    expect(pickStorageTarget(IRON, [], FROM)).toBeNull();
  });
});

describe("planDeposits", () => {
  it("routes two NEW types to DISTINCT empty drawer slots (no collision)", () => {
    const states = [drawer(2, 0, [null, null])];
    const plan = planDeposits([item(IRON, 5), item(COPPER, 5)], states, FROM);
    expect(plan.unplaced).toEqual([]);
    expect(plan.legs.map((l) => l.slot)).toEqual([0, 1]); // different slots, not both 0
    expect(plan.legs.map((l) => l.itemId)).toEqual([IRON, COPPER]);
  });

  it("merges two stacks of the SAME new type into one drawer slot", () => {
    const states = [drawer(2, 0, [null, null])];
    const plan = planDeposits([item(IRON, 5), item(IRON, 5)], states, FROM);
    expect(plan.legs.map((l) => l.slot)).toEqual([0, 0]); // both into the slot it just claimed
    expect(plan.legs[1]?.reason).toBe("type-match"); // the 2nd sees the 1st's assignment
  });

  it("overflows a third new type to a second drawer when the first is full", () => {
    const states = [drawer(2, 0, [null, null]), drawer(6, 0, [null, null])];
    const plan = planDeposits([item(IRON, 1), item(COPPER, 1), item(COAL, 1)], states, FROM);
    expect(plan.unplaced).toEqual([]);
    const byItem = Object.fromEntries(plan.legs.map((l) => [l.itemId, l.marker.x]));
    expect(byItem[COAL]).toBe(6); // first drawer's 2 slots taken → spills to the second
  });

  it("reports items the full network can't take as unplaced", () => {
    const states = [drawer(2, 0, [item(COPPER, 5), item(COAL, 5)])]; // both slots typed away
    const plan = planDeposits([item(IRON, 5)], states, FROM);
    expect(plan.legs).toEqual([]);
    expect(plan.unplaced).toEqual([IRON]);
  });
});

describe("drawerQuadrantPoint", () => {
  const block = { x: 2, y: 101, z: 0 };

  it("matches the live X_2 west probe points (lower=slot0, upper=slot1)", () => {
    expect(drawerQuadrantPoint(block, 2, "west", 0)).toEqual({ x: 2.03, y: 101.25, z: 0.5 });
    expect(drawerQuadrantPoint(block, 2, "west", 1)).toEqual({ x: 2.03, y: 101.75, z: 0.5 });
  });

  it("gives X_4 four distinct quadrants (one aim-point per slot, no collision)", () => {
    const pts = [0, 1, 2, 3].map((s) => drawerQuadrantPoint(block, 4, "west", s));
    const keys = new Set(pts.map((p) => `${p.x},${p.y},${p.z}`));
    expect(keys.size).toBe(4);
  });

  it("X_1 aims at the face centre regardless of slot index", () => {
    expect(drawerQuadrantPoint(block, 1, "north", 0)).toEqual({ x: 2.5, y: 101.5, z: 0.03 });
  });
});
