import type { Runtime } from "@/core/runtime/Runtime";
import type { Vec3 } from "@/core/runtime/types";
// — Descent recoverability guard (viability-kernel / RCSPP) ————————————————————————————————————————
// A drop is cheap + unconditional (gravity); climbing back is dear + conditional (pillar needs filler,
// ladder needs a ladder). Left unchecked the greedy executor follows cheap drops DOWN into a ravine and
// can't get out (live: a surface search sank a bot 30 blocks into a pit, then wedged). The
// guard refuses a descending step that would sink the bot deeper below the leg's high-water "rim" than
// it can recover — recoverable depth = a free scramble allowance (cfg.nav.maxDescentBelowRim) + carried
// filler (one pillar block per block of climb-back, counted ONLY when cfg.nav.pillar can actually place). It
// fires ONLY below the goal's own Y, so a genuinely-downward goal (a mine shaft) still descends freely;
// a ladder descent is exempt upstream (reversible by climbing). The planner's descentPenalty is the soft
// bias toward not approaching a pit; THIS is the hard stop. rim is a per-leg high-water mark of feet.y.
import type { Config } from "@/shared/config/schema";
import { fillerStatus } from "@/shared/nav/supply";

interface DescentGuard {
  goalKey: string;
  rimY: number;
}
let descentGuard: DescentGuard = { goalKey: "", rimY: 0 };

/** Track the leg's rim (highest feet Y) — reset on a new goal, else raise the high-water mark. */
export function updateDescentRim(goalKey: string, feetY: number): void {
  if (descentGuard.goalKey !== goalKey) descentGuard = { goalKey, rimY: feetY };
  else if (feetY > descentGuard.rimY) descentGuard.rimY = feetY;
}

/** PURE decision: would stepping from `feetY` into `nextY` sink the bot below what it can climb back?
 *  `rimY` = the leg's high-water feet Y; recoverable depth below it = `allowance` (free scramble) +
 *  `filler` (one pillar block per block of climb). Exempts non-descending steps and any step that stays
 *  at/above `goalY` (a genuinely-downward goal still descends freely). No Runtime — unit/property tested. */
export function descentBeyondBudget(
  rimY: number,
  feetY: number,
  nextY: number,
  goalY: number,
  allowance: number,
  filler: number,
): boolean {
  if (nextY >= feetY) return false; // not descending
  if (nextY >= goalY) return false; // still at/above the goal's level → heading toward it, allow
  return rimY - nextY > allowance + filler;
}

/** True when stepping into `next` would sink the bot below the recoverable budget (the descent veto). */
export function descentUnrecoverable(
  rt: Runtime,
  cfg: Config,
  feet: Vec3,
  next: Vec3,
  goalY: number,
): boolean {
  if (!cfg.nav.descentGuard) return false;
  const filler = cfg.nav.pillar ? fillerStatus(rt, cfg).count : 0;
  return descentBeyondBudget(
    descentGuard.rimY,
    feet.y,
    next.y,
    goalY,
    cfg.nav.maxDescentBelowRim,
    filler,
  );
}
