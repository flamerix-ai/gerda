// Command-param parsing SSOT. Missions receive their params as a
// `Record<string, unknown>` off the bridge — always the same three shapes to normalize:
// an id-list (JSON array / CSV / bare string), an integer coordinate/count, and the
// set form of an id-list. Every mission used to fork these; this is the one home.

/** Normalize an id-list param into a de-namespaced-agnostic `string[]` of non-empty ids.
 *  Accepts an array (filtered to non-empty strings), a JSON-array string (`["a","b"]`,
 *  guarded parse → falls through to CSV on malformed input), a comma-separated string, or
 *  anything else → `[]`. Superset of the old `parseItems`/`parseTargets` copies. */
export function parseIdList(raw: unknown): string[] {
  if (Array.isArray(raw))
    return raw.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (typeof raw !== "string") return [];
  const t = raw.trim();
  if (t.length === 0) return [];
  if (t.startsWith("[")) {
    // reliability-ok: parse boundary — a malformed list param is user input, not a kernel
    // fault; we narrow by Array.isArray + non-empty-string filter and fall through to CSV.
    try {
      const arr: unknown = JSON.parse(t);
      if (Array.isArray(arr))
        return arr.filter((v): v is string => typeof v === "string" && v.length > 0);
      // reliability-ok: malformed JSON list param is user input — fall through to CSV, not a fault.
    } catch {
      // malformed JSON → CSV fallback below
    }
  }
  return t
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** A strict integer param: the value only when it is a finite JS number, else `null`. */
export function intParam(p: Record<string, unknown>, k: string): number | null {
  const v = p[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A coercing integer param with a default: finite number → truncated, numeric string →
 *  parsed, anything else → `dflt`. */
export function intParamOr(p: Record<string, unknown>, k: string, dflt: number): number {
  const v = p[k];
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return dflt;
}

/** The set form of `parseIdList` — the whitelist/target-set shape callers build inline. */
export function toSet(raw: unknown): Set<string> {
  return new Set(parseIdList(raw));
}
