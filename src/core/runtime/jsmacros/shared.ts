// Shared helpers for the jsMacros (GraalJS) runtime facets. The facade is split by facet
// (player/world/interact/io/hud/storage) but the whole `src/core/runtime/jsmacros/` group is ONE
// exempt boundary — the only place allowed to reference the jsMacros globals (types/jsmacros.d.ts)
// AND the only place allowed to `try/catch` (inside `attempt`): the single translation point from
// "FFI throws" to typed `Result`. Reads return `Result` (never a fabricated fallback a caller could
// mistake for real data); side-effects go through `fx`, which LOGS LOUDLY on failure.
import type { ItemStack } from "@/core/runtime/Runtime";
import { type Face, type Result, err, ok } from "@/core/runtime/types";

export const FACE_TO_DIR: Record<Face, string> = {
  TOP: "up",
  BOTTOM: "down",
  NORTH: "north",
  SOUTH: "south",
  EAST: "east",
  WEST: "west",
  CENTER: "up",
};

/** Reported when a side-effect or an internal container read fails — the facade screams
 *  (the worker wires this to the logger) instead of silently swallowing. */
export type FxReporter = (op: string, error: string) => void;

/** The error-translation trio every facet closes over. `attempt` is the single try/catch in the
 *  whole bundle; `fx` runs a must-happen side-effect and reports LOUDLY on failure; `readOr` is an
 *  internal read whose only sane degraded value is `empty` (still logged). */
export interface Fx {
  attempt<T>(fn: () => T): Result<T>;
  fx(op: string, fn: () => void): void;
  readOr<T>(op: string, fn: () => T, empty: T): T;
}

export function makeFx(report: FxReporter): Fx {
  const attempt = <T>(fn: () => T): Result<T> => {
    try {
      return ok(fn());
    } catch (e) {
      return err(String(e));
    }
  };
  return {
    attempt,
    fx(op, fn) {
      const r = attempt(fn);
      if (!r.ok) report(op, r.error);
    },
    readOr(op, fn, empty) {
      const r = attempt(fn);
      if (r.ok) return r.value;
      report(op, r.error);
      return empty;
    },
  };
}

export function stackOf(s: ItemStackHelper | null): ItemStack | null {
  if (!s || s.isEmpty()) return null;
  const max = s.getMaxDamage();
  const durabilityPct = max > 0 ? Math.round(((max - s.getDamage()) / max) * 100) : 100;
  return { id: s.getItemId(), count: s.getCount(), durabilityPct };
}

export function defaultReport(op: string, error: string): void {
  // Fallback when no logger is wired (e.g. early boot): still scream to stdout.
  const r = ((): Result<void> => {
    try {
      java.lang.System.out.println(`[Miner] FX_FAIL ${op}: ${error}`);
      return ok(undefined);
    } catch (e) {
      return err(String(e));
    }
  })();
  void r;
}
