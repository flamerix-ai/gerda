// Shared entity-snapshot reader. Both Runtime impls turn a bridge-published entity
// snapshot into a distance-filtered (and optionally distance-sorted) list — items/mobs/peers/
// frames were the SAME loop copied ×4 in each of jsmacros.ts and mock.ts. This is the one home,
// so the filter/sort can't drift between real and mock (or across the four entity kinds).
//
// Pure: takes the raw payload (a JSON string in the real runtime, an already-parsed array in the
// mock) + the observer position + the reach, and uses pos.ts `dist` for the 3-D distance (never a
// hand-rolled Math.sqrt). An absent/blank payload → [] (pre-publish is not an error).
import { dist } from "@/core/prim/pos";
import type { Vec3 } from "@/core/runtime/types";

interface SnapshotOpts<T, R> {
  /** Transform each in-range record, receiving its computed distance (e.g. attach `distance`).
   *  Omitted → identity (the record passes through unchanged). */
  map: (item: T, distance: number) => R;
  /** Sort the results by ascending distance (nearest-first). */
  sort: boolean;
}

/** Parse `source` into a positioned-record array, keep the ones within `maxDist` of `self`, then
 *  optionally map + distance-sort. `source` is a JSON string (real: `globalThis.__MC_*`) or an
 *  already-parsed array (mock); anything else (absent global) reads as an empty list. */
export function readSnapshot<T extends Vec3, R = T>(
  source: unknown,
  self: Vec3,
  maxDist: number,
  opts: Partial<SnapshotOpts<T, R>> = {},
): R[] {
  let records: readonly T[];
  if (typeof source === "string") {
    // reliability-ok: bridge-published JSON is a positioned-record array by the snapshot contract
    records = source.length === 0 ? [] : (JSON.parse(source) as T[]);
  } else if (Array.isArray(source)) {
    // reliability-ok: the mock passes its own seeded T[] (compile-time typed at the call site)
    records = source as T[];
  } else {
    records = [];
  }

  const kept: { value: R; distance: number }[] = [];
  for (const rec of records) {
    const d = dist(self, rec);
    if (d > maxDist) continue;
    // No `map` ⇒ R defaults to T, so the record IS the result (identity passthrough); the cast
    // just re-expresses that default binding, which TS can't see through the generic.
    // reliability-ok: identity passthrough when `map` is omitted (R defaults to T)
    const value = opts.map ? opts.map(rec, d) : (rec as unknown as R);
    kept.push({ value, distance: d });
  }
  if (opts.sort) kept.sort((a, b) => a.distance - b.distance);
  return kept.map((k) => k.value);
}
