import { RuntimeUnsupportedError } from "@/core/prim/invariant";
import type { Runtime } from "@/core/runtime/Runtime";
import type { Vec3 } from "@/core/runtime/types";
// Navigator core primitives — the tiny leaf module every nav machine leans on: the step-result
// type, key release, sprint control, and the live-world reader. Imports nothing from the rest of
// src/shared/nav so the machine modules (route/parkour/pillar/ladder/executor) can all depend on it
// without cycles.
import type { Config } from "@/shared/config/schema";
import type { MoveKind } from "@/shared/domain/movement-types";

// "blocked_no_path" = the planner found no route to the goal in the world-view cache; the goal is
// unreachable for greedy's movement set (e.g. a wall taller than one step). "blocked_hazard" = a
// route exists but the immediate next step failed the LIVE hazard veto (lava/drop). Distinct so a
// fail-loud log says WHERE it broke — a planning gap vs a real-world hazard.
export type GreedyStep = "moving" | "arrived" | "blocked_no_path" | "blocked_hazard";

/** The cell to drive toward this tick PLUS the move POLICY the planner chose to reach it.
 *  The route layer (routeNext / dstarNext / commitNext) carries this pair so the executor dispatches
 *  on `kind` (a `switch`) instead of re-deriving the move from `feet → cell` geometry. `kind` is always
 *  a concrete MoveKind here (never the "start" sentinel — a next-step is `path[i≥1]`). */
export interface NextStep {
  readonly cell: Vec3;
  readonly kind: MoveKind;
}

/** True for any "blocked_*" result — greedy could not advance this tick. */
export function isBlocked(step: GreedyStep): boolean {
  return step === "blocked_no_path" || step === "blocked_hazard";
}

/** Movement keys the executor asserts; released together when it yields the GOTO phase. */
const MOVE_KEYS = ["key.forward", "key.jump", "key.sprint"] as const;

// — Sprint control: the ONE path that touches the vanilla sprint flag ————————————————————————————————
// Vanilla `LivingEntity.setSprinting` ALWAYS remove+re-adds the speed-attribute modifier (a map
// mutation) — even for `false`. Calling it every tick from the worker thread races the render thread,
// which reads that same modifier map in `GameRenderer.getPlayerFov` → `AttributeInstance.getValue`
// (it iterates the modifier set), throwing `ConcurrentModificationException` → the client is dropped
// to the title screen, off the server (live: BOTH bots died here mid-loot; crash report
// stack is getPlayerFov → AttributeInstance.m_22137_). Two defences, both routed through here:
//   1. cfg.nav.sprint OFF ⇒ we NEVER call setSprinting — the sprint modifier is never added, so there
//      is nothing to mutate and nothing to race (the bot walks; ~17% slower but it stays online).
//   2. cfg.nav.sprint ON ⇒ EDGE-TRIGGER: only call on a real false↔true change, collapsing ~20
//      mutations/sec to a couple per leg (far smaller race window, for when speed is wanted).
// The keybind is always set (cheap, no attribute touch) so the visible key state matches.
let sprintFlag = false;
export function applySprint(rt: Runtime, cfg: Config, on: boolean): void {
  const want = cfg.nav.sprint && on;
  rt.keys.set("key.sprint", want);
  if (!cfg.nav.sprint) return; // disabled → never mutate the speed-attribute modifier map
  if (want === sprintFlag) return; // edge-trigger: skip the redundant per-tick modifier churn
  sprintFlag = want;
  void rt.player.setSprinting(want);
}

/** Drop the forced sprint flag, but ONLY if we actually sprinted — a never-sprinted (cfg.nav.sprint off, or
 *  walk-only) leg never mutates the speed-attribute map here, keeping the FOV-crash window shut. */
export function clearSprint(rt: Runtime): void {
  if (!sprintFlag) return;
  sprintFlag = false;
  void rt.player.setSprinting(false);
}

/** Drop the sprint edge-trigger cache (a fresh leg starts un-sprinted). Part of resetGreedyNav. */
export function resetSprintFlag(): void {
  sprintFlag = false;
}

/** Release every movement key the executor holds. Called on arrive/blocked and when leaving
 *  GOTO — also see keys.releaseAll(), extended to cover movement keys for reflex diverts. */
export function greedyRelease(rt: Runtime): void {
  for (const k of MOVE_KEYS) rt.keys.set(k, false);
  clearSprint(rt); // drop the forced sprint flag (keybind release ≠ flag clear); no-op if never sprinted
}

/** Release the movement keys BEFORE a blocking computation (a full A* replan) and return the ones
 *  that were held. The client applies a held key for as long as the worker tick runs, and every safety
 *  veto (step hazard, fall survival, descent guard) runs only between worker ticks — RCA I-4: a 25 s
 *  replan with forward+sprint still held from the last drive walked the bot off a 39-block rim. The
 *  next drive re-asserts whatever it still wants; a caller that must keep its committed heading after
 *  the computation (AIRBORNE-HOLD) passes the returned keys to reassertKeys. */
export function releaseForBlockingWork(rt: Runtime): readonly string[] {
  const held = rt.keys.driveHeldKeys();
  const moving = MOVE_KEYS.filter((k) => held.includes(k));
  greedyRelease(rt);
  return moving;
}

/** Press `keys` again (the AIRBORNE-HOLD re-assert after releaseForBlockingWork). */
export function reassertKeys(rt: Runtime, keys: readonly string[]): void {
  for (const k of keys) rt.keys.set(k, true);
}

// — Movement-critical reads/writes: fail loud, never walk blind ————————————————————————————————
// A drive needs three facts it cannot guess: which way it faces (setYaw / setRotation), whether
// it stands on something (onGround) and how it is moving (velocity). Before these helpers the nav
// machines dropped a failed setYaw (`void`) and read a failed onGround as "grounded" — harmless on
// Forge 1.20.1, where those calls only fail with no player, but on Fabric (no SRG members) `goto`
// held forward along yaw 0 and fell 19 blocks (docs/PORTABILITY.md). Now a failure releases
// every movement key and throws RuntimeUnsupportedError (a ContractError → the mission goes to
// ERROR with the op and the facade error in MISSION_FATAL).

/** Release every movement key, then end the drive loudly. */
export function haltDriveUnsupported(rt: Runtime, op: string, error: string): never {
  rt.keys.releaseAll();
  greedyRelease(rt); // also drops the forced sprint flag (a keybind release does not)
  throw new RuntimeUnsupportedError(op, error);
}

/** Turn to `yaw` (pitch untouched) or end the drive — pressing forward without a heading is a blind walk. */
export function mustSetYaw(rt: Runtime, yaw: number): void {
  const r = rt.interact.setYaw(yaw);
  if (!r.ok) haltDriveUnsupported(rt, "interact.setYaw", r.error);
}

/** Set yaw + pitch or end the drive (an aim that did not land breaks whatever was in the crosshair). */
export function mustSetRotation(rt: Runtime, yaw: number, pitch: number): void {
  const r = rt.interact.setRotation(yaw, pitch);
  if (!r.ok) haltDriveUnsupported(rt, "interact.setRotation", r.error);
}

/** Read the current yaw or end the drive (no fabricated heading). */
export function mustYaw(rt: Runtime): number {
  const r = rt.player.yaw();
  if (!r.ok) return haltDriveUnsupported(rt, "player.yaw", r.error);
  return r.value;
}

/** Ground contact or end the drive — an unknown is never "grounded" (nor "airborne"). */
export function mustOnGround(rt: Runtime): boolean {
  const r = rt.player.onGround();
  if (!r.ok) return haltDriveUnsupported(rt, "player.onGround", r.error);
  return r.value;
}

/** Velocity or end the drive — a fabricated 0 would time jumps and block placements wrongly. */
export function mustVelocity(rt: Runtime): Vec3 {
  const r = rt.player.velocity();
  if (!r.ok) return haltDriveUnsupported(rt, "player.velocity", r.error);
  return r.value;
}

/** A BlockReader over the LIVE world (no cache) — the act-on-truth source for the veto. Also the
 *  reader the mine target-solver uses to prefer a SIDE stand for an exposed ore (solveMiningTarget). */
export function liveReader(rt: Runtime): (x: number, y: number, z: number) => string | null {
  return (x, y, z) => {
    const r = rt.world.blockId({ x, y, z });
    return r.ok ? r.value : null;
  };
}
