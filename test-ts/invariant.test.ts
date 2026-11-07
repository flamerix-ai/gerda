// The fail-loud invariant SSOT: `must` returns present values untouched and THROWS
// (never returns a fabricated value) when the assumption breaks — the explicit
// replacement for `x[i] as T` casts at guaranteed-present lookups.
import { must, unreachable } from "@/core/prim/invariant";
import { describe, expect, it } from "vitest";

describe("must", () => {
  it("returns the value when present", () => {
    expect(must(0, "zero")).toBe(0);
    expect(must("", "empty")).toBe("");
    expect(must(false, "false")).toBe(false);
    expect(must([1], "arr")).toEqual([1]);
  });

  it("throws loudly on null/undefined", () => {
    expect(() => must(null, "was null")).toThrow("invariant: was null");
    expect(() => must(undefined, "was undef")).toThrow("invariant: was undef");
  });
});

describe("unreachable", () => {
  it("throws with the offending value", () => {
    // cast only to satisfy the `never` param at a synthetic call site
    expect(() => unreachable("X" as never, "bad variant")).toThrow("unreachable: bad variant (X)");
  });
});
