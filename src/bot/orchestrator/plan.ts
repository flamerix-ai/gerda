// Plan model — a plan is DATA: an ordered list of mission steps the orchestrator
// runs one after another. Each step names a mission, optional params (static or
// bound to the previous step's outputs), optional transition guards, and a drive
// mode (auto-advance vs wait-for-approval). Mirrors how states/edges are data.
import type { Ctx } from "@/shared/kernel/capability";
import { type SliceKey, defineSlice } from "@/shared/kernel/slice";

/** How a step is entered: `auto` chains immediately on the prior step's completion;
 *  `approve` parks at `awaiting-approval` until a `proceed`/`run` command. */
export type StepMode = "auto" | "approve";

/** Compute a step's params from the previous step's `outputs` (mine→coords→fetch). */
export type ParamBinding = (prev: Record<string, unknown>) => Record<string, unknown>;

/** A transition guard — a named predicate evaluated before a step starts. A failing
 *  guard blocks the chain (the operator sees it in `plan_status`). */
export interface StepGuardSpec {
  readonly name: string;
  check(ctx: Ctx): { readonly ok: true } | { readonly ok: false; readonly reason: string };
}

/** Branch the chain from a step's outputs: return the id/index of the next step to run,
 *  or `null` to finish the plan. `undefined` falls through to linear advance. */
type NextSelector = (prev: Record<string, unknown>) => string | number | null | undefined;

export interface MissionStep {
  readonly mission: string;
  readonly params?: Record<string, unknown> | ParamBinding;
  readonly guards?: readonly StepGuardSpec[];
  readonly mode?: StepMode;
  /** Optional label for `select {step:"<id>"}` jumps and branch targets. */
  readonly id?: string;
  // ── control flow (architecture flexibility) ──
  /** LOOP: run this step up to N times on success before advancing (default 1). */
  readonly repeat?: number;
  /** LOOP-until: keep re-running this step on success WHILE this guard passes (overrides
   *  `repeat`). E.g. "mine again while the inventory still has room". */
  readonly repeatWhile?: StepGuardSpec;
  /** RETRY: if the step's mission terminally fails (ERROR), re-run it up to N times
   *  before giving up (default 0 = no retry). */
  readonly retries?: number;
  /** BRANCH on success: choose the next step from this step's outputs. Overrides linear
   *  advance; `null` finishes the plan. */
  readonly next?: NextSelector;
  /** BRANCH on failure: step id/index to jump to once retries are exhausted. Absent →
   *  the plan fails. */
  readonly onFail?: string | number;
}

export interface Plan {
  readonly name: string;
  readonly steps: readonly MissionStep[];
  /** Drive mode when a step doesn't override it (default: `auto`). */
  readonly defaultMode?: StepMode;
}

type OrchStatus =
  | "idle" // no plan loaded
  | "running" // a step's mission is active
  | "awaiting-approval" // parked between steps, waiting for proceed/run
  | "blocked" // a step guard failed
  | "done" // plan finished
  | "failed"; // a step could not start (unknown mission / binding threw)

export interface OrchState {
  plan: Plan | null;
  /** Index of the last STARTED step (-1 = none started yet). */
  cursor: number;
  status: OrchStatus;
  /** Outputs of the most recently completed step, fed to the next step's ParamBinding. */
  lastResult: Record<string, unknown>;
  blockedReason: string | null;
  /** A `select {mission}` ad-hoc run (not a plan step) — on completion, hand back to
   *  approval rather than advancing the plan cursor. */
  adhoc: boolean;
  /** Set by `run` (→ auto) / `step` (→ approve) to override the per-step mode. */
  modeOverride: StepMode | null;
  /** Retry attempts already spent on the CURRENT step's mission (reset per step). */
  attempt: number;
  /** Successful runs of the CURRENT step so far, for `repeat`/`repeatWhile` (reset per step). */
  repeatCount: number;
}

export const ORCH_SLICE: SliceKey<OrchState> = defineSlice<OrchState>("orchestrator", () => ({
  plan: null,
  cursor: -1,
  status: "idle",
  lastResult: {},
  blockedReason: null,
  adhoc: false,
  modeOverride: null,
  attempt: 0,
  repeatCount: 0,
}));
