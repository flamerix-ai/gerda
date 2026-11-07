import {
  type MissionStep,
  ORCH_SLICE,
  type OrchState,
  type Plan,
  type StepMode,
} from "@/bot/orchestrator/plan";
import { PlanRegistry } from "@/bot/orchestrator/plan-registry";
import { asRecord } from "@/core/prim/typed-object";
// Orchestrator — the meta-mission layer. An ALWAYS-ON capability (survives mission
// swaps, like mission-control) that runs a Plan: an ordered list of mission steps.
// It chains the next mission either autonomously (mode `auto`) or on an AI/operator
// command (`proceed`/`run`/`step`/`select`), gating each transition on the step's
// guards. It does this WITHOUT breaking the single-active-mission invariant — it is
// not itself a mission; it installs a MissionSequencer the kernel consults on
// completion, and drives `kernel.startMission`/`abortMission` for everything else.
//
// Two halves share one closure: the `cap` (commands + plan state) and the
// `sequencer` (decides what runs next when a mission completes). Both reach the plan
// state through the ORCH_SLICE blackboard slice, which survives mission switches.
import type { Capability, Ctx, Kernel } from "@/shared/kernel/capability";
import type { MissionSequencer, SequencerDecision } from "@/shared/kernel/sequencer";

function resolveParams(step: MissionStep, prev: Record<string, unknown>): Record<string, unknown> {
  const p = step.params;
  // typeof-function narrows the union to ParamBinding (a Record is never callable).
  if (typeof p === "function") return p(prev);
  return p ?? {};
}

function effectiveMode(orch: OrchState, plan: Plan, step: MissionStep): StepMode {
  return orch.modeOverride ?? step.mode ?? plan.defaultMode ?? "auto";
}

function checkGuards(
  ctx: Ctx,
  step: MissionStep,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  for (const g of step.guards ?? []) {
    const r = g.check(ctx);
    if (!r.ok) return r;
  }
  return { ok: true };
}

/** Resolve `select {step}` — a numeric index or a step `id`. */
function resolveStepIndex(plan: Plan, arg: unknown): number | null {
  if (typeof arg === "number" && arg >= 0 && arg < plan.steps.length) return arg;
  if (typeof arg === "string") {
    const idx = plan.steps.findIndex((s) => s.id === arg);
    return idx >= 0 ? idx : null;
  }
  return null;
}

export interface Orchestrator {
  readonly cap: Capability;
  readonly sequencer: MissionSequencer;
  readonly plans: PlanRegistry;
}

export function makeOrchestrator(kernel: Kernel, planList: readonly Plan[] = []): Orchestrator {
  const plans = new PlanRegistry();
  for (const p of planList) plans.register(p);

  const missionExists = (name: string): boolean => kernel.missionNames().includes(name);

  const block = (ctx: Ctx, orch: OrchState, idx: number, mission: string, reason: string): void => {
    orch.status = "blocked";
    orch.blockedReason = `step ${idx} (${mission}): ${reason}`;
    ctx.log.info(ctx.st.tickCount, "ORCH_BLOCKED", { step: idx, mission, reason });
  };

  const fail = (ctx: Ctx, orch: OrchState, reason: string): void => {
    orch.status = "failed";
    orch.blockedReason = reason;
    ctx.log.err(ctx.st.tickCount, "ORCH_FAILED", { reason });
  };

  const finish = (ctx: Ctx, orch: OrchState): void => {
    orch.status = "done";
    ctx.log.info(ctx.st.tickCount, "ORCH_DONE", { plan: orch.plan?.name ?? null });
  };

  // Command-side: start step `idx` NOW (aborts any current mission via startMission).
  // `resetCounters` is true for a fresh step and false for a retry of the same step (so
  // the retry budget / repeat count survive). Wrapped so a bad plan (unknown mission /
  // throwing binding) parks in `failed` instead of escaping as a CoreFatalError
  // (orchestrator commands run as owner=core).
  const launchStep = (ctx: Ctx, idx: number, resetCounters: boolean): void => {
    const orch = ctx.slice(ORCH_SLICE);
    const plan = orch.plan;
    if (!plan) return;
    if (idx < 0 || idx >= plan.steps.length) {
      finish(ctx, orch);
      return;
    }
    const step = plan.steps[idx];
    if (!step) {
      finish(ctx, orch);
      return;
    }
    // reliability-ok: the orchestrator runs as owner=core, so a throw from a plan's
    // mission name / param binding / guard would become a CoreFatalError and halt the
    // worker. Parking the plan in `failed` is the correct boundary — a bad plan (author
    // data) must not take core down. This is the orchestrator's plan-input boundary.
    try {
      const g = checkGuards(ctx, step);
      if (!g.ok) {
        block(ctx, orch, idx, step.mission, g.reason);
        return;
      }
      if (!missionExists(step.mission)) {
        fail(ctx, orch, `unknown mission: ${step.mission}`);
        return;
      }
      orch.cursor = idx;
      orch.status = "running";
      orch.blockedReason = null;
      if (resetCounters) {
        orch.attempt = 0;
        orch.repeatCount = 0;
      }
      const params = resolveParams(step, orch.lastResult);
      ctx.log.info(ctx.st.tickCount, "ORCH_STEP_START", {
        step: idx,
        mission: step.mission,
        params,
        attempt: orch.attempt,
      });
      kernel.startMission(ctx.st, step.mission, params);
    } catch (e) {
      fail(ctx, orch, String(e));
    }
  };

  const startStep = (ctx: Ctx, idx: number): void => launchStep(ctx, idx, true);

  // Guard-side: detect that the CURRENT step's mission terminally failed (landed in
  // ERROR) and apply the step's failure policy — retry up to `retries`, else branch to
  // `onFail`, else fail the plan. Only acts while orchestrating (status "running"), so a
  // non-orchestrated mission left in ERROR for inspection is untouched.
  const handleFailure = (ctx: Ctx): boolean => {
    const orch = ctx.slice(ORCH_SLICE);
    const plan = orch.plan;
    if (!plan || orch.status !== "running" || ctx.st.phase !== "ERROR") return false;
    const step = plan.steps[orch.cursor];
    if (!step) return false;

    if (orch.attempt < (step.retries ?? 0)) {
      orch.attempt++;
      ctx.log.info(ctx.st.tickCount, "ORCH_RETRY", {
        step: orch.cursor,
        mission: step.mission,
        attempt: orch.attempt,
        of: step.retries ?? 0,
      });
      launchStep(ctx, orch.cursor, false); // re-run same step, keep the spent attempts
      return true;
    }
    if (step.onFail !== undefined) {
      const idx = resolveStepIndex(plan, step.onFail);
      if (idx !== null) {
        ctx.log.info(ctx.st.tickCount, "ORCH_ONFAIL", { from: orch.cursor, to: idx });
        startStep(ctx, idx);
        return true;
      }
    }
    fail(ctx, orch, `step ${orch.cursor} (${step.mission}) failed after ${orch.attempt} retries`);
    kernel.abortMission(ctx.st); // clear the errored mission so the bot leaves ERROR
    return true;
  };

  // Sequencer-side: decide what runs after `completedName` finishes. Returns a decision
  // the KERNEL applies (it must NOT call startMission itself — that would double-start).
  // LOOP — if the completed step should run again (`repeatWhile` still passes, or `repeat`
  // count not reached), return a re-run decision (fresh retry budget); else null to advance.
  const repeatDecision = (
    ctx: Ctx,
    orch: OrchState,
    cur: MissionStep,
  ): SequencerDecision | null => {
    orch.repeatCount++;
    const more = cur.repeatWhile
      ? cur.repeatWhile.check(ctx).ok
      : orch.repeatCount < (cur.repeat ?? 1);
    if (!more) return null;
    if (!missionExists(cur.mission)) {
      fail(ctx, orch, `unknown mission: ${cur.mission}`);
      return { kind: "idle" };
    }
    orch.attempt = 0;
    orch.status = "running";
    ctx.log.info(ctx.st.tickCount, "ORCH_REPEAT", {
      step: orch.cursor,
      mission: cur.mission,
      iteration: orch.repeatCount,
    });
    return { kind: "next", mission: cur.mission, params: resolveParams(cur, orch.lastResult) };
  };

  // BRANCH — the completed step picks the next index from its outputs; else linear advance.
  // Returns a step index, or a "done"/"fail" sentinel (the caller has already been parked).
  const resolveNextIdx = (
    ctx: Ctx,
    orch: OrchState,
    plan: Plan,
    cur: MissionStep,
    outputs: Record<string, unknown>,
  ): number | "done" | "fail" => {
    if (!cur.next) return orch.cursor + 1;
    const sel = cur.next(outputs);
    if (sel === null) {
      finish(ctx, orch);
      return "done";
    }
    if (sel === undefined) return orch.cursor + 1;
    const j = resolveStepIndex(plan, sel);
    if (j === null) {
      fail(ctx, orch, `bad next target from step ${orch.cursor}: ${String(sel)}`);
      return "fail";
    }
    return j;
  };

  // Advance to `nextIdx`: finish if past the end, park if approve-mode / guard-blocked,
  // else start it (resetting the per-step retry+repeat budgets). Returns the decision the
  // kernel applies.
  const advanceTo = (ctx: Ctx, orch: OrchState, plan: Plan, nextIdx: number): SequencerDecision => {
    const step = nextIdx < plan.steps.length ? plan.steps[nextIdx] : undefined;
    if (!step) {
      finish(ctx, orch);
      return { kind: "idle" };
    }
    if (effectiveMode(orch, plan, step) === "approve") {
      orch.status = "awaiting-approval";
      ctx.log.info(ctx.st.tickCount, "ORCH_AWAIT", { next: nextIdx, mission: step.mission });
      return { kind: "idle" };
    }
    const g = checkGuards(ctx, step);
    if (!g.ok) {
      block(ctx, orch, nextIdx, step.mission, g.reason);
      return { kind: "idle" };
    }
    if (!missionExists(step.mission)) {
      fail(ctx, orch, `unknown mission: ${step.mission}`);
      return { kind: "idle" };
    }
    orch.cursor = nextIdx;
    orch.status = "running";
    orch.blockedReason = null;
    orch.attempt = 0; // fresh step → fresh retry + repeat budgets
    orch.repeatCount = 0;
    const params = resolveParams(step, orch.lastResult);
    ctx.log.info(ctx.st.tickCount, "ORCH_STEP_START", {
      step: nextIdx,
      mission: step.mission,
      params,
    });
    return { kind: "next", mission: step.mission, params };
  };

  // Sequencer-side: decide what runs after `completedName` finishes. Returns a decision
  // the KERNEL applies (it must NOT call startMission itself — that would double-start).
  const decideNext = (
    ctx: Ctx,
    completedName: string,
    outputs: Record<string, unknown>,
  ): SequencerDecision => {
    const orch = ctx.slice(ORCH_SLICE);
    const plan = orch.plan;
    // Not orchestrating (manual mission_start, or plan idle/done/blocked) → normal IDLE.
    if (!plan || orch.status !== "running") return { kind: "idle" };
    orch.lastResult = outputs;

    // Ad-hoc `select {mission}` run → hand back to approval, don't advance the plan.
    if (orch.adhoc) {
      orch.adhoc = false;
      orch.status = "awaiting-approval";
      ctx.log.info(ctx.st.tickCount, "ORCH_ADHOC_DONE", { mission: completedName });
      return { kind: "idle" };
    }

    const cur = plan.steps[orch.cursor];
    if (cur) {
      const loop = repeatDecision(ctx, orch, cur);
      if (loop) return loop;
    }
    const nx = cur ? resolveNextIdx(ctx, orch, plan, cur, outputs) : orch.cursor + 1;
    if (nx === "done" || nx === "fail") return { kind: "idle" };
    return advanceTo(ctx, orch, plan, nx);
  };

  const cmdPlanStart = (ctx: Ctx, cmd: Record<string, unknown>): void => {
    const orch = ctx.slice(ORCH_SLICE);
    const name = typeof cmd["name"] === "string" ? cmd["name"] : "";
    const plan = plans.get(name) ?? null;
    orch.plan = plan;
    orch.cursor = -1;
    orch.lastResult = {};
    orch.blockedReason = null;
    orch.adhoc = false;
    orch.modeOverride = null;
    if (!plan) {
      orch.status = "idle";
      ctx.log.err(ctx.st.tickCount, "ORCH_PLAN_UNKNOWN", { name, available: plans.names() });
      return;
    }
    const step0 = plan.steps[0];
    const mode = step0 ? (step0.mode ?? plan.defaultMode ?? "auto") : "auto";
    ctx.log.info(ctx.st.tickCount, "ORCH_PLAN_START", {
      plan: name,
      steps: plan.steps.length,
      mode,
    });
    if (mode === "auto") startStep(ctx, 0);
    else orch.status = "awaiting-approval";
  };

  const cmdProceed = (ctx: Ctx): void => {
    const orch = ctx.slice(ORCH_SLICE);
    if (orch.status !== "awaiting-approval" && orch.status !== "blocked") {
      ctx.log.info(ctx.st.tickCount, "ORCH_PROCEED_NOOP", { status: orch.status });
      return;
    }
    startStep(ctx, orch.cursor + 1);
  };

  const cmdRun = (ctx: Ctx): void => {
    const orch = ctx.slice(ORCH_SLICE);
    orch.modeOverride = "auto";
    if (orch.status === "awaiting-approval" || orch.status === "blocked") {
      startStep(ctx, orch.cursor + 1);
    }
  };

  const cmdStep = (ctx: Ctx): void => {
    const orch = ctx.slice(ORCH_SLICE);
    orch.modeOverride = "approve"; // stop after this single step
    if (orch.status === "awaiting-approval" || orch.status === "blocked") {
      startStep(ctx, orch.cursor + 1);
    }
  };

  const cmdSelect = (ctx: Ctx, cmd: Record<string, unknown>): void => {
    const orch = ctx.slice(ORCH_SLICE);
    const missionArg = cmd["mission"];
    if (typeof missionArg === "string" && missionArg) {
      if (!missionExists(missionArg)) {
        ctx.log.err(ctx.st.tickCount, "ORCH_SELECT_UNKNOWN", { mission: missionArg });
        return;
      }
      orch.adhoc = true;
      orch.status = "running";
      const params = asRecord(cmd["params"]);
      ctx.log.info(ctx.st.tickCount, "ORCH_SELECT_ADHOC", { mission: missionArg, params });
      // reliability-ok: same plan-input boundary as startStep — a startMission throw on
      // an ad-hoc mission parks the plan in `failed` rather than escalating to a
      // CoreFatalError (the orchestrator dispatches as owner=core).
      try {
        kernel.startMission(ctx.st, missionArg, params);
      } catch (e) {
        fail(ctx, orch, String(e));
      }
      return;
    }
    if (!orch.plan) {
      ctx.log.info(ctx.st.tickCount, "ORCH_SELECT_NOPLAN", {});
      return;
    }
    const idx = resolveStepIndex(orch.plan, cmd["step"]);
    if (idx === null) {
      ctx.log.err(ctx.st.tickCount, "ORCH_SELECT_BADSTEP", { step: cmd["step"] });
      return;
    }
    // Jump: the next completion advances from this index.
    orch.cursor = idx - 1;
    startStep(ctx, idx);
  };

  const cmdPlanAbort = (ctx: Ctx): void => {
    const orch = ctx.slice(ORCH_SLICE);
    orch.plan = null;
    orch.cursor = -1;
    orch.status = "idle";
    orch.blockedReason = null;
    orch.adhoc = false;
    orch.modeOverride = null;
    kernel.abortMission(ctx.st);
    ctx.log.info(ctx.st.tickCount, "ORCH_PLAN_ABORT", {});
  };

  const cmdPlanStatus = (ctx: Ctx): void => {
    const orch = ctx.slice(ORCH_SLICE);
    const plan = orch.plan;
    const current =
      plan && orch.cursor >= 0 && orch.cursor < plan.steps.length ? plan.steps[orch.cursor] : null;
    const status = {
      plan: plan?.name ?? null,
      cursor: orch.cursor,
      status: orch.status,
      blockedReason: orch.blockedReason,
      currentStep: current?.mission ?? null,
      activeMission: kernel.activeMission(),
      phase: ctx.st.phase,
    };
    // In the reply (result.data) as well as the journal: the bridge caller asked for it.
    ctx.reply(status);
    ctx.log.info(ctx.st.tickCount, "ORCH_STATUS", status);
  };

  const cmdPlans = (ctx: Ctx): void => {
    const available = plans.names();
    ctx.reply({ available });
    ctx.log.info(ctx.st.tickCount, "ORCH_PLANS", { available });
  };

  const cap: Capability = {
    name: "orchestrator",
    // Detect a step's mission landing in ERROR and apply retry / onFail / fail. Returns
    // true (short-circuit) only when it actually handled a failure this tick.
    guard: (ctx) => handleFailure(ctx),
    commands: {
      plan_start: cmdPlanStart,
      proceed: (ctx) => cmdProceed(ctx),
      continue: (ctx) => cmdProceed(ctx),
      run: (ctx) => cmdRun(ctx),
      step: (ctx) => cmdStep(ctx),
      select: cmdSelect,
      plan_abort: (ctx) => cmdPlanAbort(ctx),
      plan_status: (ctx) => cmdPlanStatus(ctx),
      plans: (ctx) => cmdPlans(ctx),
    },
  };

  const sequencer: MissionSequencer = {
    name: "orchestrator",
    onMissionComplete: (ctx, completedName, outputs) => decideNext(ctx, completedName, outputs),
  };

  return { cap, sequencer, plans };
}
