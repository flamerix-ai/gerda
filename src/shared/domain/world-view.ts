// World-view — a voxel block-id cache that produces a BlockReader for the senses
// ("plan on cache, act on truth"). Pure + jsMacros-free: time is passed in as ticks
// (never Date — the kernel owns the clock), and the live block source is injected as a plain
// `fetch` closure, so this module never touches the runtime. The kernel binds it to
// rt.world.blockId and exposes it as a Ctx resource when the first consumer (reflexes /
// navigator) lands — that wiring is a later, live step; the cache itself is inert and tested.
import { encodePos } from "@/core/prim/pos";
import type { BlockReader } from "@/shared/domain/senses";

interface Entry {
  readonly id: string;
  readonly tick: number;
  /** Pinned = known-good (a block we just observed/mined and trust); never goes stale. */
  readonly pinned: boolean;
}

export interface WorldView {
  /** Record an observed block id at a tick (subject to TTL staleness). */
  set(x: number, y: number, z: number, id: string, tick: number): void;
  /** Record a block we trust indefinitely (e.g. a cell we just mined to air). */
  markKnownGood(x: number, y: number, z: number, id: string): void;
  /** Forget a cell (e.g. the world changed under us). */
  invalidate(x: number, y: number, z: number): void;
  /** Cached value ignoring staleness, or null if absent (diagnostics). */
  peek(x: number, y: number, z: number): string | null;
  /** A reader over ONLY the cache: returns null on a miss or a stale entry — never fetches. */
  reader(now: number, ttl: number): BlockReader;
  /** A reader that, on a miss/stale cell, calls `fetch` once and caches a non-null result.
   *  `fetch` returns null for an unreadable/unloaded voxel (which is NOT cached, NOT air). */
  cachingReader(
    fetch: (x: number, y: number, z: number) => string | null,
    now: number,
    ttl: number,
  ): BlockReader;
  /** Number of cached cells. */
  size(): number;
  /** Drop everything (e.g. on dimension change). */
  clear(): void;
}

/** Create an empty world-view cache. */
export function createWorldView(): WorldView {
  const cells = new Map<string, Entry>();
  const fresh = (e: Entry, now: number, ttl: number): boolean => e.pinned || now - e.tick <= ttl;

  const view: WorldView = {
    set(x, y, z, id, tick) {
      cells.set(encodePos(x, y, z), { id, tick, pinned: false });
    },
    markKnownGood(x, y, z, id) {
      cells.set(encodePos(x, y, z), { id, tick: 0, pinned: true });
    },
    invalidate(x, y, z) {
      cells.delete(encodePos(x, y, z));
    },
    peek(x, y, z) {
      return cells.get(encodePos(x, y, z))?.id ?? null;
    },
    reader(now, ttl) {
      return (x, y, z) => {
        const e = cells.get(encodePos(x, y, z));
        return e && fresh(e, now, ttl) ? e.id : null;
      };
    },
    cachingReader(fetch, now, ttl) {
      return (x, y, z) => {
        const key = encodePos(x, y, z);
        const e = cells.get(key);
        if (e && fresh(e, now, ttl)) return e.id;
        const id = fetch(x, y, z);
        if (id !== null) cells.set(key, { id, tick: now, pinned: false });
        return id;
      };
    },
    size() {
      return cells.size;
    },
    clear() {
      cells.clear();
    },
  };
  return view;
}
