import type { Result } from "@/core/runtime/types";
// The world-model read-modify-write wrappers (one-home SSOT): readWorldSection / withWorldSection /
// writeHazardMarker. The real writers (recordRavine/recordDrowned/recordLooted/…) run through the
// kernel in their own tests; this pins the shared transaction primitive directly.
import {
  type WorldTx,
  readWorldSection,
  withWorldSection,
  writeHazardMarker,
} from "@/shared/domain/world-model";
import { describe, expect, it } from "vitest";

function fakeTx(opts: { noSig?: boolean; writeFails?: boolean } = {}): {
  tx: WorldTx;
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  const path = "/world.json";
  const ok = <T>(value: T): Result<T> => ({ ok: true, value });
  const tx: WorldTx = {
    cfg: { worldModelPath: path },
    rt: {
      world: {
        signature: (): Result<string> =>
          opts.noSig ? { ok: false, error: "no sig" } : ok("world|overworld"),
      },
      fs: {
        read: (p: string): Result<string | null> => ok(store.get(p) ?? null),
        writeAtomic: (p: string, d: string): Result<void> => {
          if (opts.writeFails) return { ok: false, error: "disk full" };
          store.set(p, d);
          return ok(undefined);
        },
      },
    },
  };
  return { tx, store };
}

describe("readWorldSection", () => {
  it("returns an empty section when the file is absent", () => {
    const { tx } = fakeTx();
    const s = readWorldSection(tx);
    expect(s).not.toBeNull();
    expect(s?.hazards).toEqual([]);
  });

  it("returns null when there is no world signature", () => {
    const { tx } = fakeTx({ noSig: true });
    expect(readWorldSection(tx)).toBeNull();
  });
});

describe("withWorldSection", () => {
  it("commits a mutation and reads it back", () => {
    const { tx } = fakeTx();
    const res = withWorldSection(tx, (section) => ({
      ...section,
      stats: { ...section.stats, dumps: 3 },
    }));
    expect(res.status).toBe("written");
    expect(readWorldSection(tx)?.stats.dumps).toBe(3);
  });

  it("skips the write when mutate returns null", () => {
    const { tx, store } = fakeTx();
    const res = withWorldSection(tx, () => null);
    expect(res.status).toBe("skipped");
    expect(store.size).toBe(0);
  });

  it("reports no-signature without touching the store", () => {
    const { tx, store } = fakeTx({ noSig: true });
    const res = withWorldSection(tx, (s) => s);
    expect(res.status).toBe("no-signature");
    expect(store.size).toBe(0);
  });

  it("surfaces a write failure with its error", () => {
    const { tx } = fakeTx({ writeFails: true });
    const res = withWorldSection(tx, (s) => s);
    expect(res).toEqual({ status: "write-failed", error: "disk full" });
  });
});

describe("writeHazardMarker", () => {
  it("appends a hazard column and dedups by X/Z (newest tick wins)", () => {
    const { tx } = fakeTx();
    expect(writeHazardMarker(tx, "ravine", 8, 0, 100).status).toBe("written");
    expect(writeHazardMarker(tx, "drowned", 8, 0, 200).status).toBe("written");
    const hazards = readWorldSection(tx)?.hazards ?? [];
    expect(hazards).toHaveLength(1);
    expect(hazards[0]).toEqual({ kind: "drowned", x: 8, z: 0, tick: 200 });
  });
});
