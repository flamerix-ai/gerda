// Mission-sequencing seam — the single hook the kernel consults when a mission
// completes (its isDone → true). The default IDLE_SEQUENCER reproduces the kernel's
// original behaviour (collapse to IDLE); an orchestrator installs its own sequencer
// via Kernel.setSequencer() to chain the next mission. Exactly one sequencer is
// active. It is GLOBAL infra — not a mission — so it survives mission switches.
import type { Ctx } from "@/shared/kernel/capability";

/** What runs after a mission completes: start another mission, or go idle. */
export type SequencerDecision =
  | { readonly kind: "next"; readonly mission: string; readonly params?: Record<string, unknown> }
  | { readonly kind: "idle" };

export interface MissionSequencer {
  readonly name: string;
  /** Called once, synchronously, right after `missionDone` is emitted. `outputs` is the
   *  completed mission's declared `outputs(ctx)` (or `{}`), captured before it is torn
   *  down so the next step's params can bind to it. Reads world/inventory/plan state via
   *  `ctx` to pick the next step. It must NOT drive transitions itself — the kernel
   *  applies the decision through startMission/abortMission, preserving the
   *  single-active-mission invariant. */
  onMissionComplete(
    ctx: Ctx,
    completedName: string,
    outputs: Record<string, unknown>,
  ): SequencerDecision;
}

/** Default sequencer: collapse to IDLE on completion (the kernel's original behaviour,
 *  so installing this changes nothing). */
export const IDLE_SEQUENCER: MissionSequencer = {
  name: "idle",
  onMissionComplete: () => ({ kind: "idle" }),
};
