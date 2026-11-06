// Coverage for the multi-writer compare-and-swap — the pure conflict-resolution loop that
// keeps two concurrent updates to mc_world.json from clobbering each other (the lost-update bug). Also
// asserts the WorldModel `seq` stamp survives normalize/putSection so the CAS can detect a conflict.
import { emptyModel, getSection, normalizeModel, putSection } from "@/shared/domain/world-model";
import { type CasStore, casUpdate } from "@/shared/harness/world-cas";
import { describe, expect, it } from "vitest";

// A fake in-memory versioned store standing in for the atomic-rename+seq file. `inject` fires once,
// simulating ANOTHER writer committing between our read and our commit (the race the CAS defeats).
function fakeStore(
  initial: string[],
  inject?: (disk: { seq: number; value: string[] }) => void,
): { store: CasStore<string[]>; disk: () => { seq: number; value: string[] } } {
  let disk = { seq: 0, value: [...initial] };
  let injected = false;
  const store: CasStore<string[]> = {
    read: () => ({ seq: disk.seq, value: [...disk.value] }),
    commit: (value, nextSeq, expectedSeq) => {
      if (inject && !injected) {
        injected = true;
        inject(disk);
      }
      if (expectedSeq !== null && disk.seq !== expectedSeq) return false; // CAS conflict → retry
      disk = { seq: nextSeq, value: [...value] };
      return true;
    },
  };
  return { store, disk: () => disk };
}

describe("casUpdate", () => {
  it("commits cleanly with no contention (attempt 1, seq bumped)", () => {
    const f = fakeStore([]);
    const res = casUpdate(f.store, (v) => [...v, "A"]);
    expect(res).toEqual({ committed: true, attempts: 1, forced: false });
    expect(f.disk()).toEqual({ seq: 1, value: ["A"] });
  });

  it("re-merges on a conflict — two concurrent updates over a base both survive", () => {
    // A concurrent writer appends "B" (bumping seq) right before our first commit → our first commit
    // hits a seq conflict → casUpdate re-reads (now sees B) and RE-APPLIES our mutation → both land.
    const f = fakeStore([], (disk) => {
      disk.seq += 1;
      disk.value.push("B");
    });
    const res = casUpdate(f.store, (v) => [...v, "A"]);
    expect(res.committed).toBe(true);
    expect(res.attempts).toBe(2);
    expect(f.disk().value.slice().sort()).toEqual(["A", "B"]); // NEITHER update lost
    expect(f.disk().seq).toBe(2);
  });

  it("forces a final write after exhausting retries (never silently drops the update)", () => {
    // A pathological writer that bumps on EVERY commit attempt → every CAS check fails until the forced
    // last-ditch write (expectedSeq=null) lands unconditionally.
    let disk = { seq: 0, value: [] as string[] };
    const store: CasStore<string[]> = {
      read: () => ({ seq: disk.seq, value: [...disk.value] }),
      commit: (value, nextSeq, expectedSeq) => {
        disk = { seq: disk.seq + 1, value: disk.value }; // someone always beats us
        if (expectedSeq !== null && disk.seq !== expectedSeq) return false;
        disk = { seq: nextSeq, value: [...value] };
        return true;
      },
    };
    const res = casUpdate(store, (v) => [...v, "A"], 3);
    expect(res).toEqual({ committed: false, attempts: 3, forced: true });
    expect(disk.value).toContain("A"); // forced write landed — nothing dropped
  });
});

describe("WorldModel seq stamp survives the pure transforms", () => {
  it("normalizeModel reads a numeric seq (and defaults to absent)", () => {
    expect(normalizeModel({ version: 1, seq: 7, worlds: {} }).seq).toBe(7);
    expect(normalizeModel({ version: 1, worlds: {} }).seq).toBeUndefined();
    expect(normalizeModel({ version: 1, seq: "nope", worlds: {} }).seq).toBeUndefined();
  });
  it("putSection preserves the seq stamp (the write layer bumps it, not the section swap)", () => {
    const m = { ...emptyModel(), seq: 42 };
    const next = putSection(m, "sigA", getSection(m, "sigA"));
    expect(next.seq).toBe(42);
  });
});
