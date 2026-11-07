import { EYE_HEIGHT } from "@/core/prim/movement-physics";
import { cellCenter, encodePos } from "@/core/prim/pos";
import type { Runtime } from "@/core/runtime/Runtime";
import type { Face, Vec3 } from "@/core/runtime/types";
// break-cell — the ONE AIM→BREAK state machine for breaking a single block with the native async
// breaker, shared by every mining phase (MINE vein-follow, DESCEND shaft, DIG_TO staircase). It
// was copy-pasted three times and they drifted: MINE's copy forgot to `lookAt` the target, so it
// could only break whatever the crosshair happened to face (fine horizontally, but it could NOT
// mine straight up/down). breakBlockAsync breaks the block the player LOOKS at, not setTarget's
// coords, so the lookAt is mandatory — centralising it
// here means no phase can forget it again.
import type { Config } from "@/shared/config/schema";
import { ensureToolFor } from "@/shared/held";
import { mustSetRotation, mustYaw } from "@/shared/nav/core";

const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);

/** The per-block break state. A phase's run-slice embeds these fields (it may carry more of its
 *  own, e.g. step counters); `freshBreakRun()` seeds them. Keyed by the packed target pos so a
 *  new target restarts the machine and the timeout is per-BLOCK, not per-phase. */
export interface BreakRun {
  forKey: string;
  sub: "AIM" | "BREAK";
  issued: boolean;
  broken: boolean;
  startTick: number;
}

export function freshBreakRun(): BreakRun {
  return { forKey: "", sub: "AIM", issued: false, broken: false, startTick: 0 };
}

const FACE_NORMALS: readonly Vec3[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];

/** The point to aim the break raycast at: the centre of the target's most eye-facing EXPOSED
 *  face, falling back to the cell centre when no exposed face points at the eye. Aiming at the
 *  raw cell centre sends the ray through whatever occludes that line — a half-buried stump aimed
 *  "through" its dirt side made the bot dig the dirt first instead of hitting the visible free
 *  face (live). A face is hittable only if its neighbor cell is CONFIRMED air (unknown
 *  = occluded, the senses null-convention) and its outward normal points toward the eye. The
 *  chosen point sits 0.45 out from the centre — just inside the face plane, so the ray terminates
 *  on the target, not the neighbor. Exported for tests. */
export function visibleAimPoint(isAir: (p: Vec3) => boolean | null, target: Vec3, eye: Vec3): Vec3 {
  const c = cellCenter(target);
  let best: Vec3 | null = null;
  let bestDot = 0.05; // faces near-parallel to the sight line are grazing shots — skip them
  for (const n of FACE_NORMALS) {
    if (isAir({ x: target.x + n.x, y: target.y + n.y, z: target.z + n.z }) !== true) continue;
    const fc = { x: c.x + n.x * 0.5, y: c.y + n.y * 0.5, z: c.z + n.z * 0.5 };
    const toEye = { x: eye.x - fc.x, y: eye.y - fc.y, z: eye.z - fc.z };
    const len = Math.hypot(toEye.x, toEye.y, toEye.z) || 1;
    const dot = (toEye.x * n.x + toEye.y * n.y + toEye.z * n.z) / len;
    if (dot > bestDot) {
      bestDot = dot;
      best = { x: c.x + n.x * 0.45, y: c.y + n.y * 0.45, z: c.z + n.z * 0.45 };
    }
  }
  return best ?? c;
}

/** Aim at a cell to break it. For an angled target, lookAt is fine. But for a target directly
 *  above/below (horizontal distance ≈ 0), jsMacros' lookAt DEGENERATES — the zero horizontal
 *  component makes its yaw/pitch math return the wrong pitch (it aims DOWN at a block straight
 *  overhead — live-diagnosed). So for a vertical target, keep the current yaw and set
 *  the pitch explicitly (−90 up / +90 down). This is what lets MINE/DESCEND/DIG_TO break straight
 *  up and down. Exported: the water-clutch reflex aims its bucket at the landing floor through
 *  the same vertical-aware path (a bucket raycast fails the same way a break raycast does). */
export function aimAt(rt: Runtime, cfg: Config, target: Vec3): void {
  const posR = rt.player.pos();
  if (!posR.ok) {
    void rt.interact.lookAt(cellCenter(target));
    return;
  }
  const pos = posR.value;
  const horiz = Math.hypot(target.x + 0.5 - pos.x, target.z + 0.5 - pos.z);
  const up = target.y + 0.5 > pos.y + EYE_HEIGHT;
  // lookAt degenerates ONLY for a straight-OVERHEAD target — its zero-horizontal math returns +90
  // (aims DOWN) for a block straight up, so for UP we keep the explicit setRotation(−90). For
  // straight DOWN lookAt's "+90" is CORRECT, and unlike an exact setRotation(yaw, 90) it reliably
  // raycasts ONTO the cell: live-diagnosed — a surface snow_block under an exact pitch-90
  // never registered as looked-at, breakBlockAsync no-op'd, and DESCEND spun silently for minutes;
  // a lookAt at the cell centre (pitch ≈90) broke it at once. So only UP needs setRotation now.
  if (horiz >= cfg.nav.breakVerticalEps || !up) {
    // Angled/below target: aim at the exposed face toward the eye, not blindly at the centre.
    const eye = { x: pos.x, y: pos.y + EYE_HEIGHT, z: pos.z };
    const isAir = (p: Vec3): boolean | null => {
      const r = rt.world.blockId(p);
      return r.ok ? AIR.has(r.value) : null;
    };
    void rt.interact.lookAt(visibleAimPoint(isAir, target, eye));
    return;
  }
  // Straight-up aim: keep the real yaw (never a fabricated 0) and make the pitch land, or end the
  // drive — an aim that silently did not land breaks whatever is in the crosshair (nav/core.ts).
  mustSetRotation(rt, mustYaw(rt), -90);
}

export type BreakOutcome =
  | "working" // still aiming / breaking this tick
  | "cleared" // the target block is gone (this tick or a prior AOE) — caller advances
  | "timeout"; // overran the aim+break budget — caller decides (SCAN / ERROR / skip)

/** Drive ONE tick of breaking `target` (looking AT it first, so any direction works — up, down,
 *  sideways). Mutates `run`. The caller owns the terminal handling: on "cleared" advance/tally,
 *  on "timeout" recover per its policy. An unreadable target is treated as NOT air (keep
 *  breaking) — only a confirmed air read counts as cleared, never a fake. */
export function stepBreak(
  rt: Runtime,
  cfg: Config,
  tick: number,
  run: BreakRun,
  target: Vec3,
  face: Face,
  breakBudgetTicks?: number, // per-block break budget override (default cfg.nav.mineBreakTimeoutTicks)
): BreakOutcome {
  const key = encodePos(target.x, target.y, target.z);
  const idR = rt.world.blockId(target);
  if (run.forKey !== key) {
    run.forKey = key;
    run.sub = "AIM";
    run.issued = false;
    run.broken = false;
    run.startTick = tick;
    // A fresh target: equip the RIGHT tool for the block (wood→axe, sand→shovel, stone/ore→
    // pickaxe family) before we try to break it. This also covers the prospector gotcha — the
    // bot's own prospect/scan leaves the prospector (a non-tool) selected, and "breaking" ore
    // with it is a silent no-op that otherwise only surfaces as a break timeout.
    ensureToolFor(rt, idR.ok ? idR.value : null);
  }
  // The WORLD read is authoritative: only a confirmed-air target counts as "cleared". The async
  // breaker's done-callback (run.broken) is a HINT, not proof — a premature/rejected callback that
  // fired with the block still solid used to latch "cleared" forever (the silent surface-snow stall).
  if (idR.ok && AIR.has(idR.value)) {
    rt.mine.cancel();
    return "cleared";
  }
  if (run.broken) {
    // Callback said done but the block is still here → re-arm a fresh break (re-issued below). The
    // age timeout stays the backstop, so a truly unbreakable cell ESCALATES (→"timeout") not spins.
    run.broken = false;
    run.issued = false;
  }
  const age = tick - run.startTick;
  if (run.sub === "AIM") {
    aimAt(rt, cfg, target); // reliability-ok: re-aimed each AIM tick (vertical-aware)
    rt.mine.setTarget(target, face);
    if (age >= cfg.nav.mineAimTicks) run.sub = "BREAK";
    return "working";
  }
  if (!run.issued) {
    run.issued = true;
    aimAt(rt, cfg, target); // re-assert the aim the AIM ticks set (vertical-aware)
    rt.mine.breakAsync(target, () => {
      run.broken = true;
    });
  }
  if (age > cfg.nav.mineAimTicks + (breakBudgetTicks ?? cfg.nav.mineBreakTimeoutTicks)) {
    rt.mine.cancel();
    return "timeout";
  }
  return "working";
}
