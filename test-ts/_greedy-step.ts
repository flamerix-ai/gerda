import type { Runtime } from "@/core/runtime/Runtime";
import type { Vec3 } from "@/core/runtime/types";
// For a test that asks what a leg does once its route is known (not a test file). A route search
// spans worker ticks while the bot holds still (cfg.nav.planReadsPerTick), so one tick can end with
// the search still running; these run the tick again until it has its answer.
import type { Config } from "@/shared/config/schema";
import { type GreedyOpts, greedyStep, navSearchPending } from "@/shared/nav";
import type { GreedyStep } from "@/shared/nav/core";

const MAX_TICKS = 1000;

/** Run `tick` once, then again while a route search it opened is still running. */
export function untilSearchEnds(tick: () => void): void {
  tick();
  for (let i = 1; navSearchPending(); i++) {
    if (i >= MAX_TICKS) throw new Error(`the route search did not end in ${MAX_TICKS} ticks`);
    tick();
  }
}

/** greedyStep, called again until the route search it opened has its answer. */
export function greedyStepPlanned(
  rt: Runtime,
  cfg: Config,
  target: Vec3,
  opts?: GreedyOpts,
): GreedyStep {
  let r = greedyStep(rt, cfg, target, opts);
  for (let i = 1; navSearchPending(); i++) {
    if (i >= MAX_TICKS) throw new Error(`the route search did not end in ${MAX_TICKS} ticks`);
    r = greedyStep(rt, cfg, target, opts);
  }
  return r;
}
