import { FACE_OFFSET } from "@/core/prim/face";
import { cellCenter, dist } from "@/core/prim/pos";
import type { Face, Vec3 } from "@/core/runtime/types";
// interact — pure geometry + policy for "right-click a held item onto a block face" (place into an
// item frame, drop onto a display/pedestal/showcase, flip a lever). This is the terrain-free,
// unit-tested core of the interact mission + the `interact_place` ext primitive; the runtime-facing
// parts (hold the item, lookAt, useOnBlock, read the bag) live in the mission/ext, this file only
// decides WHERE to aim, WHICH face, and HOW to know it worked.
//
// The verify seam is the extension point the design calls for ("tune verify per target kind"):
// a target's PROFILE (`cfg.interact.profiles`, keyed frame/display/generic) supplies a default
// VerifyMode, overridable per call. Placing a held item into an empty frame or onto a pedestal
// CONSUMES one from the held stack (verified in-game), so `consumed` — a bag-count drop — is the
// reliable, worker-side signal for both without reading the frame entity / display block-entity.
// A new target kind = a new profile entry (+ a new VerifyMode arm here if it needs a novel check).
//
// `VerifyMode`/`InteractProfile` are DEFINED in @/shared/config/schema (they are config data — the
// `interact.profiles` value type). `domain → config` is the direction that already exists (three
// domain files import `Config`), so interact follows it rather than fighting it — that is what
// breaks the config↔domain cycle.
import type { InteractProfile, VerifyMode } from "@/shared/config/schema";

/** A fully-normalized interaction, ready to drive: where, which face, what to hold, how to verify. */
export interface ResolvedInteract {
  readonly pos: Vec3;
  readonly face: Face;
  /** Item id to hold before the click, or null = use whatever is already held. */
  readonly item: string | null;
  readonly verify: VerifyMode;
  readonly profile: string;
}

function isVec3(v: unknown): v is Vec3 {
  return (
    typeof v === "object" &&
    v !== null &&
    "x" in v &&
    typeof v.x === "number" &&
    "y" in v &&
    typeof v.y === "number" &&
    "z" in v &&
    typeof v.z === "number"
  );
}

const FACES: ReadonlySet<string> = new Set([
  "TOP",
  "BOTTOM",
  "NORTH",
  "SOUTH",
  "EAST",
  "WEST",
  "CENTER",
]);

function isFace(s: string): s is Face {
  return FACES.has(s);
}

/** The face of `block` that points toward `bot` — the side we're standing next to, so the aim +
 *  useOnBlock hit the reachable face (a frame hangs on the face you right-click). Picks the
 *  dominant horizontal axis; falls back to TOP when the bot is directly above/below or co-located
 *  (nothing horizontal to prefer). Deterministic tie-break: X wins an exact |dx|==|dz| tie. */
export function faceTowardBot(block: Vec3, bot: Vec3): Face {
  const dx = bot.x - block.x;
  const dz = bot.z - block.z;
  if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return "TOP";
  if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? "EAST" : "WEST";
  return dz >= 0 ? "SOUTH" : "NORTH";
}

/** The world point at the centre of `face` of the block cell `pos` — the aim target for lookAt.
 *  The block occupies [pos, pos+1]; its centre is pos+0.5, and the face centre is that shifted a
 *  half-block along the face normal (FACE_OFFSET). CENTER → the block centre itself. */
export function faceCenterPoint(pos: Vec3, face: Face): Vec3 {
  const off = FACE_OFFSET[face];
  return {
    x: pos.x + 0.5 + off.x * 0.5,
    y: pos.y + 0.5 + off.y * 0.5,
    z: pos.z + 0.5 + off.z * 0.5,
  };
}

/** Normalize a raw param record (mission_start / ext request) into a ResolvedInteract. Resolution
 *  order for each field: explicit param → profile default → geometry/fallback. `bot` (the current
 *  player position) is only consulted to derive the face when neither a param nor the profile pins
 *  one. Returns null when the target position is missing/ill-formed (the one hard requirement). */
export function resolveInteract(
  params: {
    readonly pos?: unknown;
    readonly face?: unknown;
    readonly item?: unknown;
    readonly verify?: unknown;
    readonly profile?: unknown;
  },
  profiles: Readonly<Record<string, InteractProfile>>,
  bot?: Vec3,
): ResolvedInteract | null {
  if (!isVec3(params.pos)) return null;
  const pos: Vec3 = {
    x: Math.floor(params.pos.x),
    y: Math.floor(params.pos.y),
    z: Math.floor(params.pos.z),
  };

  const profileName =
    typeof params.profile === "string" && params.profile in profiles ? params.profile : "generic";
  const profile: InteractProfile = profiles[profileName] ?? { verify: "none" };

  const verify: VerifyMode =
    params.verify === "consumed" || params.verify === "none" ? params.verify : profile.verify;

  const faceParam = typeof params.face === "string" ? params.face.toUpperCase() : null;
  const face: Face =
    faceParam && isFace(faceParam)
      ? faceParam
      : (profile.face ?? (bot ? faceTowardBot(pos, bot) : "NORTH"));

  const item = typeof params.item === "string" && params.item.length > 0 ? params.item : null;

  return { pos, face, item, verify, profile: profileName };
}

/** Pick the frame ENTITY to right-click for a frame-profile interaction: the nearest item-frame
 *  within `maxDist` of the target block cell's centre. A vanilla frame is an entity hanging in the
 *  cell against its support face — its coords sit in/near the target cell, so nearest-to-centre is
 *  the right disambiguator when frames tile a wall. null = no frame near the target (fail loud —
 *  never fall back to a block click that silently does nothing). */
export function nearestFrameUuid(
  frames: readonly { uuid: string; x: number; y: number; z: number }[],
  target: Vec3,
  maxDist: number,
): string | null {
  const c = cellCenter(target);
  let best: string | null = null;
  let bestD = maxDist;
  for (const f of frames) {
    const d = dist(f, c);
    if (d <= bestD) {
      bestD = d;
      best = f.uuid;
    }
  }
  return best;
}

/** Did the interaction take effect? `before`/`after` are the held-count of the placed item around
 *  the click (only read for `consumed`). `dispatched` = the useOnBlock call itself returned ok. */
export function verifyPlaced(
  mode: VerifyMode,
  dispatched: boolean,
  before: number,
  after: number,
): boolean {
  if (!dispatched) return false;
  switch (mode) {
    case "consumed":
      return after < before;
    case "none":
      return true;
  }
}
