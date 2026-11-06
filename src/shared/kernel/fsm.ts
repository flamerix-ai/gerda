// Declarative finite-state machine. The transition table IS the spec — illegal
// edges throw instead of silently corrupting state (the old code let any handler
// return any phase string with nothing validating it).
//
// Capabilities contribute their own states/edges into one table at registration;
// the `TRANSITIONS` table in states.ts is the single source of truth for the
// legal-edge graph — there is no separate diagram that could drift from it.
import { entriesOf, keysOf } from "@/core/prim/typed-object";

type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

/** A capability's edge contribution — only the `from` states it extends. */
export type PartialTransitionTable<S extends string> = Readonly<Partial<Record<S, readonly S[]>>>;

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`illegal transition ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export class Fsm<S extends string> {
  private readonly universal: ReadonlySet<S>;

  constructor(
    private readonly table: PartialTransitionTable<S>,
    universal: readonly S[] = [],
  ) {
    this.universal = new Set(universal);
  }

  /**
   * Legal if: re-entering the same state, the target is a universal/emergency
   * target (HOME/PAUSED/ERROR — reachable from anywhere, the old "any -> X"
   * guards), or the edge is declared in the table.
   */
  canTransition(from: S, to: S): boolean {
    if (from === to) return true;
    if (this.universal.has(to)) return true;
    return this.table[from]?.includes(to) ?? false;
  }

  assert(from: S, to: S): void {
    if (!this.canTransition(from, to)) {
      throw new IllegalTransitionError(from, to);
    }
  }

  states(): S[] {
    return keysOf(this.table);
  }

  /** Merge another table in (capability registration). Edges are unioned. */
  static merge<S extends string>(
    ...tables: (TransitionTable<S> | PartialTransitionTable<S>)[]
  ): TransitionTable<S> {
    const out: Record<string, Set<string>> = {};
    for (const table of tables) {
      for (const [from, edges] of entriesOf<S, readonly S[]>(table)) {
        let set = out[from];
        if (!set) {
          set = new Set();
          out[from] = set;
        }
        for (const to of edges) set.add(to);
      }
    }
    const result: Record<string, readonly string[]> = {};
    for (const [from, set] of Object.entries(out)) result[from] = [...set];
    // reliability-ok: `result` is freshly built from the S-keyed inputs above; the cast
    // re-applies the literal key type the Record<string,…> accumulator erased.
    return result as TransitionTable<S>;
  }
}
