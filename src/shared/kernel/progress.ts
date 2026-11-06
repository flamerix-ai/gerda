import { encodePos, floorVec } from "@/core/prim/pos";
import type { Vec3 } from "@/core/runtime/types";
// The universal progress contract. ONE kernel-level watchdog kills the whole
// "silent wedge" bug class: a phase that loops forever making no progress with no timeout, so
// the bot looks alive (heartbeat OK, mission_status running) but is stuck. It had been fixed
// six times POINT-WISE, each re-implementing its own stall detection + recovery (excavate
// progress-signature, drill approach GOTO-stall, descend airborne/feet-Y, pillar CENTER wedge,
// goto_waypoint no-handler, nav airborne-replan). Root cause is ONE thing; the fix is ONE
// contract, enforced in the tick pipeline (Kernel.checkProgress), not a seventh point patch.
//
// Shape: DETECTION is universal (the kernel); RECOVERY is per-phase POLICY. A phase declares a
// ProgressPolicy — a cheap comparable `signature`, a `budgetTicks`, and an `onStall`
// disposition. The kernel records (signature, sinceTick) per active phase and, when the
// signature is frozen past budget, raises a loud, typed escalation (PHASE_STALLED log +
// phaseStalled bus event) and dispatches the policy's disposition. A phase that declares
// nothing gets a safe DEFAULT (the feet-position backstop → PAUSED, never a silent spin).
import type { Config } from "@/shared/config/schema";
import type { Ctx } from "@/shared/kernel/capability";
import type { Phase } from "@/shared/kernel/phase";

/** A cheap, comparable "am I advancing" value a phase reports each tick. */
export type ProgressSig = string | number;

/** The PAUSE signal a signature returns on a tick that must not COUNT toward the stall, yet must not
 *  erase the progress history either (a tick owned by something else — a guard that short-circuited
 *  the handler). The kernel shifts the stall clock forward by that tick: the frozen-run length and
 *  the monotonic best both carry across the pause. Distinct from `null` (EXEMPT = reset): a pause
 *  interleaved with frozen ticks must never re-arm the clock. */
export const PROGRESS_PAUSE: unique symbol = Symbol("progress-pause");
export type ProgressPause = typeof PROGRESS_PAUSE;

/** Recovery when the kernel detects a phase's progress signature has frozen past its budget.
 *  Detection is universal (kernel); this disposition is the per-phase POLICY that preserves each
 *  old ad-hoc detector's recovery ACTION:
 *   - "pause"   → transition to PAUSED (the safe default) — loud, recoverable, never silent.
 *   - "error"   → transition to ERROR (the phase opts into a hard fault).
 *   - "recover" → ctx.divert(RECOVER) — route through the RECOVER teleport-out + backoff.
 *   - {handle}  → a phase-specific recovery (skip-to-next-vein, offset→DIG_TO): the kernel fires
 *                 the loud escalation, then calls handle(ctx) to run the mission's own skip/redirect.
 *                 "skip a work unit" is expressed as a {handle} that advances the unit. */
export type StallDisposition =
  | "pause"
  | "error"
  | "recover"
  | { readonly handle: (ctx: Ctx) => void };

export interface ProgressPolicy {
  /** Label for the loud PHASE_STALLED log + the typed phaseStalled event. */
  readonly name: string;
  /** The progress signature this tick — whatever the phase already computes (packed feet position,
   *  blocks-mined count, a heartbeat tick a handler advances on progress, …). Return `null` to
   *  EXEMPT this tick: a legitimate hold / external wait / heartbeat where standing still is correct
   *  (the deliberate follow HOLD, an on-column descend, a peer-lost wait). An exempt tick resets the
   *  stall clock — the watchdog can never fire on a phase that is legitimately idle by design.
   *  Return PROGRESS_PAUSE to leave this tick OUT of the count without resetting (see there). */
  signature(ctx: Ctx): ProgressSig | ProgressPause | null;
  /** Ticks of a frozen (or, when `monotonic`, non-improving) signature tolerated before STALL. */
  budgetTicks(cfg: Config): number;
  /** Treat the signature as a monotonic progress metric (higher = more progress): the clock resets
   *  only on a STRICT improvement, so shuffling that changes the signature without advancing toward
   *  the goal still counts as stalled (the approach-toward-a-column case — greedy answers "moving"
   *  while the bot never gets closer). Default: equality (any change resets). */
  readonly monotonic?: boolean;
  /** What to do when stalled. Default "pause". */
  readonly onStall?: StallDisposition;
}

/** Per-phase progress policies, declared on a Capability/Mission alongside handlers. One or many
 *  per phase (a phase can have several sub-mode watchdogs, e.g. descend's airborne + feet-Y +
 *  approach — the kernel checks them in declaration order and fires the first that stalls). */
export type ProgressMap = Partial<Record<Phase, ProgressPolicy | readonly ProgressPolicy[]>>;

/** A MONOTONIC straight-line approach signature (drill descend-approach): negated, eps-quantized
 *  distance from `pos` to the centre of `cell` — closer = higher, so only a gain of ≥ eps resets a
 *  `monotonic` policy's clock (shuffling in place never does). `horizontal` drops Y (a column goal
 *  whose Y floats). It misreads any route that must lead away first; a routed leg measures progress
 *  along its route instead (mine goto-approach → navRouteProgress). */
export function approachSig(pos: Vec3, cell: Vec3, eps: number, horizontal: boolean): number {
  const dy = horizontal ? 0 : pos.y - cell.y;
  const dist = Math.hypot(pos.x - (cell.x + 0.5), dy, pos.z - (cell.z + 0.5));
  return -Math.floor(dist / Math.max(eps, 1e-6));
}

/** Normalise a single-or-array declaration to an array. */
export function toPolicyList(
  p: ProgressPolicy | readonly ProgressPolicy[],
): readonly ProgressPolicy[] {
  // reliability-ok: Array.isArray is the narrowing guard — the two branches ARE the array/single
  // discriminant, and Array.isArray widens a readonly tuple to any[], so we re-apply the element type.
  return Array.isArray(p) ? (p as readonly ProgressPolicy[]) : [p as ProgressPolicy];
}

/** Per-phase watchdog tracking state (one entry per active policy). Lives on BotState so the
 *  kernel is the single owner of "how long has the signature been frozen". */
export interface StallTrack {
  /** Last observed signature (null = none captured yet / exempt). */
  sig: ProgressSig | null;
  /** Tick the signature last CHANGED (equality) or last IMPROVED (monotonic) / was reset/exempt,
   *  shifted forward one tick per PROGRESS_PAUSE tick since. */
  since: number;
  /** Best signature seen so far — monotonic policies only (reset `since` only on a strict gain). */
  best: number;
}

export function freshTrack(tick: number): StallTrack {
  return { sig: null, since: tick, best: Number.NEGATIVE_INFINITY };
}

/** The universal BACKSTOP watchdog for a running work phase that declares no policy of its own: the
 *  bot must move its feet within budget or the phase is silently wedged. Feet position is the
 *  cheapest universal progress signal; stationary-by-design phases opt out via STALL_EXEMPT (they
 *  wait on a human or run their own bounded sub-step timeouts). Disposition = PAUSED (loud, safe,
 *  recoverable) — never a hard ERROR, never a silent continue. */
export const DEFAULT_STALL_POLICY: ProgressPolicy = {
  name: "feet",
  signature(ctx: Ctx): ProgressSig | null {
    const p = ctx.rt.player.pos();
    if (!p.ok) return null; // can't read position → exempt (never fire on a blind read)
    const f = floorVec(p.value);
    return encodePos(f.x, f.y, f.z);
  },
  budgetTicks: (cfg: Config) => cfg.safety.phaseStallTicks,
  onStall: "pause",
};
