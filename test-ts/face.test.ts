// face geometry — offsetToFace is the inverse of FACE_OFFSET (place against face F of `against` →
// block lands at against + FACE_OFFSET[F]); a non-unit step has no single face.
import { FACE_OFFSET, offsetToFace } from "@/core/prim/face";
import type { Face } from "@/core/runtime/types";
import { describe, expect, it } from "vitest";

describe("offsetToFace", () => {
  it("inverts FACE_OFFSET for every axis face", () => {
    for (const face of Object.keys(FACE_OFFSET) as Face[]) {
      if (face === "CENTER") continue; // the zero offset isn't a placement direction
      const o = FACE_OFFSET[face];
      expect(offsetToFace(o.x, o.y, o.z)).toBe(face);
    }
  });

  it("returns null for a diagonal / non-unit step", () => {
    expect(offsetToFace(1, 0, 1)).toBeNull();
    expect(offsetToFace(2, 0, 0)).toBeNull();
    expect(offsetToFace(0, 0, 0)).toBeNull();
  });
});
