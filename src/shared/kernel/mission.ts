import { entriesOf } from "@/core/prim/typed-object";
// Mission — a pluggable goal state-machine. The kernel no longer
// hardcodes one mining FSM; instead it loads ALL missions into a registry and
// runs ONE active mission at a time, switchable at runtime (`mission_start`) with
// no reload. A mission brings its own phases/edges/handlers/guards; reflexes (L2)
// and global handlers (RECOVER, lifecycle) live in the kernel, mission-agnostic.
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { Fsm, type PartialTransitionTable } from "@/shared/kernel/fsm";
import type { Phase } from "@/shared/kernel/phase";
import type { ProgressMap, ProgressPolicy } from "@/shared/kernel/progress";
import { toPolicyList } from "@/shared/kernel/progress";

interface ParamSpec {
  readonly name: string;
  readonly type: "string" | "int" | "float" | "bool";
  readonly required?: boolean;
  readonly desc?: string;
}

/** A mission-scoped guard — installed/removed alongside the mission, so e.g. the
 *  mine mission's loot/inventory diverts never fire under a different mission. */
export interface MissionGuard {
  readonly name: string;
  guard(ctx: Ctx): boolean;
}

export interface Mission {
  readonly name: string;
  /** Declared params for `mission_start` (self-description). */
  readonly params?: readonly ParamSpec[];
  /** Mission-internal edges, merged with GLOBAL_EDGES + UNIVERSAL_TARGETS on start. */
  readonly edges: PartialTransitionTable<Phase>;
  readonly initialPhase: Phase;
  /** Phases where movement is bot-driven (Baritone). Reflexes query this via
   *  ctx.isMovementPhase() instead of hardcoding GOTO/HOME/RETURN. */
  readonly movementPhases?: ReadonlySet<Phase>;
  init?(ctx: Ctx, params: Record<string, unknown>): void;
  readonly handlers: Partial<Record<Phase, (ctx: Ctx) => void>>;
  readonly commands?: Record<string, (ctx: Ctx, cmd: Record<string, unknown>) => void>;
  readonly guards?: readonly MissionGuard[];
  /** Per-phase progress policies — the universal stall watchdog's per-phase POLICY,
   *  installed/removed with the mission. Merged from composed capabilities by missionFromCaps. */
  readonly progress?: ProgressMap;
  /** Checked after each tick's handler — true → mission complete → the sequencer decides
   *  what runs next (default: IDLE). */
  isDone?(ctx: Ctx): boolean;
  /** Stable result this mission exposes on completion (e.g. mine → `{lastVein:{x,y,z}}`).
   *  A sequencer reads it (while the mission is still active) to feed the next step's
   *  params. Keep it a declared shape, decoupled from the mission's internal slices. */
  outputs?(ctx: Ctx): Record<string, unknown>;
  /** Cleanup on switch/abort. */
  onAbort?(ctx: Ctx): void;
}

/** Assemble a Mission from a list of existing Capabilities — their handlers,
 *  guards, commands and edges are merged into one mission unit. Lets a mission be
 *  composed from focused capability modules (scan/navigation/mine/…) without the
 *  kernel registering them globally; each becomes mission-scoped (swapped in/out
 *  with the mission). Phase ownership is one-per-mission, same as the global rule. */
export function missionFromCaps(
  name: string,
  caps: readonly Capability[],
  opts: {
    readonly edges: PartialTransitionTable<Phase>;
    readonly initialPhase: Phase;
    readonly movementPhases?: ReadonlySet<Phase>;
    readonly params?: readonly ParamSpec[];
    /** Mission-level init, run AFTER every cap's init (so it can seed shared slice state
     *  from the mission_start params — e.g. the harvest profile + goal count). */
    init?(ctx: Ctx, params: Record<string, unknown>): void;
    isDone?(ctx: Ctx): boolean;
    outputs?(ctx: Ctx): Record<string, unknown>;
    onAbort?(ctx: Ctx): void;
  },
): Mission {
  const handlers: Partial<Record<Phase, (ctx: Ctx) => void>> = {};
  const commands: Record<string, (ctx: Ctx, cmd: Record<string, unknown>) => void> = {};
  const guards: MissionGuard[] = [];
  const progress: Partial<Record<Phase, ProgressPolicy[]>> = {};
  const edgeTables: PartialTransitionTable<Phase>[] = [opts.edges];

  for (const cap of caps) {
    if (cap.edges) edgeTables.push(cap.edges);
    if (cap.guard) {
      const g = cap.guard;
      guards.push({ name: cap.name, guard: (ctx: Ctx) => g(ctx) });
    }
    for (const [phase, fn] of entriesOf<Phase, (ctx: Ctx) => void>(cap.handlers ?? {})) {
      if (handlers[phase]) {
        throw new Error(`mission ${name}: phase ${phase} owned twice (adding ${cap.name})`);
      }
      handlers[phase] = fn;
    }
    for (const [type, fn] of Object.entries(cap.commands ?? {})) commands[type] = fn;
    for (const [phase, decl] of entriesOf<Phase, ProgressPolicy | readonly ProgressPolicy[]>(
      cap.progress ?? {},
    )) {
      const list = progress[phase] ?? [];
      list.push(...toPolicyList(decl));
      progress[phase] = list;
    }
  }

  // Optionals are added conditionally (not assigned `undefined`) to satisfy
  // exactOptionalPropertyTypes — an absent option must mean "key absent", not
  // "key present and undefined".
  return {
    name,
    edges: Fsm.merge<Phase>(...edgeTables),
    initialPhase: opts.initialPhase,
    init(ctx: Ctx, params: Record<string, unknown>): void {
      for (const cap of caps) cap.init?.(ctx, params);
      opts.init?.(ctx, params);
    },
    handlers,
    commands,
    guards,
    progress,
    ...(opts.params !== undefined ? { params: opts.params } : {}),
    ...(opts.movementPhases !== undefined ? { movementPhases: opts.movementPhases } : {}),
    ...(opts.isDone !== undefined ? { isDone: opts.isDone } : {}),
    ...(opts.outputs !== undefined ? { outputs: opts.outputs } : {}),
    ...(opts.onAbort !== undefined ? { onAbort: opts.onAbort } : {}),
  };
}
