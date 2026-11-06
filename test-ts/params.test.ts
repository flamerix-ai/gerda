import { intParam, intParamOr, parseIdList, toSet } from "@/bot/missions/_params";
import { describe, expect, it } from "vitest";

describe("parseIdList", () => {
  it("filters an array to non-empty strings", () => {
    expect(parseIdList(["a", "", "b", 3, null])).toEqual(["a", "b"]);
  });

  it("parses a JSON-array string", () => {
    expect(parseIdList('["x","y"]')).toEqual(["x", "y"]);
  });

  it("filters empties out of a JSON-array string", () => {
    expect(parseIdList('["x","",7]')).toEqual(["x"]);
  });

  it("falls through to CSV when the JSON-array string is malformed", () => {
    expect(parseIdList("[a,b")).toEqual(["[a", "b"]);
  });

  it("splits a comma-separated string, trimming and dropping empties", () => {
    expect(parseIdList(" a , b ,, c ")).toEqual(["a", "b", "c"]);
  });

  it("returns [] for empty / non-string / whitespace", () => {
    expect(parseIdList("")).toEqual([]);
    expect(parseIdList("   ")).toEqual([]);
    expect(parseIdList(undefined)).toEqual([]);
    expect(parseIdList(42)).toEqual([]);
  });
});

describe("intParam", () => {
  it("returns a finite number", () => {
    expect(intParam({ x: 7 }, "x")).toBe(7);
    expect(intParam({ x: -3.5 }, "x")).toBe(-3.5);
  });

  it("returns null for non-numbers, missing keys, and non-finite", () => {
    expect(intParam({ x: "7" }, "x")).toBeNull();
    expect(intParam({}, "x")).toBeNull();
    expect(intParam({ x: Number.NaN }, "x")).toBeNull();
    expect(intParam({ x: Number.POSITIVE_INFINITY }, "x")).toBeNull();
  });
});

describe("intParamOr", () => {
  it("truncates a finite number", () => {
    expect(intParamOr({ n: 5.9 }, "n", 0)).toBe(5);
    expect(intParamOr({ n: -5.9 }, "n", 0)).toBe(-5);
  });

  it("parses a numeric string", () => {
    expect(intParamOr({ n: "12" }, "n", 0)).toBe(12);
  });

  it("falls back to the default for junk / missing / non-finite", () => {
    expect(intParamOr({ n: "" }, "n", 9)).toBe(9);
    expect(intParamOr({}, "n", 9)).toBe(9);
    expect(intParamOr({ n: Number.NaN }, "n", 9)).toBe(9);
    expect(intParamOr({ n: true }, "n", 9)).toBe(9);
  });
});

describe("toSet", () => {
  it("wraps parseIdList in a Set", () => {
    expect(toSet("a,b,a")).toEqual(new Set(["a", "b"]));
    expect(toSet(undefined)).toEqual(new Set());
  });
});
