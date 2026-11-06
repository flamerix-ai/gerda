// interact domain — the pure geometry + verify-policy core (no runtime): face-toward-bot, face
// centre aim point, param→ResolvedInteract normalization (override → profile → fallback), and the
// verify predicate. Locks the seam the interact mission + interact_place ext both drive.
import type { InteractProfile } from "@/shared/config/schema";
import {
  faceCenterPoint,
  faceTowardBot,
  nearestFrameUuid,
  resolveInteract,
  verifyPlaced,
} from "@/shared/domain/interact";
import { describe, expect, it } from "vitest";

const PROFILES: Record<string, InteractProfile> = {
  frame: { verify: "consumed" },
  display: { verify: "consumed" },
  generic: { verify: "none" },
};

describe("faceTowardBot", () => {
  it("picks the horizontal face pointing at the bot (dominant axis)", () => {
    const block = { x: 0, y: 64, z: 0 };
    expect(faceTowardBot(block, { x: 3, y: 64, z: 0 })).toBe("EAST");
    expect(faceTowardBot(block, { x: -3, y: 64, z: 0 })).toBe("WEST");
    expect(faceTowardBot(block, { x: 0, y: 64, z: 3 })).toBe("SOUTH");
    expect(faceTowardBot(block, { x: 0, y: 64, z: -3 })).toBe("NORTH");
  });
  it("prefers the larger delta and breaks an exact tie toward X", () => {
    const block = { x: 0, y: 64, z: 0 };
    expect(faceTowardBot(block, { x: 2, y: 64, z: 1 })).toBe("EAST");
    expect(faceTowardBot(block, { x: 1, y: 64, z: 2 })).toBe("SOUTH");
    expect(faceTowardBot(block, { x: 2, y: 64, z: 2 })).toBe("EAST"); // |dx|==|dz| → X
  });
  it("falls back to TOP when the bot is directly above/below or co-located", () => {
    expect(faceTowardBot({ x: 0, y: 64, z: 0 }, { x: 0, y: 70, z: 0 })).toBe("TOP");
  });
});

describe("faceCenterPoint", () => {
  it("returns the centre of the requested face of the block cell", () => {
    const p = { x: 10, y: 64, z: 5 };
    expect(faceCenterPoint(p, "NORTH")).toEqual({ x: 10.5, y: 64.5, z: 5 });
    expect(faceCenterPoint(p, "EAST")).toEqual({ x: 11, y: 64.5, z: 5.5 });
    expect(faceCenterPoint(p, "TOP")).toEqual({ x: 10.5, y: 65, z: 5.5 });
    expect(faceCenterPoint(p, "CENTER")).toEqual({ x: 10.5, y: 64.5, z: 5.5 });
  });
});

describe("resolveInteract", () => {
  it("uses the profile default verify and floors the position", () => {
    const r = resolveInteract({ pos: { x: 1.9, y: 64.2, z: -0.1 }, profile: "frame" }, PROFILES);
    expect(r).not.toBeNull();
    expect(r?.pos).toEqual({ x: 1, y: 64, z: -1 });
    expect(r?.verify).toBe("consumed");
    expect(r?.profile).toBe("frame");
  });
  it("lets explicit params override the profile", () => {
    const r = resolveInteract(
      {
        pos: { x: 0, y: 64, z: 0 },
        profile: "frame",
        verify: "none",
        face: "top",
        item: "minecraft:diamond",
      },
      PROFILES,
    );
    expect(r?.verify).toBe("none");
    expect(r?.face).toBe("TOP");
    expect(r?.item).toBe("minecraft:diamond");
  });
  it("derives the face toward the bot when neither param nor profile pins one", () => {
    const r = resolveInteract({ pos: { x: 0, y: 64, z: 0 }, profile: "display" }, PROFILES, {
      x: 5,
      y: 64,
      z: 0,
    });
    expect(r?.face).toBe("EAST");
  });
  it("defaults to the generic profile (verify none) for an unknown profile", () => {
    const r = resolveInteract({ pos: { x: 0, y: 64, z: 0 }, profile: "nonsense" }, PROFILES);
    expect(r?.profile).toBe("generic");
    expect(r?.verify).toBe("none");
  });
  it("returns null when the position is missing or ill-formed", () => {
    expect(resolveInteract({ profile: "frame" }, PROFILES)).toBeNull();
    expect(resolveInteract({ pos: { x: 1, y: 2 } }, PROFILES)).toBeNull();
  });
});

describe("nearestFrameUuid", () => {
  const frame = (uuid: string, x: number, y: number, z: number) => ({ uuid, x, y, z });
  it("picks the frame nearest the target cell centre on a tiled wall", () => {
    const frames = [frame("a", 2.03, 64.5, 0.5), frame("b", 2.03, 64.5, 1.5)];
    expect(nearestFrameUuid(frames, { x: 2, y: 64, z: 0 }, 1.5)).toBe("a");
    expect(nearestFrameUuid(frames, { x: 2, y: 64, z: 1 }, 1.5)).toBe("b");
  });
  it("returns null when no frame is within maxDist (fail loud, no block fallback)", () => {
    expect(nearestFrameUuid([frame("a", 10, 64, 10)], { x: 2, y: 64, z: 0 }, 1.5)).toBeNull();
    expect(nearestFrameUuid([], { x: 2, y: 64, z: 0 }, 1.5)).toBeNull();
  });
});

describe("verifyPlaced", () => {
  it("consumed → true only when the held count dropped", () => {
    expect(verifyPlaced("consumed", true, 5, 4)).toBe(true);
    expect(verifyPlaced("consumed", true, 5, 5)).toBe(false);
  });
  it("none → true whenever the click dispatched", () => {
    expect(verifyPlaced("none", true, 0, 0)).toBe(true);
  });
  it("a failed dispatch is never placed, whatever the mode", () => {
    expect(verifyPlaced("consumed", false, 5, 4)).toBe(false);
    expect(verifyPlaced("none", false, 0, 0)).toBe(false);
  });
});
