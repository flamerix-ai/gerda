// Pure senses over a synthetic voxel grid — no runtime. Locks the walkability /
// hazard / ground / raycast behaviour the navigator + reflexes will depend on.
import { encodePos } from "@/core/prim/pos";
import {
  type BlockReader,
  breakableSolid,
  groundUnder,
  hazardAt,
  isFullSolid,
  raycast,
  standableSurface,
  submergesAt,
  walkableAt,
} from "@/shared/domain/senses";
import { describe, expect, it } from "vitest";

/** Build a BlockReader from a sparse map; missing cells read as null (unknown), never air. */
function gridReader(cells: Record<string, string>): BlockReader {
  const m = new Map(Object.entries(cells));
  return (x, y, z) => m.get(encodePos(x, y, z)) ?? null;
}

const STONE = "minecraft:stone";

describe("breakableSolid", () => {
  it("true for an ordinary solid block; false for air / hazard / unmineable / unknown", () => {
    const r = gridReader({
      [encodePos(0, 0, 0)]: STONE,
      [encodePos(1, 0, 0)]: "minecraft:iron_ore",
      [encodePos(2, 0, 0)]: "minecraft:air",
      [encodePos(3, 0, 0)]: "minecraft:lava", // hazard
      [encodePos(4, 0, 0)]: "minecraft:bedrock", // unmineable
      [encodePos(5, 0, 0)]: "minecraft:water", // liquid (unmineable)
      [encodePos(6, 0, 0)]: "minecraft:short_grass", // walk-through decoration
    });
    expect(breakableSolid(r, { x: 0, y: 0, z: 0 })).toBe(true);
    expect(breakableSolid(r, { x: 1, y: 0, z: 0 })).toBe(true);
    expect(breakableSolid(r, { x: 2, y: 0, z: 0 })).toBe(false);
    expect(breakableSolid(r, { x: 3, y: 0, z: 0 })).toBe(false);
    expect(breakableSolid(r, { x: 4, y: 0, z: 0 })).toBe(false);
    expect(breakableSolid(r, { x: 5, y: 0, z: 0 })).toBe(false);
    expect(breakableSolid(r, { x: 6, y: 0, z: 0 })).toBe(false);
    expect(breakableSolid(r, { x: 9, y: 9, z: 9 })).toBe(false); // unknown
  });
});

describe("isFullSolid", () => {
  it("ordinary blocks solid; air/decoration/lava/cobweb not", () => {
    expect(isFullSolid(STONE)).toBe(true);
    expect(isFullSolid("minecraft:air")).toBe(false);
    expect(isFullSolid("minecraft:short_grass")).toBe(false);
    expect(isFullSolid("minecraft:lava")).toBe(false);
    expect(isFullSolid("minecraft:cobweb")).toBe(false);
    expect(isFullSolid("minecraft:oak_slab")).toBe(true); // standable special occupies
  });
});

describe("standableSurface", () => {
  const reader = gridReader({ [encodePos(0, 63, 0)]: STONE });
  it("true on solid, false on air, false on unknown", () => {
    expect(standableSurface(reader, { x: 0, y: 63, z: 0 })).toBe(true);
    expect(standableSurface(reader, { x: 0, y: 70, z: 0 })).toBe(false); // unknown
  });
});

describe("walkableAt", () => {
  it("true in a 2-high gap over a floor", () => {
    const reader = gridReader({
      [encodePos(0, 63, 0)]: STONE, // floor
      [encodePos(0, 64, 0)]: "minecraft:air",
      [encodePos(0, 65, 0)]: "minecraft:air",
    });
    expect(walkableAt(reader, { x: 0, y: 64, z: 0 })).toBe(true);
  });
  it("false with a blocked head or no floor", () => {
    const headBlocked = gridReader({
      [encodePos(0, 63, 0)]: STONE,
      [encodePos(0, 64, 0)]: "minecraft:air",
      [encodePos(0, 65, 0)]: STONE,
    });
    expect(walkableAt(headBlocked, { x: 0, y: 64, z: 0 })).toBe(false);
    const noFloor = gridReader({
      [encodePos(0, 64, 0)]: "minecraft:air",
      [encodePos(0, 65, 0)]: "minecraft:air",
    });
    expect(walkableAt(noFloor, { x: 0, y: 64, z: 0 })).toBe(false); // unknown below
  });
});

describe("hazardAt", () => {
  const reader = gridReader({
    [encodePos(0, 64, 0)]: "minecraft:lava",
    [encodePos(1, 64, 0)]: STONE,
  });
  it("flags lava, not stone, not unknown", () => {
    expect(hazardAt(reader, { x: 0, y: 64, z: 0 })).toBe(true);
    expect(hazardAt(reader, { x: 1, y: 64, z: 0 })).toBe(false);
    expect(hazardAt(reader, { x: 5, y: 64, z: 0 })).toBe(false);
  });
});

describe("submergesAt", () => {
  const WATER = "minecraft:water";
  it("flags over-the-head water (feet + head both water = drown trap)", () => {
    const r = gridReader({
      [encodePos(0, 64, 0)]: WATER, // feet
      [encodePos(0, 65, 0)]: WATER, // head
    });
    expect(submergesAt(r, { x: 0, y: 64, z: 0 })).toBe(true);
  });
  it("allows wading 1-deep water (feet water, head air)", () => {
    const r = gridReader({
      [encodePos(0, 64, 0)]: WATER, // feet
      [encodePos(0, 65, 0)]: "minecraft:air", // head clear
    });
    expect(submergesAt(r, { x: 0, y: 64, z: 0 })).toBe(false);
  });
  it("false when feet cell is not water", () => {
    const r = gridReader({
      [encodePos(0, 64, 0)]: "minecraft:air",
      [encodePos(0, 65, 0)]: WATER,
    });
    expect(submergesAt(r, { x: 0, y: 64, z: 0 })).toBe(false);
  });
  it("false for unknown cells (void/unknown vetoes own that)", () => {
    expect(submergesAt(gridReader({}), { x: 0, y: 64, z: 0 })).toBe(false);
  });
  it("treats flowing_water as water too", () => {
    const r = gridReader({
      [encodePos(0, 64, 0)]: "minecraft:flowing_water",
      [encodePos(0, 65, 0)]: "minecraft:flowing_water",
    });
    expect(submergesAt(r, { x: 0, y: 64, z: 0 })).toBe(true);
  });
});

describe("groundUnder", () => {
  it("reports the drop to the first standable below (0 = on it)", () => {
    const reader = gridReader({ [encodePos(0, 60, 0)]: STONE });
    // feet at y=64, ground at 60 → land with feet at 61 → 3-block fall
    expect(groundUnder(reader, { x: 0, y: 64, z: 0 }, 8)).toEqual({ y: 60, drop: 3 });
    // feet directly above floor → drop 0
    expect(groundUnder(reader, { x: 0, y: 61, z: 0 }, 8)).toEqual({ y: 60, drop: 0 });
  });
  it("null when nothing standable in range (void)", () => {
    expect(groundUnder(gridReader({}), { x: 0, y: 64, z: 0 }, 4)).toBeNull();
  });
});

describe("raycast (voxel DDA)", () => {
  const origin = { x: 0.5, y: 0.5, z: 0.5 };
  it("hits the first solid voxel along the ray", () => {
    const reader = gridReader({ [encodePos(5, 0, 0)]: STONE });
    const hit = raycast(reader, origin, { x: 1, y: 0, z: 0 }, 10);
    expect(hit?.pos).toEqual({ x: 5, y: 0, z: 0 });
    expect(hit?.dist).toBeCloseTo(4.5, 5);
  });
  it("returns null past maxDist", () => {
    const reader = gridReader({ [encodePos(5, 0, 0)]: STONE });
    expect(raycast(reader, origin, { x: 1, y: 0, z: 0 }, 3)).toBeNull();
  });
  it("passes through unknown and passable blocks, stops at the solid", () => {
    const reader = gridReader({
      [encodePos(2, 0, 0)]: "minecraft:short_grass", // passable
      [encodePos(5, 0, 0)]: STONE,
    });
    expect(raycast(reader, origin, { x: 1, y: 0, z: 0 }, 10)?.pos).toEqual({ x: 5, y: 0, z: 0 });
  });
});
