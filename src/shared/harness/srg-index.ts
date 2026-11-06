// SRG name-inversion SSOT — the pure map logic behind the harness's `srg(class, member)` global
// (harness/ext.js). Forge 1.20.1 runs OBFUSCATED SRG member names (`m_7583_`, `f_92095_`);
// srg_names.json is the flat forward map `SRG token → "FQCN#member(params)" | "FQCN#field"` exported
// offline by scripts/dev/srg.py. Calling a raw vanilla method by its Mojang name means INVERTING that:
// `Mojang "Class#member" → SRG token`. Getting the inversion wrong (or a token silently rotting on a
// pack bump) is the single most expensive class of bug in this project (CLAUDE.md's SRG warning), so
// the inversion + the fail-loud lookup + the boot-time rot check all live here, TESTED, once.
//
// MIRROR: harness/safe-io.js publishes the byte-identical JS twin (`__MC_HARNESS.srg`);
// test-ts/harness-contract.test.ts eval-loads it and asserts parity. The Java file-read of
// srg_names.json stays in ext.js/main.js; only the PURE transform lives here.

/** The parsed srg_names.json: `{ "m_7583_": "net.minecraft.client.player.LocalPlayer#respawn()V", … }`.
 *  Values whose member half is still an `m_…_`/`f_…_` token (no Mojang mapping was available) are kept
 *  verbatim — they simply won't be reachable by a Mojang-name lookup (that's why the screen primitives
 *  keep a hardcoded token map instead). */
export type SrgNames = Readonly<Record<string, string>>;

/** The inverted index: `"Class#member" → [srg, …]`, keyed by BOTH the fully-qualified and the simple
 *  class name, overloads collapsed to insertion order. */
export type SrgIndex = Readonly<Record<string, readonly string[]>>;

/** Invert srg_names.json into the Mojang→SRG index. For each `srg → "FQCN#member(params)"`: strip the
 *  `(params)` signature and any trailing `:ret`, key the SRG under both `FQCN#member` and
 *  `SimpleClass#member`, deduping while preserving discovery order. Byte-identical to ext.js `srgFwd`. */
export function buildSrgIndex(map: SrgNames | null | undefined): SrgIndex {
  const out: Record<string, string[]> = {};
  const add = (key: string, srg: string): void => {
    let a = out[key];
    if (!a) {
      a = [];
      out[key] = a;
    }
    if (!a.includes(srg)) a.push(srg);
  };
  if (map) {
    for (const srg of Object.keys(map)) {
      const v = map[srg];
      if (typeof v !== "string") continue;
      const h = v.indexOf("#");
      if (h < 0) continue;
      const fqcn = v.substring(0, h);
      let member = v.substring(h + 1);
      const pa = member.indexOf("(");
      if (pa >= 0) member = member.substring(0, pa);
      const simple = fqcn.substring(fqcn.lastIndexOf(".") + 1);
      add(`${fqcn}#${member}`, srg);
      add(`${simple}#${member}`, srg);
    }
  }
  return out;
}

/** All SRG tokens for a Mojang `cls#member` (empty array if none). */
export function srgLookupAll(index: SrgIndex, cls: string, member: string): string[] {
  const a = index[`${cls}#${member}`];
  return a ? a.slice() : [];
}

/** The first SRG token for a Mojang `cls#member`. THROWS (fail-loud) if unknown — a rotted/misspelled
 *  name must never resolve to `undefined` and then read as a silent no-op (the exact trap). */
export function srgLookup(index: SrgIndex, cls: string, member: string): string {
  const first = index[`${cls}#${member}`]?.[0];
  if (first === undefined)
    throw new Error(
      `srg: no SRG name for ${cls}#${member} (check spelling / regenerate srg_names.json; inherited members live on the declaring class)`,
    );
  return first;
}

/** A declared SRG dependency the boot self-check verifies. `expect` (when set) additionally asserts the
 *  resolved token equals the hardcoded one — so a pack bump that renumbers a token screams at boot
 *  instead of silently no-op'ing a screen click. */
export interface SrgRequirement {
  readonly cls: string;
  readonly member: string;
  readonly expect?: string;
}

export interface SrgMiss {
  readonly cls: string;
  readonly member: string;
  readonly reason: "unresolved" | "mismatch";
  readonly expect?: string | undefined;
  readonly got?: string | undefined;
}

/** Boot self-check: resolve every required `cls#member` against the index and collect the misses —
 *  unresolved (the index has no token) or mismatched (resolved token ≠ the hardcoded `expect`). An
 *  empty result means every dependency is present in THIS pack's mapping; a non-empty result is the
 *  loud boot diagnosis (list each missing class/member) that turns silent runtime rot into an instant
 *  boot failure. Pure → the JS boot wiring only supplies the index + the required set. */
export function findMissingSrg(index: SrgIndex, required: readonly SrgRequirement[]): SrgMiss[] {
  const misses: SrgMiss[] = [];
  for (const r of required) {
    const a = index[`${r.cls}#${r.member}`];
    const got = a && a.length > 0 ? a[0] : undefined;
    if (got === undefined) {
      misses.push({ cls: r.cls, member: r.member, reason: "unresolved", expect: r.expect });
    } else if (r.expect !== undefined && got !== r.expect) {
      misses.push({ cls: r.cls, member: r.member, reason: "mismatch", expect: r.expect, got });
    }
  }
  return misses;
}

/** Boot self-check for HARDCODED SRG token maps (main.js's screen-primitive `SRG` map, the bundle's
 *  `src/core/runtime/jsmacros/srg.ts` `SRG`). These bypass the Mojang-name index (their srg_names.json entry
 *  may not carry a Mojang member), so they're checked the other direction: each token MUST still be a
 *  live KEY in srg_names.json. A pack bump that drops/renumbers the token removes the key → the token
 *  is reported missing → loud boot fail. Returns the tokens absent from the map. */
export function findMissingTokens(
  map: SrgNames | null | undefined,
  tokens: readonly string[],
): string[] {
  if (!map) return [];
  return tokens.filter((t) => !(t in map));
}
