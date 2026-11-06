import { bump, freshCounter, resetCounter } from "@/shared/reflexes/window-counter";
import { describe, expect, it } from "vitest";

describe("WindowCounter (increment-or-reset debounce)", () => {
  it("fires on the tick the run first reaches the threshold, then re-arms", () => {
    const c = freshCounter();
    expect(bump(c, true, 3)).toBe(false); // 1
    expect(bump(c, true, 3)).toBe(false); // 2
    expect(bump(c, true, 3)).toBe(true); // 3 → fire, resets
    expect(bump(c, true, 3)).toBe(false); // 1 again (needs another full run)
    expect(bump(c, true, 3)).toBe(false); // 2
    expect(bump(c, true, 3)).toBe(true); // 3 → fire again
  });

  it("an inactive tick resets the run", () => {
    const c = freshCounter();
    bump(c, true, 3); // 1
    bump(c, true, 3); // 2
    expect(bump(c, false, 3)).toBe(false); // reset to 0
    expect(bump(c, true, 3)).toBe(false); // 1 (not 3)
    expect(bump(c, true, 3)).toBe(false); // 2
    expect(bump(c, true, 3)).toBe(true); // 3 → fire
  });

  it("threshold 1 fires on the first active tick", () => {
    const c = freshCounter();
    expect(bump(c, true, 1)).toBe(true);
    expect(bump(c, false, 1)).toBe(false);
    expect(bump(c, true, 1)).toBe(true);
  });

  it("resetCounter clears the run", () => {
    const c = freshCounter();
    bump(c, true, 3);
    bump(c, true, 3);
    resetCounter(c);
    expect(bump(c, true, 3)).toBe(false); // back to 1
  });
});
