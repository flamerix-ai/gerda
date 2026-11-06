// Typed `Object.entries`/`Object.keys` — `Object.entries` and `Object.keys` widen the
// key back to `string`, throwing away the literal-union key type a `Record<K, V>` /
// `Partial<Record<K, V>>` carries. Recovering it needs an `as` cast; this module is the
// ONE audited place that cast lives, so the kernel's FSM/handler tables iterate their
// keys with the right type and no per-call cast (each of which the defensive checker
// would otherwise flag). Leaf module: no imports.

export function entriesOf<K extends string, V>(o: Partial<Record<K, V>> | Record<K, V>): [K, V][] {
  // reliability-ok: Object.entries widens K→string; the Record<K,V> parameter type is
  // the contract that the keys are exactly K. Single controlled site for this cast.
  return Object.entries(o) as [K, V][];
}

export function keysOf<K extends string>(o: Partial<Record<K, unknown>> | Record<K, unknown>): K[] {
  // reliability-ok: Object.keys widens K→string; same contract as entriesOf.
  return Object.keys(o) as K[];
}

/** Narrow an untyped value (bridge param, parsed JSON) to a plain object, or {} if it
 *  isn't one. The single audited site for that cast — callers get a safe Record without
 *  writing their own `as`. */
export function asRecord(v: unknown): Record<string, unknown> {
  // reliability-ok: the typeof-object check IS the validation behind this cast.
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
