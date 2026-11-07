// Facade additions for the navigator: player.onGround (read) + interact.setRotation
// (mutate). Verifies the mock surface so missions/executor can be unit-tested; the real impl's
// setRotation is live-verified later (it mutates).
import { createMockRuntime } from "@/core/runtime/mock";
import { describe, expect, it } from "vitest";

describe("player.onGround", () => {
  it("reports the mock ground state", () => {
    const rt = createMockRuntime();
    const r = rt.player.onGround();
    expect(r.ok && r.value).toBe(true);
    rt.state.onGround = false;
    const r2 = rt.player.onGround();
    expect(r2.ok && r2.value).toBe(false);
  });
});

describe("interact.setRotation", () => {
  it("records the heading", () => {
    const rt = createMockRuntime();
    expect(rt.interact.setRotation(90, -10).ok).toBe(true);
    expect(rt.state.rotation).toEqual({ yaw: 90, pitch: -10 });
  });
});
