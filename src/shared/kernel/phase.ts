// The kernel's phase vocabulary — deliberately OPEN.
//
// The kernel drives a phase machine; it does not know WHICH phases exist. That catalog is
// pack/bot data (mining has DESCEND and EXCAVATE, an arena fighter would have PARRY and
// RETREAT), so it is injected as a PhaseCatalog rather than imported from a shared union.
// Only the four LIFECYCLE phases are kernel-owned, because the kernel itself drives them:
// it lands in IDLE on init, guards divert to PAUSED/ERROR, and the recover capability owns
// RECOVER. Everything else is the bot's.
//
// `Phase = string` rather than a generic `S extends string` threaded through Kernel/Ctx/
// BotState: the generic is viral (every Ctx, every capability, every mission, every test
// signature) and buys type safety the bot ALREADY has where it matters — mission modules
// declare their own edge tables against their own `State` union, so a typo'd phase name is
// still a compile error at the site a human types it. What the union cannot check — an edge
// pointing at a phase NO mission handles — the catalog validation below catches at boot,
// fail-loud. Net: strictly more checking than before, at the tier boundary rather than
// through it.
import { ContractError } from "@/core/prim/invariant";
import type { PartialTransitionTable } from "@/shared/kernel/fsm";

export type Phase = string;

/** The phases the KERNEL itself drives. Every catalog must contain these. */
export const LIFECYCLE = {
  IDLE: "IDLE",
  RECOVER: "RECOVER",
  PAUSED: "PAUSED",
  ERROR: "ERROR",
} as const;

export type LifecyclePhase = (typeof LIFECYCLE)[keyof typeof LIFECYCLE];

/** The safety landings a reflex must NOT re-trigger on top of (it's already handled).
 *  Purely lifecycle, so it is kernel-owned: centralized here so the reflexes stop each
 *  declaring their own copy (which drifted). A resumable interrupt (EAT) is deliberately
 *  NOT here — an emergency (vitals/air/hazard/death) MUST still preempt an in-progress meal. */
export const REFLEX_SETTLED: ReadonlySet<Phase> = new Set([
  LIFECYCLE.RECOVER,
  LIFECYCLE.PAUSED,
  LIFECYCLE.ERROR,
]);

/** The bot's phase vocabulary, handed to the Kernel at construction. */
export interface PhaseCatalog {
  /** Every legal phase name. The validation set — an edge naming anything else is a boot error. */
  readonly all: ReadonlySet<Phase>;
  /** Reachable from ANY phase (emergency landings + enter-from-anywhere interrupts). */
  readonly universalTargets: readonly Phase[];
  /** Edges true regardless of which mission is active. */
  readonly globalEdges: PartialTransitionTable<Phase>;
  /** Exempt from the progress watchdog's default feet-position backstop. */
  readonly stallExempt: ReadonlySet<Phase>;
  /** Resumable interrupts: each gets an edge back to EVERY phase of the active mission, so it
   *  can hand control to the exact phase it suspended rather than the mission's initial one. */
  readonly interruptPhases: readonly Phase[];
}

/** Fail-loud catalog well-formedness — runs once at Kernel construction. */
export function assertCatalog(cat: PhaseCatalog): void {
  for (const p of Object.values(LIFECYCLE)) {
    if (!cat.all.has(p)) {
      throw new ContractError(`phase catalog is missing the kernel-owned lifecycle phase '${p}'`);
    }
  }
  const known = (p: Phase, where: string): void => {
    if (!cat.all.has(p)) throw new ContractError(`phase catalog: unknown phase '${p}' in ${where}`);
  };
  for (const p of cat.universalTargets) known(p, "universalTargets");
  for (const p of cat.interruptPhases) known(p, "interruptPhases");
  for (const p of cat.stallExempt) known(p, "stallExempt");
  for (const [from, targets] of Object.entries(cat.globalEdges)) {
    known(from, "globalEdges (source)");
    for (const to of targets ?? []) known(to, `globalEdges['${from}']`);
  }
}

/** Every phase named by an edge table must exist in the catalog — catches a mission or
 *  capability declaring an edge to a phase nothing handles (the gap the old shared union
 *  could not see, since every name in it type-checked whether or not it was reachable). */
export function assertEdgesKnown(
  cat: PhaseCatalog,
  edges: PartialTransitionTable<Phase>,
  where: string,
): void {
  for (const [from, targets] of Object.entries(edges)) {
    if (!cat.all.has(from)) {
      throw new ContractError(`${where}: edge table declares unknown phase '${from}'`);
    }
    for (const to of targets ?? []) {
      if (!cat.all.has(to)) {
        throw new ContractError(`${where}: edge '${from}' → unknown phase '${to}'`);
      }
    }
  }
}
