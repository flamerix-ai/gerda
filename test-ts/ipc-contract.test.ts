// Drift gate for the IPC single-source-of-truth. harness/ipc.js (R0/R1,
// plain JS) and src/core/ipc/ipc.ts (R2, this bundle) MUST stay in lockstep — same
// keys, same ring capacity, same version, same envelope shapes. If they diverge,
// the two halves of the harness disagree on the wire and this test fails the
// `bun run check` gate before anything ships.
import { readFileSync } from "node:fs";
import * as ts from "@/core/ipc/ipc";
import { describe, expect, it } from "vitest";

// ipc.js is pure JS (no Java/jsMacros at module scope); running it populates
// globalThis.__MC_IPC exactly as it does inside a jsMacros Service. Path is
// relative to the repo root (vitest's cwd).
function loadIpcJs(): Record<string, unknown> {
  const code = readFileSync("harness/ipc.js", "utf8");
  const g = globalThis as Record<string, unknown>;
  // biome-ignore lint/security/noGlobalEval: the contract test must execute the real ipc.js in global scope.
  globalThis.eval(code);
  const ipc = g["__MC_IPC"];
  if (!ipc) throw new Error("ipc.js did not assign globalThis.__MC_IPC");
  return ipc as Record<string, unknown>;
}

const js = loadIpcJs();

describe("IPC SSOT parity (ipc.js <-> ipc.ts)", () => {
  it("agrees on KEYS", () => {
    expect(js["KEYS"]).toEqual(ts.KEYS);
  });

  it("agrees on RING_SIZE and VERSION", () => {
    expect(js["RING_SIZE"]).toBe(ts.RING_SIZE);
    expect(js["VERSION"]).toBe(ts.IPC_VERSION);
  });

  it("agrees on composite key helpers", () => {
    const j = js as {
      bridgeCmd: (n: number) => string;
      bridgeResp: (n: number) => string;
      eventSlot: (n: number) => string;
    };
    expect(j.bridgeCmd(3)).toBe(ts.bridgeCmd(3));
    expect(j.bridgeResp(7)).toBe(ts.bridgeResp(7));
    expect(j.eventSlot(5)).toBe(ts.eventSlot(5));
  });

  it("agrees on envelope shapes", () => {
    const j = js as {
      ok: (id: number, type: string, data?: unknown) => object;
      okFlat: (id: number, type: string, fields?: object) => object;
      err: (id: number, type: string, error: string) => object;
      evt: (seq: number, kind: string, fields?: object) => object;
    };
    // ok with and without data
    expect(j.ok(1, "x", "d")).toEqual(ts.ok(1, "x", "d"));
    expect(j.ok(1, "x")).toEqual(ts.ok(1, "x"));
    // okFlat spreads fields at top level
    expect(j.okFlat(2, "y", { a: 1, b: "z" })).toEqual(ts.okFlat(2, "y", { a: 1, b: "z" }));
    // err carries error + extra
    expect(j.err(3, "z", "boom")).toEqual(ts.err(3, "z", "boom"));
    // evt carries a t field (numeric) — compare keys, not the timestamp value
    expect(Object.keys(j.evt(4, "k", { p: 1 })).sort()).toEqual(
      Object.keys(ts.evt(4, "k", { p: 1 })).sort(),
    );
  });

  it("stage-1 responses carry NO `t` field (byte-identical wire)", () => {
    expect("t" in ts.ok(1, "x", "d")).toBe(false);
    expect("t" in ts.okFlat(1, "x", { a: 1 })).toBe(false);
    expect("t" in ts.err(1, "x", "e")).toBe(false);
  });
});
