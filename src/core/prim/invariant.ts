// Fail-loud invariants — the SSOT for "this cannot be absent here". Use `must`/`assert`
// at points where a condition is logically guaranteed (a length check upstream, a
// freshly-built array, an enforced precondition) instead of an `as T` assertion or a
// silent fallback that fabricates a plausible value when the assumption breaks.
//
// A broken invariant throws a `ContractError` — the kernel classifies it at the tick
// boundary: a CORE violation (kernel/facade/reflex/global capability) HALTS the worker
// loudly; a MISSION violation drops that mission to ERROR. Either way the bot screams
// instead of limping on a corrupt state. Domain-pure: no runtime/jsMacros imports.

/** Thrown by every fail-loud primitive. The kernel `instanceof`-checks this to tell a
 *  contract violation (a bug → halt/ERROR) from an ordinary Error. */
export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

/** A movement-critical facade call (steer, ground contact, velocity) failed, so the drive cannot
 *  know where it is heading or whether it stands on anything. The caller has ALREADY released every
 *  movement key; this error then ends the drive loudly. It is a ContractError, so the kernel drops
 *  a mission to ERROR (a core owner halts the worker). The typical cause is a runtime the bot does
 *  not support — Fabric or NeoForge, where the Forge SRG members do not exist (docs/PORTABILITY.md).
 *  Walking on regardless is never an option: measured on Fabric, `goto` walked straight
 *  along yaw 0 and fell 19 blocks. `code` is the greppable reason in MISSION_FATAL / worker fatal. */
export class RuntimeUnsupportedError extends ContractError {
  readonly code = "RUNTIME_UNSUPPORTED";
  constructor(op: string, detail: string) {
    super(
      `RUNTIME_UNSUPPORTED: ${op} failed (${detail}) — movement keys released, drive stopped. Not on Forge 1.20.1 SRG? See docs/PORTABILITY.md`,
    );
    this.name = "RuntimeUnsupportedError";
  }
}

/** A CORE contract violation that the worker cannot recover from — the kernel rethrows
 *  any exception escaping a global/reflex/kernel owner wrapped as this, and worker.js
 *  catches it to HALT the managed worker and publish the fatal status (so `get_state`
 *  shows exactly what broke instead of the bot silently limping on a corrupt state). */
export class CoreFatalError extends Error {
  constructor(
    message: string,
    readonly detail: { readonly owner: string; readonly phase: string; readonly tick: number },
  ) {
    super(message);
    this.name = "CoreFatalError";
  }
}

/** Assert a value is present (not null/undefined), returning it narrowed. Throws on a
 *  broken assumption rather than letting `undefined` propagate as a real value. */
export function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new ContractError(`invariant: ${message}`);
  }
  return value;
}

/** Assert a boolean precondition holds. Narrows `cond` for the compiler on the success
 *  path; throws loudly otherwise. */
export function assert(cond: boolean, message: string): asserts cond {
  if (!cond) {
    throw new ContractError(`assert: ${message}`);
  }
}

/** Exhaustiveness guard for discriminated unions — the `default` branch passes the
 *  value here so a new variant becomes a compile error (never type) AND a loud throw. */
export function unreachable(value: never, message: string): never {
  throw new ContractError(`unreachable: ${message} (${String(value)})`);
}
