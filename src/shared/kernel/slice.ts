// Typed blackboard slices. A SliceKey<T> carries the slice's name AND its initializer,
// so `ctx.slice(key)` returns the right type with no string literal and no `as` cast at
// the call site. The stringly `st.bb["mining"] as MiningMem` pattern — where a typo
// silently allocates a fresh, wrong slice — is structurally impossible: a SliceKey<T> is
// the ONLY way to reach a slice, and its name+init can't drift apart.
import { ContractError } from "@/core/prim/invariant";

const registered = new Set<string>();

export interface SliceKey<T> {
  readonly name: string;
  readonly init: () => T;
}

/** Declare a blackboard slice once, at module load. Throws if two slices claim the same
 *  name (a collision would let one capability stomp another's scratch). */
export function defineSlice<T>(name: string, init: () => T): SliceKey<T> {
  if (registered.has(name)) {
    throw new ContractError(`duplicate slice name: ${name}`);
  }
  registered.add(name);
  return { name, init };
}
