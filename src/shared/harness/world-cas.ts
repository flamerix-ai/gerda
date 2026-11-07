// Compare-and-swap for the shared world-model file. mc_world.json is read-modify-written
// by MULTIPLE writers on different threads of the same JVM — the plain-JS supervisor + ext plugins
// (main.js thread) and the TS worker bundle (worker-service thread) — plus the occasional host-side
// seeder. A naive RMW (read → mutate in memory → write the whole model) is last-writer-wins: writer B,
// having read BEFORE writer A committed, clobbers A's update on write. A hazard marker or a storage
// record vanishes. This is the lost-update bug this file fixes.
//
// The mechanism is atomic-rename + a monotonic `seq` stamp CAS: on commit, re-read the on-disk seq; if
// it still matches the seq we read at the start of our RMW, atomically rename our staged file over the
// target (bumping seq); if it CHANGED under us, re-read the fresh model, re-apply our mutation over it,
// and retry. Bounded attempts; on give-up we force one final write (last-writer-wins — no WORSE than
// today, and every prior attempt was a real re-merge). The atomic rename means a reader NEVER sees a
// torn file. This module is the PURE loop; the CasStore seam (read/commit) carries the Java/rt.fs IO.
//
// MIRROR: harness/safe-io.js `__MC_HARNESS.cas`; test-ts/harness-contract.test.ts asserts parity.

export interface CasStore<T> {
  /** Read the current value + its monotonic seq (0 when absent/unstamped). */
  read(): { seq: number; value: T };
  /** Atomically persist `value` stamped with `nextSeq`. When `expectedSeq` is a number, write ONLY if
   *  the on-disk seq still equals it (the compare-and-swap) and return whether it did. When `expectedSeq`
   *  is `null`, FORCE the write unconditionally (the last-ditch give-up) and return true. Must write via
   *  a temp-file + atomic rename so a concurrent reader never observes a partial file. */
  commit(value: T, nextSeq: number, expectedSeq: number | null): boolean;
}

export interface CasResult {
  /** true = committed while winning the CAS (no lost update); false = forced after exhausting retries. */
  readonly committed: boolean;
  readonly attempts: number;
  readonly forced: boolean;
}

/** Run a read-modify-write as a compare-and-swap: read {seq,value}, `mutate` a fresh copy, commit iff the
 *  on-disk seq is unchanged; on conflict re-read and RE-APPLY `mutate` over the newer value (so a
 *  concurrent writer's update survives too), up to `maxAttempts`. `mutate` MUST be pure/idempotent over a
 *  fresh read — it is re-run each attempt against the latest model, which is exactly what makes both
 *  concurrent updates end up in the merged result. On give-up, one forced final write keeps behaviour no
 *  worse than the pre-CAS last-writer-wins. */
export function casUpdate<T>(
  store: CasStore<T>,
  mutate: (value: T) => T,
  maxAttempts = 8,
): CasResult {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { seq, value } = store.read();
    const next = mutate(value);
    if (store.commit(next, seq + 1, seq))
      return { committed: true, attempts: attempt, forced: false };
  }
  // Exhausted the CAS retries (persistent contention) — force one last re-merged write so an update is
  // never simply dropped. Re-read first so the forced write still carries the freshest foreign sections.
  const { seq, value } = store.read();
  store.commit(mutate(value), seq + 1, null);
  return { committed: false, attempts: maxAttempts, forced: true };
}
