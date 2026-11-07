import { STATE, TRANSITIONS } from "@/bot/profile/states";
import { decodePos, dist, encodePos } from "@/core/prim/pos";
import type { BlockReader } from "@/shared/domain/senses";
import { solveMiningTarget } from "@/shared/domain/solveMiningTarget";
import { Fsm, IllegalTransitionError } from "@/shared/kernel/fsm";
import { describe, expect, it } from "vitest";

describe("pos", () => {
  it("round-trips encode/decode", () => {
    expect(decodePos(encodePos(-5, 64, 12))).toEqual({ x: -5, y: 64, z: 12 });
  });
  it("rejects malformed keys", () => {
    expect(() => decodePos("1,2")).toThrow(TypeError);
  });
  it("computes euclidean distance", () => {
    expect(dist({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 4 })).toBe(5);
  });
});

describe("solveMiningTarget", () => {
  const target = { x: 10, y: 20, z: 10 };

  it("TOP face stands directly above", () => {
    const s = solveMiningTarget(target, { aoeDepth: 0, breakTargetFace: "TOP" }, null);
    expect(s.standPos).toEqual({ x: 10, y: 21, z: 10 });
    expect(s.face).toBe("TOP");
  });

  it("TOP face with the target ABOVE the bot stands two below it (head clear, break upward)", () => {
    const s = solveMiningTarget(
      target,
      { aoeDepth: 0, breakTargetFace: "TOP" },
      { x: 10, y: 14, z: 10 },
    );
    expect(s.standPos).toEqual({ x: 10, y: 18, z: 10 }); // feet 2 below → head (y19) clear of the ore (y20)
    expect(s.face).toBe("BOTTOM");
  });

  it("TOP face with the target at/below the bot still stands above (drilling down)", () => {
    const s = solveMiningTarget(
      target,
      { aoeDepth: 0, breakTargetFace: "TOP" },
      { x: 10, y: 25, z: 10 },
    );
    expect(s.standPos).toEqual({ x: 10, y: 21, z: 10 });
    expect(s.face).toBe("TOP");
  });

  it("SIDE face picks the nearest adjacent block", () => {
    const s = solveMiningTarget(
      target,
      { aoeDepth: 1, breakTargetFace: "SIDE" },
      { x: 13, y: 20, z: 10 },
    );
    expect(s.standPos).toEqual({ x: 11, y: 20, z: 10 });
    expect(s.face).toBe("WEST");
  });

  it("flags sameStandPos when already on the solution", () => {
    const s = solveMiningTarget(
      target,
      { aoeDepth: 0, breakTargetFace: "TOP" },
      { x: 10, y: 21, z: 10 },
    );
    expect(s.sameStandPos).toBe(true);
  });
});

describe("solveMiningTarget — world-aware exposed-ore SIDE preference", () => {
  const target = { x: 10, y: 20, z: 10 };

  // Exposed slab: ore at the target sitting on a stone floor (y19), air above + around at y20+.
  // Every same-level neighbour is a standable floor-edge cell → walkable.
  const exposed: BlockReader = (x, y, z) => {
    if (x === 10 && y === 20 && z === 10) return "minecraft:iron_ore";
    return y <= 19 ? "minecraft:stone" : "minecraft:air";
  };
  // Embedded: solid rock everywhere → no open, standable side → must fall back to TOP/BOTTOM.
  const embedded: BlockReader = () => "minecraft:stone";

  it("TOP strategy + a reader: an EXPOSED ore is mined from BESIDE it (SIDE), not from on top", () => {
    const s = solveMiningTarget(
      target,
      { aoeDepth: 0, breakTargetFace: "TOP" },
      { x: 13, y: 20, z: 10 },
      exposed,
    );
    expect(s.standPos).toEqual({ x: 11, y: 20, z: 10 }); // nearest standable side neighbour
    expect(s.face).toBe("WEST");
  });

  it("TOP strategy + a reader: an EMBEDDED ore (no open side) still stands above (drilling down)", () => {
    const s = solveMiningTarget(
      target,
      { aoeDepth: 0, breakTargetFace: "TOP" },
      { x: 10, y: 25, z: 10 },
      embedded,
    );
    expect(s.standPos).toEqual({ x: 10, y: 21, z: 10 });
    expect(s.face).toBe("TOP");
  });

  it("no reader → unchanged behaviour (stands above, the pure default)", () => {
    const s = solveMiningTarget(
      target,
      { aoeDepth: 0, breakTargetFace: "TOP" },
      { x: 13, y: 20, z: 10 },
    );
    expect(s.standPos).toEqual({ x: 10, y: 21, z: 10 });
    expect(s.face).toBe("TOP");
  });
});

describe("Fsm", () => {
  const fsm = new Fsm(TRANSITIONS);

  it("allows declared edges and self-transitions", () => {
    expect(fsm.canTransition(STATE.SCAN, STATE.MINE)).toBe(true);
    expect(fsm.canTransition(STATE.MINE, STATE.MINE)).toBe(true);
  });

  it("rejects undeclared edges", () => {
    expect(fsm.canTransition(STATE.DUMP, STATE.MINE)).toBe(false);
    expect(() => fsm.assert(STATE.DUMP, STATE.MINE)).toThrow(IllegalTransitionError);
  });

  it("every state is reachable as a transition source", () => {
    expect(fsm.states()).toContain(STATE.LOOT);
  });
});
