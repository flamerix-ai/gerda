// Capability model + kernel tick pipeline. A capability is a self-describing
// plugin: it declares its FSM edges, an optional pre-dispatch guard (middleware),
// per-phase handlers, and commands. Adding behavior = adding one module and
// registering it — no kernel edits (LOOT touched 5 files in the legacy code).
//
// Two registration surfaces:
//   - register(cap)        → ALWAYS-ON capability (reflexes, lifecycle, persistence,
//                            hud, recover, mission-control). Lives for the process.
//   - registerMission(m)   → a pluggable goal-machine; ONE is active at a time, swapped
//                            at runtime via startMission()/abortMission() with no reload.
// Handler/guard/command lookup checks the active mission first, then the global maps.
//
// Reliability boundary: the kernel is the ONE place that catches exceptions from
// capability code, and it CLASSIFIES them by owner — a throw from a global/reflex/kernel
// owner is a CORE bug (rethrow CoreFatalError → worker halts + screams); a throw from a
// mission owner drops just that mission to ERROR (core stays alive). Guard/command
// errors are no longer swallowed. Resources a capability `requires` are resolved once
// per tick before its guard runs; if any is unavailable the guard is SKIPPED (never run
// half-ready) and the resolved values are injected as a typed `ctx.res(KEY)`.
import { ContractError, CoreFatalError } from "@/core/prim/invariant";
import { entriesOf } from "@/core/prim/typed-object";
import type { Runtime } from "@/core/runtime/Runtime";
import type { Config } from "@/shared/config/schema";
import type { Bus } from "@/shared/kernel/bus";
import { Fsm, type PartialTransitionTable } from "@/shared/kernel/fsm";
import { Lifecycle } from "@/shared/kernel/lifecycle";
import type { Logger } from "@/shared/kernel/logger";
import type { Mission, MissionGuard } from "@/shared/kernel/mission";
import { MissionRegistry } from "@/shared/kernel/mission-registry";
import {
  LIFECYCLE,
  type Phase,
  type PhaseCatalog,
  assertCatalog,
  assertEdgesKnown,
} from "@/shared/kernel/phase";
import {
  DEFAULT_STALL_POLICY,
  PROGRESS_PAUSE,
  type ProgressMap,
  type ProgressPause,
  type ProgressPolicy,
  type ProgressSig,
  type StallTrack,
  freshTrack,
  toPolicyList,
} from "@/shared/kernel/progress";
import type { ResourceKey } from "@/shared/kernel/resource";
import {
  IDLE_SEQUENCER,
  type MissionSequencer,
  type SequencerDecision,
} from "@/shared/kernel/sequencer";
import type { SliceKey } from "@/shared/kernel/slice";

/** Mutable blackboard. Core fields are typed; capabilities keep scratch in `bb`. */
/** Result of one command() dispatch, surfaced to the worker for a correlated bridge ack.
 *  `recognized` = a handler existed; `ok` = recognized AND it didn't fault to ERROR. */
export interface CommandOutcome {
  type: string;
  recognized: boolean;
  ok: boolean;
  phase: Phase;
  error?: string;
  /** Structured payload a command set via ctx.reply() — surfaced as `result.data` in the
   *  correlated bridge ack (e.g. mission_status returns the active mission as DATA, not
   *  just a log line). Absent when the command didn't reply. */
  data?: Record<string, unknown>;
}

/** One observed in-game chat line, already flattened to plain text at the jsMacros boundary
 *  (Module.onChat) — the raw RecvMessage event's TextHelper never travels below that seam, so
 *  capabilities and the pure parser stay jsMacros-free and testable. */
export interface ChatEvent {
  readonly text: string;
}

export interface BotState {
  phase: Phase;
  lastPhase: Phase;
  running: boolean;
  tickCount: number;
  phaseTicks: number;
  bb: Record<string, unknown>;
  /** Phase to return to after a maintenance interrupt (EAT) finishes — set by
   *  ctx.interrupt(), consumed by ctx.resume(). null when not mid-interrupt. */
  resumePhase: Phase | null;
  /** Per-tick decision tracing toggle (the `trace` command / cfg.traceTicks). When on,
   *  tick() emits a T:TICK line and ctx.trace() annotations flow to the journal; OFF =
   *  zero cost. A debug switch, not a tunable — defaults from cfg at mission start. */
  tracing: boolean;
  // Progress contract tracking — the kernel is the SINGLE owner of "how long has this
  // phase's progress signature been frozen". `stallPhase` is the phase the tracks are keyed to
  // (re-seeded on ANY phase change, detected in checkProgress, so no assignment site must remember);
  // `stallTracks` is parallel to the active phase's progress policies.
  stallPhase: Phase | null;
  stallTracks: StallTrack[];
}

export interface Ctx {
  readonly rt: Runtime;
  readonly log: Logger;
  readonly bus: Bus;
  readonly cfg: Config;
  readonly st: BotState;
  /** Validated phase change (throws on an illegal edge), logged + emitted. */
  transition(to: Phase, reason: string): void;
  /** Reflex divert: release inputs + #stop Baritone, then transition. The ONE place that
   *  does the stop-the-bot-then-bail dance — every reflex calls this so none can forget the
   *  #stop (the tool hard-stop did, leaving Baritone walking into ERROR) and every divert is
   *  logged (no more silent reflexes). */
  divert(to: Phase, reason: string): void;
  /** Maintenance interrupt: remember the current phase, then divert to a maintenance state
   *  (e.g. EAT). Pairs with resume() to return to the EXACT phase, not the mission start. */
  interrupt(to: Phase, reason: string): void;
  /** Finish a maintenance interrupt: transition back to the phase interrupt() saved (clears
   *  it). Falls back to the active mission's initial phase if nothing was saved. */
  resume(reason: string): void;
  /** Non-throwing legality check — use before a transition that may be illegal from the
   *  current phase (e.g. a user command issued from an arbitrary state) so it's handled
   *  gracefully instead of throwing exception-as-control-flow. */
  canTransition(to: Phase): boolean;
  /** Get-or-create a per-capability blackboard slice, keyed by a typed SliceKey
   *  (name + initializer travel together — no stringly access, no `as` cast). */
  slice<T>(key: SliceKey<T>): T;
  /** A resource the current capability declared in `requires`, already resolved for
   *  this tick (the guard only runs when all of them are available). Throws a
   *  ContractError if the key wasn't declared — you can't read a resource you didn't
   *  require. */
  res<T>(key: ResourceKey<T>): T;
  /** True if the active mission marks `phase` (default: current) as bot-driven
   *  (Baritone) movement. Reflexes query this instead of hardcoding GOTO/HOME/RETURN. */
  isMovementPhase(phase?: Phase): boolean;
  /** Re-enter the active mission's initial phase (no-op if no mission active). The
   *  resume/start lifecycle uses this so `core` needs no mission vocabulary. */
  toMissionStart(reason: string): void;
  /** The active mission's name, or null when idle — for capabilities whose behaviour
   *  differs between "a mission is waiting on me" and "nothing to hand back to" (e.g.
   *  recover parks a respawn-displaced MISSION but lets an idle bot settle in IDLE). */
  activeMission(): string | null;
  /** Register a teardown thunk run (once) on Module.stop, in reverse order. The place to
   *  release any context-pinning resource (jsMacros listener, Draw2D) so shutdown is
   *  declarative instead of a hand-maintained list in the entry point. */
  onStop(dispose: () => void): void;
  /** Attach a structured payload to the current command()'s correlated bridge ack
   *  (surfaced as `result.data`). For query commands that should answer with DATA, not
   *  just a journal line (e.g. mission_status). No-op outside a command dispatch. */
  reply(data: Record<string, unknown>): void;
  /** Emit a per-tick DECISION trace (event prefixed `T:`) — but ONLY when tracing is on
   *  (`trace {on}` / cfg.traceTicks); a no-op otherwise, so it's free to sprinkle on hot
   *  paths. The generalised form of the nav NAV_STEP instrumentation: annotate WHY a
   *  handler/guard chose what it did, surfaced in get_logs alongside the auto T:TICK line. */
  trace(event: string, fields?: Record<string, unknown>): void;
}

export interface Capability {
  readonly name: string;
  /** Extra legal edges this capability introduces. */
  readonly edges?: PartialTransitionTable<Phase>;
  /** Resources resolved (once per tick) before this capability's guard runs. If any is
   *  unavailable the guard is SKIPPED that tick — the guard body can assume every
   *  required resource is present via `ctx.res(KEY)`, no per-call `.ok` checks. */
  readonly requires?: readonly ResourceKey<unknown>[];
  /** `params` is the mission_start payload when this capability is mission-scoped (via
   *  missionFromCaps); always-on capabilities are inited with `{}`. Optional so a cap that
   *  ignores params can keep an `(ctx)` signature. */
  init?(ctx: Ctx, params: Record<string, unknown>): void;
  /** Runs before phase dispatch. Return true to short-circuit this tick. */
  guard?(ctx: Ctx): boolean;
  /** Heartbeat capability: its guard runs EVERY tick, even with no mission running
   *  (idle/paused), and its return value never short-circuits the tick. For
   *  observability sinks like telemetry that must keep emitting while the bot sits
   *  idle — without this they'd stop pushing and age out of the metrics store. Reflexes
   *  must NOT set this (a heartbeat can't preempt); a life-preservation reflex that must
   *  act while idle sets `survival` (below) instead. */
  readonly always?: boolean;
  /** Survival reflex: a normal preempting guard (CAN short-circuit + divert) that ALSO
   *  runs while NO mission is active — because keeping the body alive is not a mission
   *  concern. Only the life-preservation reflexes set this (death / air / swimOut /
   *  waterClutch / vitals); the mission-progress reflexes (tool / stuck / hunger / human)
   *  do NOT — they're meaningless with no task. Distinct from `always` (a heartbeat that
   *  never preempts): a survival guard runs in the normal `guards` pass when a mission is
   *  active, and additionally in an idle-only pass when it isn't (so it isn't double-run). */
  readonly survival?: boolean;
  readonly handlers?: Partial<Record<Phase, (ctx: Ctx) => void>>;
  readonly commands?: Record<string, (ctx: Ctx, cmd: Record<string, unknown>) => void>;
  /** Observed in-game chat (jsMacros RecvMessage, routed via Kernel.dispatchChat). Runs on the
   *  jsMacros LISTENER thread, NOT the tick thread: an implementation may only RECORD the line
   *  (enqueue it) and must leave every kernel/FSM/state mutation to a tick-thread guard that
   *  drains the queue — otherwise it races Kernel.tick mid-pass. Faults go through the same
   *  error-classifying boundary as commands under a NON-core `chat:<cap>` owner, so one bad
   *  line is a recoverable error and the fan-out continues to the remaining listeners. */
  onChat?(ctx: Ctx, ev: ChatEvent): void;
  /** Per-phase progress policies — the universal stall watchdog's per-phase POLICY. A
   *  phase declares a cheap signature + budget + recovery disposition; the kernel owns the
   *  freeze-detection. Absent → the feet-position DEFAULT backstop applies (unless STALL_EXEMPT). */
  readonly progress?: ProgressMap;
}

export function makeInitialState(): BotState {
  return {
    phase: "IDLE",
    lastPhase: "IDLE",
    running: false,
    tickCount: 0,
    phaseTicks: 0,
    bb: {},
    resumePhase: null,
    tracing: false,
    stallPhase: null,
    stallTracks: [],
  };
}

export class Kernel {
  private fsm: Fsm<Phase>;
  // Always-on (global) registrations — survive mission switches.
  private readonly extraTables: PartialTransitionTable<Phase>[];
  private readonly guards: Capability[] = [];
  // Heartbeat guards (cap.always) — run every tick regardless of `running`, before the
  // idle short-circuit, and never preempt. Kept separate so they aren't double-run by
  // the normal guard pass.
  private readonly alwaysGuards: Capability[] = [];
  // Survival guards (cap.survival) — the life-preservation reflexes. They live in `guards`
  // too (so the normal running pass runs them once), and are mirrored here so an idle/parked
  // bot can still run JUST them (not the mission-progress reflexes) to stay alive.
  private readonly survivalGuards: Capability[] = [];
  private readonly handlers = new Map<Phase, (ctx: Ctx) => void>();
  private readonly commands = new Map<string, (ctx: Ctx, cmd: Record<string, unknown>) => void>();
  // Capabilities that declared onChat — fanned out by dispatchChat. A list, not a map: chat is
  // OBSERVED, so every listener sees every line (unlike a command, which has one owner).
  private readonly chatCaps: Capability[] = [];
  // Progress policies, keyed by phase — global (always-on caps) and per-active-mission,
  // merged (mission first) by progressPoliciesFor. The feet DEFAULT backstop is a single shared
  // instance applied to a handled, non-exempt phase that declares nothing.
  private readonly progress = new Map<Phase, ProgressPolicy[]>();
  private readonly caps: Capability[] = [];

  // Mission layer — installed/cleared by startMission/abortMission.
  private readonly registry = new MissionRegistry();
  private active: Mission | null = null;
  private missionHandlers = new Map<Phase, (ctx: Ctx) => void>();
  private missionGuards: MissionGuard[] = [];
  private missionCommands = new Map<string, (ctx: Ctx, cmd: Record<string, unknown>) => void>();
  private missionProgress = new Map<Phase, ProgressPolicy[]>();

  // Mission sequencer — consulted when a mission completes to decide what runs next.
  // Default = IDLE_SEQUENCER (collapse to IDLE, the original behaviour). An orchestrator
  // installs its own via setSequencer(). GLOBAL infra: not a mission, survives switches.
  private sequencer: MissionSequencer = IDLE_SEQUENCER;

  // Outcome of the most recent command() call — surfaced to the worker so the bridge can
  // return a REAL ack (recognized? landed in ERROR?) instead of fire-and-forget "dispatched".
  // `lastDispatchError` is set by the dispatch boundary and read back here per command.
  private lastOutcome: CommandOutcome | null = null;
  private lastDispatchError: string | null = null;
  // Structured payload the current command set via ctx.reply() — reset per command(),
  // folded into lastOutcome.data so it rides the correlated ack back to the bridge.
  private lastReply: Record<string, unknown> | null = null;

  // Resources resolved for the capability currently being dispatched (set by the guard
  // loop right before each guard runs; read back through ctx.res). Single-threaded
  // synchronous dispatch makes this safe to reuse across guards within one tick.
  private activeRes = new Map<string, unknown>();

  // Teardown registry — capabilities register context-pinning resource disposers via
  // ctx.onStop; Module.stop drains it through dispose(). The #1 jsMacros hygiene rule.
  private readonly lifecycle = new Lifecycle();

  private readonly rt: Runtime;
  private readonly log: Logger;
  private readonly bus: Bus;
  private readonly cfg: Config;
  /** The BOT's phase vocabulary — the kernel owns only LIFECYCLE. */
  private readonly catalog: PhaseCatalog;

  constructor(
    rt: Runtime,
    log: Logger,
    bus: Bus,
    cfg: Config,
    catalog: PhaseCatalog,
    extraEdges: PartialTransitionTable<Phase>[] = [],
  ) {
    this.rt = rt;
    this.log = log;
    this.bus = bus;
    this.cfg = cfg;
    assertCatalog(catalog); // fail-loud at construction, not at the first bad transition
    this.catalog = catalog;
    for (const t of extraEdges) assertEdgesKnown(catalog, t, "Kernel(extraEdges)");
    this.extraTables = [...extraEdges];
    this.fsm = this.buildFsm();
  }

  // The global FSM is the catalog's global edges + always-on capability edges; while a
  // mission is active its edges are merged in too. Universal targets reach from anywhere.
  private buildFsm(): Fsm<Phase> {
    // While a mission is active, also allow RECOVER → its initial phase (the safety landing
    // hands control back after the teleport-out) and each catalog interrupt phase → EVERY
    // mission phase (a resumable interrupt returns to the EXACT phase it suspended, so it
    // needs an edge back to any of them).
    const act = this.active;
    const missionEdges: PartialTransitionTable<Phase>[] = act
      ? [
          act.edges,
          { [LIFECYCLE.RECOVER]: [act.initialPhase] },
          // Object.keys' string[] no longer needs a cast: Phase IS string, so the widened
          // kernel vocabulary removes the narrowing boundary this used to require.
          ...this.catalog.interruptPhases.map((p) => ({
            [p]: [...Object.keys(act.edges), act.initialPhase],
          })),
        ]
      : [];
    return new Fsm<Phase>(
      Fsm.merge<Phase>(this.catalog.globalEdges, ...this.extraTables, ...missionEdges),
      this.catalog.universalTargets,
    );
  }

  register(cap: Capability): this {
    this.caps.push(cap);
    // A capability can widen the FSM with its own edges (e.g. waypoint nav adds
    // IDLE/PAUSED → GOTO). Rebuild the machine so the new edges are legal.
    if (cap.edges) {
      assertEdgesKnown(this.catalog, cap.edges, `capability '${cap.name}'`);
      this.extraTables.push(cap.edges);
      this.fsm = this.buildFsm();
    }
    if (cap.guard) (cap.always ? this.alwaysGuards : this.guards).push(cap);
    if (cap.guard && cap.survival) this.survivalGuards.push(cap);
    for (const [phase, fn] of entriesOf<Phase, (ctx: Ctx) => void>(cap.handlers ?? {})) {
      if (this.handlers.has(phase)) {
        throw new Error(`phase ${phase} already owned by another capability (adding ${cap.name})`);
      }
      this.handlers.set(phase, fn);
    }
    for (const [type, fn] of Object.entries(cap.commands ?? {})) {
      this.commands.set(type, fn);
    }
    if (cap.onChat) this.chatCaps.push(cap);
    mergeProgress(this.progress, cap.progress);
    return this;
  }

  /** Load a mission into the registry (does not activate it). */
  registerMission(m: Mission): this {
    this.registry.register(m);
    return this;
  }

  /** Install the mission sequencer — what chains after a mission completes. Exactly one;
   *  last registration wins. Default is IDLE_SEQUENCER (collapse to IDLE). */
  setSequencer(s: MissionSequencer): this {
    this.sequencer = s;
    return this;
  }

  /** All registered mission names (for self-description / the `missions` command). */
  missionNames(): string[] {
    return this.registry.names();
  }

  /** The active mission's name, or null when idle. */
  activeMission(): string | null {
    return this.active?.name ?? null;
  }

  /** Activate a mission: install its handler/guard/command maps, rebuild the FSM with
   *  its edges, run its init, and seed its initial phase. Aborts any current mission
   *  first. The initial phase is set directly (a cross-machine jump, not a validated
   *  edge). The global blackboard is preserved so always-on state (persistence,
   *  counters) survives the switch; missions namespace their own slices. */
  startMission(st: BotState, name: string, params: Record<string, unknown> = {}): void {
    const m = this.registry.get(name);
    if (!m) throw new Error(`unknown mission: ${name}`);
    if (this.active) this.abortMission(st);

    assertEdgesKnown(this.catalog, m.edges, `mission '${name}'`);
    this.active = m;
    this.missionHandlers = new Map(entriesOf<Phase, (ctx: Ctx) => void>(m.handlers));
    this.missionGuards = m.guards ? [...m.guards] : [];
    this.missionCommands = new Map(Object.entries(m.commands ?? {}));
    this.missionProgress = new Map();
    mergeProgress(this.missionProgress, m.progress);
    this.fsm = this.buildFsm();

    const ctx = this.makeCtx(st);
    m.init?.(ctx, params);
    st.running = true;
    st.lastPhase = st.phase;
    st.phase = m.initialPhase;
    st.phaseTicks = 0;
    this.bus.emit("missionStarted", { name, params });
    this.log.info(st.tickCount, "MISSION_START", { name });
  }

  /** Deactivate the active mission (onAbort cleanup), clear its maps, and fall back to
   *  the global-only FSM in IDLE. No-op if no mission is active. */
  abortMission(st: BotState): void {
    this.endMission(st, "aborted");
  }

  /** The one teardown. `done` = the mission reached its goal (the completion path in tick()):
   *  same cleanup — onAbort releases what the mission holds — but logged MISSION_DONE and not
   *  reported as an abort. A finished goto used to log MISSION_ABORT right after GOTO_ARRIVED,
   *  and telemetry counted every completion in mission_aborted_total as well. */
  private endMission(st: BotState, how: "done" | "aborted"): void {
    if (!this.active) return;
    const name = this.active.name;
    try {
      this.active.onAbort?.(this.makeCtx(st));
    } catch (e) {
      this.log.err(st.tickCount, "MISSION_ABORT_ERROR", { name, error: String(e) });
    }
    this.active = null;
    this.missionHandlers = new Map();
    this.missionGuards = [];
    this.missionCommands = new Map();
    this.missionProgress = new Map();
    this.fsm = this.buildFsm();
    st.running = false;
    st.lastPhase = st.phase;
    st.phase = "IDLE";
    st.phaseTicks = 0;
    if (how === "done") {
      this.log.info(st.tickCount, "MISSION_DONE", { name });
      return;
    }
    this.log.info(st.tickCount, "MISSION_ABORT", { name });
    this.bus.emit("missionAborted", { name });
  }

  /** Names of every command registered globally + by the active mission (for
   *  self-description). */
  commandNames(): string[] {
    return [...new Set([...this.commands.keys(), ...this.missionCommands.keys()])];
  }

  /** Call once after all capabilities are registered. */
  init(st: BotState): void {
    const ctx = this.makeCtx(st);
    // Always-on caps carry no mission_start payload — they init with an empty params bag.
    for (const cap of this.caps) cap.init?.(ctx, {});
  }

  tick(st: BotState): BotState {
    st.tickCount++;
    st.phaseTicks++;
    // reliability-ok: probe an OPTIONAL test-only hook (the mock advances its clock); the
    // intersection cast just exposes the optional method, the `?.` guards its absence.
    (this.rt as Runtime & { __setTick?: (t: number) => void }).__setTick?.(st.tickCount);

    const ctx = this.makeCtx(st);
    if (st.tracing)
      this.log.trc(st.tickCount, "T:TICK", {
        phase: st.phase,
        mission: this.active?.name ?? null,
        running: st.running,
        phaseTicks: st.phaseTicks,
      });
    this.runAlwaysGuards(st, ctx); // heartbeat (telemetry) — flows even while idle
    if (!st.running) {
      // Idle/parked, but not defenceless: the SURVIVAL reflexes (death/air/swimOut/
      // waterClutch/vitals) still run so a bot that gets shoved into water or a fatal
      // fall with no active mission can still save itself. If one diverts to a safety
      // landing (RECOVER/PAUSED/ERROR), that landing's handler runs too — so an idle bot
      // can actually respawn/surface/teleport with no mission to resume.
      if (this.runSurvivalGuards(st, ctx)) return st;
      if (this.catalog.universalTargets.includes(st.phase)) this.runHandler(st, ctx);
      return st;
    }

    // A guard (reflex / mission guard) that short-circuits usually diverts (phase changes →
    // checkProgress re-seeds); a rare non-diverting short-circuit still gets its progress checked
    // below, so a guard that spins in place without advancing can't hide a wedge either.
    if (!this.runGuards(st, ctx)) {
      this.runHandler(st, ctx);

      // Mission self-completion: ask the sequencer what runs next once the goal is reached.
      // The default IDLE_SEQUENCER collapses to IDLE (original behaviour). The
      // !UNIVERSAL_TARGETS guard keeps a completion that coincides with a safety divert
      // (the handler ended in PAUSED/ERROR/RECOVER) from chaining out of the safety state.
      if (this.active && !this.catalog.universalTargets.includes(st.phase) && this.callDone(st)) {
        const completed = this.active.name;
        this.bus.emit("missionDone", { name: completed });
        const decision = this.runSequencer(st, completed);
        // A sequencer throw lands the phase in ERROR (onDispatchError) — don't override it.
        if (st.phase === "ERROR") return st;
        this.endMission(st, "done"); // retire it as DONE before the next starts (not an abort)
        if (decision.kind === "next")
          this.startMission(st, decision.mission, decision.params ?? {});
      }
    }
    // Universal progress contract: enforce it EVERY running tick, after guard-or-handler.
    this.checkProgress(st, ctx);
    return st;
  }

  // Consult the sequencer for the next step after a mission completes. A throw is
  // classified as a (non-core) mission-level fault → the phase lands in ERROR and we
  // fall back to idle; a bad next-mission decision never takes the worker down.
  private runSequencer(st: BotState, completed: string): SequencerDecision {
    try {
      // Capture the completing mission's outputs while it is still active, so the
      // sequencer can feed them into the next step's params.
      const outputs = this.active?.outputs?.(this.makeCtx(st)) ?? {};
      return this.sequencer.onMissionComplete(this.makeCtx(st), completed, outputs);
    } catch (e) {
      this.onDispatchError(`sequencer:${this.sequencer.name}`, "onMissionComplete", st, e);
      return { kind: "idle" };
    }
  }

  // Global guards (reflexes) preempt mission guards — safety before mission logic. Each
  // global guard's `requires` resources are resolved first; an unavailable resource
  // skips that guard for the tick (never run half-ready). Returns true if a guard
  // short-circuited the tick.
  // Heartbeat guards run every tick (idle or not) and never short-circuit — their
  // return is ignored. Same resource-resolution + error-isolation as normal guards.
  private runAlwaysGuards(st: BotState, ctx: Ctx): void {
    for (const cap of this.alwaysGuards) {
      const res = this.resolveRequires(cap.requires);
      if (!res) continue; // a required resource is unavailable this tick → skip
      this.activeRes = res;
      this.dispatch("core", cap.name, st, () => cap.guard?.(ctx) ?? false);
    }
    this.activeRes = EMPTY_RES;
  }

  // Idle-only survival pass: run JUST the life-preservation reflexes (cap.survival) when no
  // mission is active. Same resource-resolution + error-isolation as runGuards; no mission
  // guards (there's no mission). Returns true if one short-circuited the tick.
  private runSurvivalGuards(st: BotState, ctx: Ctx): boolean {
    for (const cap of this.survivalGuards) {
      const res = this.resolveRequires(cap.requires);
      if (!res) continue; // a required resource is unavailable this tick → skip
      this.activeRes = res;
      if (this.dispatch("core", cap.name, st, () => cap.guard?.(ctx) ?? false)) return true;
    }
    this.activeRes = EMPTY_RES;
    return false;
  }

  private runGuards(st: BotState, ctx: Ctx): boolean {
    for (const cap of this.guards) {
      const res = this.resolveRequires(cap.requires);
      if (!res) continue; // a required resource is unavailable this tick → skip
      this.activeRes = res;
      if (this.dispatch("core", cap.name, st, () => cap.guard?.(ctx) ?? false)) return true;
    }
    this.activeRes = EMPTY_RES;
    for (const mg of this.missionGuards) {
      if (this.dispatch(`mission:${mg.name}`, mg.name, st, () => mg.guard(ctx))) return true;
    }
    return false;
  }

  private runHandler(st: BotState, ctx: Ctx): void {
    const missionHandler = this.missionHandlers.get(st.phase);
    if (missionHandler) {
      this.dispatch(`mission:${this.active?.name ?? "?"}`, st.phase, st, () => {
        missionHandler(ctx);
        return false;
      });
      return;
    }
    const handler = this.handlers.get(st.phase);
    if (handler) {
      this.dispatch("core", st.phase, st, () => {
        handler(ctx);
        return false;
      });
    }
    // No handler-else branch: a RUNNING, non-STALL_EXEMPT phase with no handler is the goto_waypoint
    // no-handler wedge (mission-scoped phase reached with that mission not active). It makes zero
    // progress, so the universal feet-backstop (progressPoliciesFor applies the DEFAULT to ANY
    // non-exempt phase, handled or not) escalates it to PAUSED within cfg.safety.phaseStallTicks —
    // loud (PHASE_STALLED), recoverable, never an indefinite silent tick.
  }

  // The progress policies watching `phase`: mission-scoped first, then global. If none is declared
  // and the phase is a handled, non-STALL_EXEMPT work phase, the feet-position DEFAULT backstop
  // applies — so a running phase can NEVER silently spin (it either advances a signature or the
  // watchdog escalates). Exempt / handler-less phases get no watchdog here (the latter is a loud
  // contract violation in runHandler instead).
  private progressPoliciesFor(phase: Phase): ProgressPolicy[] {
    const declared = [
      ...(this.missionProgress.get(phase) ?? []),
      ...(this.progress.get(phase) ?? []),
    ];
    if (declared.length > 0) return declared;
    // Any non-exempt running phase gets the feet DEFAULT backstop — handled OR handler-less. A
    // handler-less non-exempt phase (the goto_waypoint wedge) makes no progress, so the backstop
    // escalates it to PAUSED within budget rather than letting it spin forever.
    return this.catalog.stallExempt.has(phase) ? EMPTY_POLICIES : DEFAULT_POLICY_LIST;
  }

  // Universal stall DETECTION. For the current running phase, compare each policy's
  // signature to the tracked value; a frozen (equality) / non-improving (monotonic) signature past
  // budget is a silent wedge → fireStall. Re-seeds tracking on ANY phase change (detected here, so
  // no phase-assignment site must remember). A null signature EXEMPTS the tick (legitimate hold →
  // reset); PROGRESS_PAUSE leaves the tick out of the count (the clock stands still, history kept).
  private checkProgress(st: BotState, ctx: Ctx): void {
    if (!st.running) return;
    const phase = st.phase;
    const policies = this.progressPoliciesFor(phase);
    if (st.stallPhase !== phase) {
      st.stallPhase = phase;
      st.stallTracks = policies.map(() => freshTrack(st.tickCount));
    }
    for (let i = 0; i < policies.length; i++) {
      const pol = policies[i];
      const tr = st.stallTracks[i];
      if (!pol || !tr) continue;
      // Signature computation is capability code (reads live world) → classify a throw by owner
      // via the dispatch boundary (core → CoreFatalError propagates out; mission → phase to ERROR).
      let sig: ProgressSig | ProgressPause | null = null;
      this.dispatch(this.progressOwner(phase), `progress:${pol.name}`, st, () => {
        sig = pol.signature(ctx);
        return false;
      });
      if (st.phase !== phase) return; // a signature throw re-landed the phase — stop checking
      if (sig === null) {
        // Exempt this tick — a legitimate hold/heartbeat. Reset the clock; never fire.
        tr.since = st.tickCount;
        tr.sig = null;
        continue;
      }
      if (sig === PROGRESS_PAUSE) {
        // Paused tick — owned by something else. Shift the clock past it (so it is not counted) but
        // keep sig/best: a pause interleaved with frozen ticks must not re-arm the clock.
        tr.since++;
        continue;
      }
      const improved = pol.monotonic
        ? typeof sig === "number" && sig > tr.best
        : tr.sig === null || sig !== tr.sig;
      if (improved) {
        tr.sig = sig;
        tr.since = st.tickCount;
        if (pol.monotonic && typeof sig === "number") tr.best = sig;
        continue;
      }
      if (st.tickCount - tr.since > pol.budgetTicks(this.cfg)) {
        // Re-arm before dispatching recovery so a disposition that stays in-phase (a {handle} skip)
        // gets a fresh budget instead of re-firing every tick.
        tr.since = st.tickCount;
        this.fireStall(st, ctx, phase, pol);
        return; // one stall action per tick; the phase likely changed
      }
    }
  }

  // Classify who owns a phase's progress recovery (mirrors runHandler): a mission-scoped phase's
  // {handle}/throw drops just that mission to ERROR; a global one is a core fault.
  private progressOwner(phase: Phase): string {
    return this.active && (this.missionProgress.has(phase) || this.missionHandlers.has(phase))
      ? `mission:${this.active.name}`
      : "core";
  }

  // Universal stall ESCALATION: loud PHASE_STALLED log + typed phaseStalled event, then
  // the per-phase recovery disposition (preserving each old ad-hoc detector's recovery ACTION). A
  // {handle} runs the mission's own skip/redirect through the dispatch boundary (error-classified);
  // a stall that can't be classified escalates to PAUSED loudly, never a silent continue.
  private fireStall(st: BotState, ctx: Ctx, phase: Phase, pol: ProgressPolicy): void {
    const budget = pol.budgetTicks(this.cfg);
    this.log.warn(st.tickCount, "PHASE_STALLED", { phase, policy: pol.name, budget });
    this.bus.emit("phaseStalled", { phase, policy: pol.name, budget });
    const d = pol.onStall ?? "pause";
    const reason = `stall:${pol.name}`;
    if (d === "recover") {
      ctx.divert(LIFECYCLE.RECOVER, reason);
    } else if (d === "error") {
      if (ctx.canTransition(LIFECYCLE.ERROR)) ctx.transition(LIFECYCLE.ERROR, reason);
    } else if (d === "pause") {
      if (ctx.canTransition(LIFECYCLE.PAUSED)) ctx.transition(LIFECYCLE.PAUSED, reason);
    } else {
      this.dispatch(this.progressOwner(phase), `stall:${pol.name}`, st, () => {
        d.handle(ctx);
        return false;
      });
    }
  }

  private callDone(st: BotState): boolean {
    return this.dispatch(
      `mission:${this.active?.name ?? "?"}`,
      "isDone",
      st,
      () => this.active?.isDone?.(this.makeCtx(st)) ?? false,
    );
  }

  command(st: BotState, cmd: { type: string; [k: string]: unknown }): BotState {
    const missionFn = this.missionCommands.get(cmd.type);
    const coreFn = missionFn ? undefined : this.commands.get(cmd.type);
    const recognized = !!(missionFn || coreFn);
    this.lastDispatchError = null;
    this.lastReply = null;
    if (missionFn) {
      this.dispatch(`mission:${this.active?.name ?? "?"}`, cmd.type, st, () => {
        missionFn(this.makeCtx(st), cmd);
        return false;
      });
    } else if (coreFn) {
      this.dispatch("core", cmd.type, st, () => {
        coreFn(this.makeCtx(st), cmd);
        return false;
      });
    }
    this.lastOutcome = {
      type: cmd.type,
      recognized,
      ok: recognized && this.lastDispatchError === null,
      phase: st.phase,
      ...(this.lastDispatchError ? { error: this.lastDispatchError } : {}),
      ...(this.lastReply ? { data: this.lastReply } : {}),
    };
    return st;
  }

  /** Fan an observed chat line out to every capability that declared `onChat`, each through the
   *  SAME error-classifying boundary as command() — chat is untrusted, human-typed input arriving
   *  off the tick thread, so a handler fault is isolated exactly like a bad bridge command's.
   *  Ownership is `chat:<cap>` (see chatOwner): a fault here lands as a recoverable error and the
   *  loop CONTINUES, so one throwing listener cannot blind the ones registered after it.
   *  Mirrors command()'s state-in/state-out signature (the state is mutated in place). */
  dispatchChat(st: BotState, ev: ChatEvent): BotState {
    for (const cap of this.chatCaps) {
      this.dispatch(chatOwner(cap.name), `onChat:${cap.name}`, st, () => {
        cap.onChat?.(this.makeCtx(st), ev);
        return false;
      });
    }
    return st;
  }

  /** Run ONE drained chat line's handling through the error boundary under the same non-core
   *  `chat:<cap>` owner as dispatchChat. The capability that owns the queue calls this from its
   *  tick-thread guard: the work is chat work, so a fault must be classified as a chat fault
   *  (recoverable) and not as a core bug of the guard pass it happens to run inside. */
  dispatchChatLine(st: BotState, cap: string, fn: () => void): void {
    this.dispatch(chatOwner(cap), `chatLine:${cap}`, st, () => {
      fn();
      return false;
    });
  }

  /** The most recent command()'s outcome (for the worker→bridge correlated ack). */
  lastCommandOutcome(): CommandOutcome | null {
    return this.lastOutcome;
  }

  // The ONE exception boundary for capability code. Runs `fn` and classifies any throw
  // by owner: a CORE owner ("core"/kernel/reflex) is an unrecoverable bug → rethrow as
  // CoreFatalError (worker.js halts + screams); a MISSION owner drops just that mission
  // to ERROR and keeps core alive. Errors are never swallowed.
  private dispatch(owner: string, label: string, st: BotState, fn: () => boolean): boolean {
    try {
      return fn();
    } catch (e) {
      // reliability-ok: the kernel IS the error-classification boundary — this is the
      // counterpart to the facade's single FFI catch, not defensive fallback code.
      return this.onDispatchError(owner, label, st, e);
    }
  }

  private onDispatchError(owner: string, label: string, st: BotState, e: unknown): boolean {
    const kind = e instanceof ContractError ? "contract" : "unexpected";
    // Record for command()'s outcome ack (a tick-pass fault overwrites it harmlessly —
    // it's only read synchronously right after a command() dispatch).
    this.lastDispatchError = String(e);
    if (owner === "core") {
      this.log.err(st.tickCount, "CORE_FATAL", { owner, label, kind, error: String(e) });
      throw new CoreFatalError(`core ${kind} at ${label}: ${String(e)}`, {
        owner,
        phase: st.phase,
        tick: st.tickCount,
      });
    }
    this.log.err(st.tickCount, "MISSION_FATAL", { owner, label, kind, error: String(e) });
    this.bus.emit("kernelError", { owner, label, error: String(e) });
    // Land the broken mission in ERROR (a UNIVERSAL_TARGET, always legal) so it stops
    // acting on corrupt state while core keeps answering status/get_state.
    if (st.phase !== "ERROR") {
      st.lastPhase = st.phase;
      st.phase = "ERROR";
      st.phaseTicks = 0;
    }
    return false;
  }

  // Resolve every resource a capability `requires`. Returns the resolved values keyed by
  // name, or null if ANY is unavailable (→ the caller skips that capability this tick).
  private resolveRequires(requires?: readonly ResourceKey<unknown>[]): Map<string, unknown> | null {
    if (!requires || requires.length === 0) return EMPTY_RES;
    const out = new Map<string, unknown>();
    for (const key of requires) {
      const r = key.resolve({ rt: this.rt });
      if (!r.ok) {
        this.log.trc(this.rt.tick(), "RES_SKIP", { res: key.name, error: r.error });
        return null;
      }
      out.set(key.name, r.value);
    }
    return out;
  }

  private makeCtx(st: BotState): Ctx {
    const transition = (to: Phase, reason: string): void => {
      this.fsm.assert(st.phase, to);
      this.log.transition(st.tickCount, st.phase, to, reason);
      this.bus.emit("phaseChanged", { from: st.phase, to, reason });
      st.lastPhase = st.phase;
      st.phase = to;
      st.phaseTicks = 0;
    };
    return {
      rt: this.rt,
      log: this.log,
      bus: this.bus,
      cfg: this.cfg,
      st,
      transition,
      divert: (to: Phase, reason: string): void => {
        this.rt.keys.releaseAll();
        this.rt.nav.stop();
        this.log.info(st.tickCount, "REFLEX_DIVERT", { from: st.phase, to, reason });
        transition(to, reason);
      },
      interrupt: (to: Phase, reason: string): void => {
        st.resumePhase = st.phase;
        this.rt.keys.releaseAll();
        this.rt.nav.stop();
        this.log.info(st.tickCount, "INTERRUPT", { suspended: st.phase, to, reason });
        transition(to, reason);
      },
      resume: (reason: string): void => {
        const back = st.resumePhase;
        st.resumePhase = null;
        if (back && this.fsm.canTransition(st.phase, back)) {
          transition(back, reason);
        } else if (this.active) {
          transition(this.active.initialPhase, reason);
        }
      },
      canTransition: (to: Phase): boolean => this.fsm.canTransition(st.phase, to),
      reply: (data: Record<string, unknown>): void => {
        this.lastReply = data;
      },
      trace: (event: string, fields?: Record<string, unknown>): void => {
        if (st.tracing) this.log.trc(st.tickCount, `T:${event}`, fields);
      },
      slice: <T>(key: SliceKey<T>): T => {
        if (!(key.name in st.bb)) st.bb[key.name] = key.init();
        // reliability-ok: the blackboard is a heterogeneous Record; the SliceKey<T> is the
        // typed contract that makes this the single, controlled narrowing point.
        return st.bb[key.name] as T;
      },
      res: <T>(key: ResourceKey<T>): T => {
        if (!this.activeRes.has(key.name)) {
          throw new ContractError(
            `resource "${key.name}" read but not declared in this capability's requires`,
          );
        }
        // reliability-ok: the resource was resolved (and type-checked) at the require
        // boundary; activeRes is the single narrowing point, mirroring slice().
        return this.activeRes.get(key.name) as T;
      },
      isMovementPhase: (phase?: Phase): boolean =>
        this.active?.movementPhases?.has(phase ?? st.phase) ?? false,
      toMissionStart: (reason: string): void => {
        if (this.active) transition(this.active.initialPhase, reason);
      },
      activeMission: (): string | null => this.active?.name ?? null,
      onStop: (dispose: () => void): void => {
        this.lifecycle.add(dispose);
      },
    };
  }

  /** Tear down every registered onStop thunk (call from Module.stop). Idempotent: the
   *  disposer list empties as it drains. */
  dispose(): void {
    this.lifecycle.disposeAll();
  }
}

// Chat is untrusted, human-typed input, so a fault while handling it is NEVER a core bug.
// Owning it as `chat:<cap>` keeps onDispatchError on the mission-level path (loud
// MISSION_FATAL + kernelError event + ERROR phase, core alive) instead of manufacturing a
// CoreFatalError that worker.js's chat listener can only swallow into a log line — a silent wedge.
function chatOwner(cap: string): string {
  return `chat:${cap}`;
}

// Shared empty resolution for capabilities that require nothing — never mutated.
const EMPTY_RES = new Map<string, unknown>();

// Shared immutable progress-policy lists (never mutated): the feet DEFAULT backstop and empty.
const DEFAULT_POLICY_LIST: ProgressPolicy[] = [DEFAULT_STALL_POLICY];
const EMPTY_POLICIES: ProgressPolicy[] = [];

// Merge a capability/mission's ProgressMap into a phase→policies map (union, mission + global can
// both contribute; multiple sub-mode policies per phase are concatenated in declaration order).
function mergeProgress(into: Map<Phase, ProgressPolicy[]>, pm: ProgressMap | undefined): void {
  if (!pm) return;
  for (const [phase, decl] of entriesOf<Phase, ProgressPolicy | readonly ProgressPolicy[]>(pm)) {
    const list = into.get(phase) ?? [];
    list.push(...toPolicyList(decl));
    into.set(phase, list);
  }
}
