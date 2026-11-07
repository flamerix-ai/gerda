// Shared domain primitives. Pure data — no jsMacros, no behavior.
import { ContractError } from "@/core/prim/invariant";

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A concrete block face / direction passed to the interaction manager. */
export type Face = "TOP" | "BOTTOM" | "NORTH" | "SOUTH" | "EAST" | "WEST" | "CENTER";

/** A strategy hint for how to approach a target — not a concrete direction. */
export type BreakFaceHint = "TOP" | "SIDE" | "CENTER";

/** Result wrapper used at the runtime boundary instead of swallowing to null. EXPECTED
 *  external failure is the only thing that produces an `err` — the facade never fakes a
 *  fallback value. Callers MUST branch on `.ok` (or `expectOk` when success is a
 *  contract). The defensive-code checker forbids dropping a Result on the floor. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}
export function err<T = never>(error: string): Result<T> {
  return { ok: false, error };
}

/** Unwrap a Result whose success is a CONTRACT (a bug if it failed) — throws
 *  `ContractError` on err. Named `expectOk` (not `expect`) to avoid clashing with the
 *  vitest global in tests. Use only where an err means "the code is wrong", never for
 *  expected-transient failures (branch on `.ok` for those). */
export function expectOk<T>(r: Result<T>, message: string): T {
  if (!r.ok) {
    throw new ContractError(`expectOk: ${message}: ${r.error}`);
  }
  return r.value;
}

/** Tool AOE geometry + breaking strategy (subset the solver needs). */
export interface MiningStrategy {
  readonly breakStrategy: "BARITONE" | "MANUAL_AOE";
  readonly aoeRadius: number;
  readonly aoeDepth: number;
  readonly standDistance: number;
  readonly breakTargetFace: BreakFaceHint;
  readonly targetPicker: "nearest" | "layerFirst";
  readonly layerStride?: number;
  readonly layerVerticalSpan?: number;
}

export interface StandSolution {
  readonly standPos: Vec3;
  readonly face: Face;
  readonly sameStandPos: boolean;
}

/** Inclusive axis-aligned XZ box (Y ignored — fleet assignments partition the surface
 *  column, not height). The unit of a region claim. */
export interface Box {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** A vein column another bot is actively working (a hub lease, TTL'd — the hub observes each
 *  bot's DRILL_TARGET/mining state and claims the column on its behalf; bots have no outbound
 *  networking). This bot's drill skips veins near a peer's claim. */
export interface VeinClaim {
  readonly x: number;
  readonly z: number;
}

/** A fleet-shared hazard column: the hub unions every bot's own recorded hazards (drowned/
 *  ravine markers in each instance's mc_world.json, aggregated host-side) so ONE bot drowning
 *  teaches the whole fleet. Structural twin of the domain `HazardMarker` — runtime types sit
 *  below the domain layer and can't import it; consumers only need x/z (+kind for logs). */
export interface FleetHazard {
  readonly kind: string;
  readonly x: number;
  readonly z: number;
}

/** A fleet assignment pushed down by the coordinator hub: the XZ region this bot
 *  may mine in, plus regions claimed by OTHER bots it must avoid. Absent assignment (the
 *  facade returns `null`) = unrestricted. The mine scan filters candidate ore by it. */
export interface FleetAssignment {
  /** The bot's allowed region; `null` = whole world. */
  readonly allowed: Box | null;
  /** Peer-claimed regions the bot must not mine in. */
  readonly forbidden: readonly Box[];
  /** Vein columns peers are actively drilling (hub lease ledger) — drill skips near them.
   *  Optional: an old-shape assignment (no field) reads as "no claims". */
  readonly claimedVeins?: readonly VeinClaim[];
  /** Fleet-shared hazard columns (union of peers' drowned/ravine markers) — scan/drill treat
   *  them exactly like this bot's own recorded hazards. Optional like `claimedVeins`. */
  readonly hazards?: readonly FleetHazard[];
}
