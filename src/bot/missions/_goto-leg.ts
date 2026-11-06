// The mission GOTO-leg SSOT. Every "walk to a fixed stand, then arrive / time-out /
// give-up-when-blocked" mission phase used to inline the same greedyStep + verdict switch, each copy
// handling `blocked` slightly differently (a real behaviour-drift surface). `walkTo` is the ONE
// driver: it owns the arrival-radius check, the phase timeout, the greedy step and its
// `arrived | blocked_no_path` verdict; the CALLER supplies what to do at each outcome via callbacks,
// so a mission's exact arrive/skip/finish policy stays its own.
//
// Deliberately NOT used by interact (its timeout is mission-start-relative, not phase-relative, and
// its blocked case interacts-anyway when already within reach) nor by hunt/follow (moving targets,
// re-path each tick) — those legs are bespoke, by design: leave what doesn't fit cleanly.
import { dist } from "@/core/prim/pos";
import type { Vec3 } from "@/core/runtime/types";
import type { Ctx } from "@/shared/kernel/capability";
import { greedyStep, isBlocked } from "@/shared/nav";

/** How the leg arrived — within the arrival radius up front, or via a greedy "arrived" verdict. Lets
 *  a caller log a different note for the two (the goto/prospect distinction) while most ignore it. */
export type ArriveVia = "radius" | "greedy";

export interface WalkLeg {
  /** Reached the target (within `arrivalDist`, or greedy reported "arrived"). */
  onArrive: (via: ArriveVia) => void;
  /** Greedy reported no path forward this tick. */
  onBlocked: () => void;
  /** The phase exceeded `timeoutTicks`. Defaults to `onBlocked` when omitted (most missions treat a
   *  timeout and a hard block identically). */
  onTimeout?: () => void;
  /** Arrival radius (default `cfg.nav.gotoArrivalDist`). */
  arrivalDist?: number;
  /** Phase-tick budget before the leg times out (default `cfg.nav.gotoTimeoutTicks`). */
  timeoutTicks?: number;
}

/** Drive one tick of a walk toward `target`: arrive → onArrive, phase-timeout → onTimeout (or
 *  onBlocked), a `blocked_no_path` greedy verdict → onBlocked. A column (Y-free), best-effort
 *  approach — the shared shape of the goto/fetch/stash/prospect/storage/loot-run/search GOTO legs. */
export function walkTo(ctx: Ctx, target: Vec3, leg: WalkLeg): void {
  const { rt, cfg, st } = ctx;
  const arrivalDist = leg.arrivalDist ?? cfg.nav.gotoArrivalDist;
  const timeoutTicks = leg.timeoutTicks ?? cfg.nav.gotoTimeoutTicks;

  const posR = rt.player.pos();
  if (posR.ok && dist(posR.value, target) <= arrivalDist) {
    leg.onArrive("radius");
    return;
  }
  if (st.phaseTicks > timeoutTicks) {
    (leg.onTimeout ?? leg.onBlocked)();
    return;
  }
  const step = greedyStep(rt, cfg, target, {
    column: true,
    bestEffort: true,
    arrivalRadius: arrivalDist,
    log: ctx.log,
  });
  if (step === "arrived") leg.onArrive("greedy");
  else if (isBlocked(step)) leg.onBlocked();
}
