// World-view cache — pure, tick-driven. Verifies TTL staleness, pinned
// known-good, invalidation, and the caching reader's fetch-once-then-serve behaviour.
import { createWorldView } from "@/shared/domain/world-view";
import { describe, expect, it } from "vitest";

const STONE = "minecraft:stone";

describe("WorldView cache", () => {
  it("reader serves a fresh entry and null on miss", () => {
    const v = createWorldView();
    v.set(1, 2, 3, STONE, 100);
    expect(v.reader(100, 40)(1, 2, 3)).toBe(STONE);
    expect(v.reader(100, 40)(9, 9, 9)).toBeNull();
  });

  it("entries go stale past the TTL", () => {
    const v = createWorldView();
    v.set(0, 0, 0, STONE, 100);
    expect(v.reader(130, 40)(0, 0, 0)).toBe(STONE); // 30 ≤ 40 ttl
    expect(v.reader(141, 40)(0, 0, 0)).toBeNull(); // 41 > 40 ttl
  });

  it("known-good is pinned and never goes stale", () => {
    const v = createWorldView();
    v.markKnownGood(5, 5, 5, "minecraft:air");
    expect(v.reader(999999, 1)(5, 5, 5)).toBe("minecraft:air");
  });

  it("invalidate forgets a cell; clear drops all", () => {
    const v = createWorldView();
    v.set(1, 1, 1, STONE, 0);
    v.invalidate(1, 1, 1);
    expect(v.peek(1, 1, 1)).toBeNull();
    v.set(2, 2, 2, STONE, 0);
    expect(v.size()).toBe(1);
    v.clear();
    expect(v.size()).toBe(0);
  });

  it("cachingReader fetches once on miss, then serves from cache", () => {
    const v = createWorldView();
    let fetches = 0;
    const fetch = (x: number, _y: number, _z: number): string | null => {
      fetches++;
      return x === 7 ? STONE : null;
    };
    const read = v.cachingReader(fetch, 50, 40);
    expect(read(7, 0, 0)).toBe(STONE);
    expect(read(7, 0, 0)).toBe(STONE); // served from cache now
    expect(fetches).toBe(1);
    expect(v.size()).toBe(1);
  });

  it("cachingReader does NOT cache a null (unloaded) fetch", () => {
    const v = createWorldView();
    let fetches = 0;
    const read = v.cachingReader(
      () => {
        fetches++;
        return null;
      },
      50,
      40,
    );
    expect(read(0, 0, 0)).toBeNull();
    expect(read(0, 0, 0)).toBeNull();
    expect(fetches).toBe(2); // re-fetched, since null was never cached
    expect(v.size()).toBe(0);
  });
});
