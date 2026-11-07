// Config-key drift gate: every `cfg.<key>` / `cfg.<section>.<key>` (and `DEFAULT_CONFIG.…`)
// written anywhere in the tracked tree must name a key that exists in DEFAULT_CONFIG.
//
// The config is NESTED (`cfg.section.key`) and keys get renamed; tsc catches a stale ref
// in code, but NOT in a comment, a doc, a scenario note or a Python/JS script outside the
// TS project — there it rots silently and sends the next reader to a knob that does not
// exist. This gate scans every text file `git ls-files` lists and resolves each ref
// against the live DEFAULT_CONFIG object. A historical doc that keeps the key names of
// its day carries the line `<!-- cfg-drift: historical -->` and is skipped; a marked file
// whose basename is not in HISTORICAL_ALLOWED below fails the gate.
//
// Resolution: segment 1 must be a key of DEFAULT_CONFIG; if its value is a nested
// section object, segment 2 must be a key of that section. If segment 1 is a scalar
// (`cfg.homeCommand`), segment 2 is a member access on the value (`.startsWith`), which
// only passes through the explicit IGNORE list below — a new one is a conscious edit.
// Only depth ≤2 is checked; `cfg?.x`, `cfg["x"]` and aliases of cfg are not seen.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { must } from "@/core/prim/invariant";
import { DEFAULT_CONFIG } from "@/shared/config/schema";

const SELF = "test-ts/cfg-keys-drift.test.ts";
// Opt-out marker: must stand on a line of its own, so a doc that merely names it inline
// (CLAUDE.md) is still checked.
const HISTORICAL_MARKER = "<!-- cfg-drift: historical -->";
// Basenames of the only files allowed to carry the marker. A marker anywhere else would
// silently blind the gate for that file, so a new historical doc is a conscious edit here.
// Basenames, not paths: a full path here would name a directory the public snapshot's leak
// guard refuses. A missing entry is not an error (that tree does not ship the file); a
// basename on two tracked paths is (the second one would be skipped unasked).
const HISTORICAL_ALLOWED: ReadonlySet<string> = new Set(["004_own-navigator.md"]);

// Full refs that are not config keys but legitimately match the pattern. Every entry must
// still occur in the tree (asserted below), so the list cannot outlive its reason.
const IGNORE = new Set<string>([
  // the documented placeholder for the nested-key shape (CLAUDE.md)
  "cfg.section.key",
  // member access on a resolved scalar / array value, not a key
  "cfg.homeCommand.startsWith",
  "cfg.containerKinds.some",
]);

const REF_RE = /\b(?:cfg|DEFAULT_CONFIG)\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g;

interface Unresolved {
  readonly where: string;
  readonly ref: string;
}

// Own keys only (a Map, not `in`): `cfg.toString` must not resolve through the prototype.
const ROOT: ReadonlyMap<string, unknown> = new Map(Object.entries(DEFAULT_CONFIG));

const isSection = (v: unknown): v is object =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** True when the ref's segments name a real DEFAULT_CONFIG key. */
function resolves(k1: string, k2: string | undefined): boolean {
  if (!ROOT.has(k1)) return false;
  if (k2 === undefined) return true;
  const v = ROOT.get(k1);
  // Scalar / array at depth 1: segment 2 is a member access on the value, not a key.
  // Only the explicit IGNORE list may pass it (checked by the caller).
  if (!isSection(v)) return false;
  return Object.keys(v).includes(k2);
}

/** Every unresolved config ref in `text`, located as `<file>:<line>`. */
function findUnresolved(file: string, text: string): Unresolved[] {
  const out: Unresolved[] = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(REF_RE)) {
      const ref = m[0];
      if (IGNORE.has(ref)) continue;
      if (!resolves(must(m[1], "REF_RE group 1"), m[2])) {
        out.push({ where: `${file}:${i + 1}`, ref });
      }
    }
  });
  return out;
}

/** True when the file opted out: the marker stands alone on one of its lines. */
const isHistorical = (text: string): boolean =>
  text.split("\n").some((line) => line.trim() === HISTORICAL_MARKER);

// `git ls-files` paths always use `/`.
const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** True when the path's basename is in HISTORICAL_ALLOWED: exact and case-sensitive. */
const isAllowlisted = (path: string): boolean => HISTORICAL_ALLOWED.has(basename(path));

/** IGNORE entries absent from `seen` — each one has outlived its reason. */
const staleIgnores = (seen: ReadonlySet<string>): string[] =>
  [...IGNORE].filter((r) => !seen.has(r));

/** Text of one listed file: the filesystem for the live tree, a Map for a fixture. */
type ReadText = (file: string) => string;

interface Scan {
  readonly bad: readonly Unresolved[];
  /** Every ref matched outside binary and marker-skipped files. */
  readonly seen: ReadonlySet<string>;
  /** Files skipped by the historical marker, in listing order. */
  readonly skipped: readonly string[];
}

/** One pass over `files`: binaries are ignored, marked files skipped, the rest resolved. */
function scan(files: readonly string[], read: ReadText): Scan {
  const bad: Unresolved[] = [];
  const seen = new Set<string>();
  const skipped: string[] = [];
  for (const f of files) {
    const text = read(f);
    if (text.includes("\0")) continue; // binary
    if (isHistorical(text)) {
      skipped.push(f);
      continue;
    }
    for (const m of text.matchAll(REF_RE)) seen.add(m[0]);
    bad.push(...findUnresolved(f, text));
  }
  return { bad, seen, skipped };
}

/** Everything the gate fails on. The live tree must yield an empty list in every field. */
interface Findings {
  /** `<file>:<line>: <ref>` for each ref that does not resolve. */
  readonly unresolved: readonly string[];
  /** Marker-skipped files outside HISTORICAL_ALLOWED — each one blinds the gate unasked. */
  readonly unexpectedHistorical: readonly string[];
  /** Allowlisted files that were not skipped: no marker, or the skip is not recorded. This
   *  is the floor of `unexpectedHistorical` — without it an unfed `skipped` passes vacuously. */
  readonly allowlistedNotSkipped: readonly string[];
  /** `<basename>: <path>, <path>…` for an allowlisted basename on more than one path. A
   *  basename allowlists ONE file; a second one would be skipped unasked. */
  readonly ambiguousAllowlisted: readonly string[];
  /** IGNORE entries no ref in the scanned files matched. */
  readonly staleIgnores: readonly string[];
}

/** Allowlisted basenames that more than one of `paths` carries. */
function ambiguous(paths: readonly string[]): string[] {
  const byBase = new Map<string, string[]>();
  for (const p of paths) byBase.set(basename(p), [...(byBase.get(basename(p)) ?? []), p]);
  return [...byBase]
    .filter(([, ps]) => ps.length > 1)
    .map(([base, ps]) => `${base}: ${ps.join(", ")}`);
}

/** The whole gate over `files`. The live test and every fixture test run this one path. */
function audit(
  files: readonly string[],
  read: ReadText,
): { seen: ReadonlySet<string>; findings: Findings } {
  const s = scan(files, read);
  const skipped = new Set(s.skipped);
  const allowlisted = files.filter(isAllowlisted);
  return {
    seen: s.seen,
    findings: {
      unresolved: s.bad.map((b) => `${b.where}: ${b.ref}`),
      unexpectedHistorical: s.skipped.filter((f) => !isAllowlisted(f)),
      allowlistedNotSkipped: allowlisted.filter((f) => !skipped.has(f)),
      ambiguousAllowlisted: ambiguous(allowlisted),
      staleIgnores: staleIgnores(s.seen),
    },
  };
}

const trackedFiles = (): string[] =>
  execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((f) => f !== "" && f !== SELF);

/** A fixture tree: its listing (insertion order) and its reader. */
function tree(entries: Readonly<Record<string, string>>): {
  files: string[];
  read: ReadText;
} {
  const byPath = new Map(Object.entries(entries));
  return { files: [...byPath.keys()], read: (f) => must(byPath.get(f), `fixture file ${f}`) };
}

// Fixture vocabulary. BAD names no key, so it is reported wherever it is not skipped.
const MARK = HISTORICAL_MARKER;
const BAD = "cfg.navBridge";
const ALLOWED = "004_own-navigator.md";

describe("cfg.* refs ↔ DEFAULT_CONFIG", () => {
  it("every cfg.<key>[.<key>] in the tracked tree resolves", () => {
    const files = trackedFiles();
    expect(files.length).toBeGreaterThan(100); // an empty walk would pass vacuously
    const { seen, findings } = audit(files, (f) => readFileSync(f, "utf8"));
    expect(seen.size).toBeGreaterThan(100); // the pattern still matches the live tree
    expect(findings.unresolved.join("\n")).toBe("");
    expect(findings.unexpectedHistorical, "historical marker outside HISTORICAL_ALLOWED").toEqual(
      [],
    );
    expect(
      findings.allowlistedNotSkipped,
      "allowlisted file tracked but not skipped (no marker, or the skip is not recorded)",
    ).toEqual([]);
    expect(
      findings.ambiguousAllowlisted,
      "an allowlisted basename on more than one tracked path — rename one",
    ).toEqual([]);
    expect(findings.staleIgnores, "IGNORE entries no longer found in the tree — drop them").toEqual(
      [],
    );
  });

  // Neg-control: the resolver must REPORT a flat-era key under a section that never had it
  // and a top-level key that does not exist, and must NOT report a real nested key.
  it("known-bad refs are reported, known-good ones are not", () => {
    const fixture = [
      "// radius comes from cfg.scan.scanRadius", // wrong key inside a real section
      "// bridging is tuned by cfg.navBridge", // no such top-level key
      "const r = cfg.scan.radius;", // real
      "if (cfg.homeCommand.trim()) {}", // member access on a scalar, NOT in IGNORE
      "if (cfg.homeCommand.startsWith('/')) {}", // the same shape, in IGNORE
      "const d = DEFAULT_CONFIG.scan.scanRadius;", // the DEFAULT_CONFIG spelling
      "const b = ctx.cfg.navBridge;", // cfg reached as a property
    ].join("\n");
    const got = findUnresolved("fixture.ts", fixture);
    expect(got).toEqual([
      { where: "fixture.ts:1", ref: "cfg.scan.scanRadius" },
      { where: "fixture.ts:2", ref: "cfg.navBridge" },
      { where: "fixture.ts:4", ref: "cfg.homeCommand.trim" },
      { where: "fixture.ts:6", ref: "DEFAULT_CONFIG.scan.scanRadius" },
      { where: "fixture.ts:7", ref: "cfg.navBridge" },
    ]);
  });

  it("an IGNORE entry missing from the tree is reported as stale", () => {
    const all = new Set(IGNORE);
    expect(staleIgnores(all)).toEqual([]);
    all.delete("cfg.containerKinds.some");
    expect(staleIgnores(all)).toEqual(["cfg.containerKinds.some"]);
  });

  // The historical opt-out, end to end through audit() — the path the live test runs. Each
  // fixture varies one axis the live tree can vary: the basename around the allowlisted one
  // (suffix, prefix, case, extension, other names), the path depth, and how the marker line is written.
  describe("historical opt-out (fixture trees through audit)", () => {
    it("the fixtures name the real allowlist entry", () => {
      expect(HISTORICAL_ALLOWED.has(ALLOWED)).toBe(true);
    });

    it("only the exact allowlisted basename may carry the marker; only an own-line marker counts", () => {
      const t = tree({
        // allowlisted + marked: skipped, its stale ref unseen, nothing reported
        [`docs/old/${ALLOWED}`]: `# Old\n${MARK}\n${BAD}\n`,
        // marked, basename NOT allowlisted: skipped AND reported (suffix, prefix, case, extension,
        // other)
        [`docs/old/${ALLOWED}.bak`]: `${MARK}\n${BAD}\n`,
        [`docs/old/x${ALLOWED}`]: `${MARK}\n${BAD}\n`,
        [`docs/old/${ALLOWED.toUpperCase()}`]: `${MARK}\n${BAD}\n`,
        [`docs/old/${ALLOWED.replace(/\.md$/, ".txt")}`]: `${MARK}\n${BAD}\n`,
        "docs/NAV.md": `${MARK}\n${BAD}\n`,
        // marker semantics: surrounding whitespace and CRLF still count as an own line
        "docs/indented.md": `\t${MARK}  \n${BAD}\n`,
        "docs/crlf.md": `title\r\n${MARK}\r\n${BAD}\r\n`,
        // ...an inline mention, another case or other inner spacing does not: still checked
        "docs/inline.md": `opt out with a \`${MARK}\` line; ${BAD}\n`,
        "docs/upper.md": `${MARK.toUpperCase()}\n${BAD}\n`,
        "docs/tight.md": `<!--cfg-drift: historical-->\n${BAD}\n`,
        "docs/spaced.md": `<!--  cfg-drift:  historical  -->\n${BAD}\n`,
        // an ordinary file: the real key resolves, the stale one is reported
        "src/a.ts": `const r = cfg.scan.radius;\n${BAD};\n`,
        // a binary (NUL byte) is not scanned at all
        "assets/blob.bin": `\0${BAD}\n`,
      });
      const { seen, findings } = audit(t.files, t.read);
      expect(findings).toEqual({
        unresolved: [
          `docs/inline.md:1: ${BAD}`,
          `docs/upper.md:2: ${BAD}`,
          `docs/tight.md:2: ${BAD}`,
          `docs/spaced.md:2: ${BAD}`,
          `src/a.ts:2: ${BAD}`,
        ],
        unexpectedHistorical: [
          `docs/old/${ALLOWED}.bak`,
          `docs/old/x${ALLOWED}`,
          `docs/old/${ALLOWED.toUpperCase()}`,
          `docs/old/${ALLOWED.replace(/\.md$/, ".txt")}`,
          "docs/NAV.md",
          "docs/indented.md",
          "docs/crlf.md",
        ],
        allowlistedNotSkipped: [],
        ambiguousAllowlisted: [],
        staleIgnores: [...IGNORE],
      });
      expect([...seen].sort()).toEqual([BAD, "cfg.scan.radius"]);
    });

    it("an allowlisted file without the marker is reported (the skip floor)", () => {
      const t = tree({ [`docs/old/${ALLOWED}`]: `${BAD}\n` });
      const { findings } = audit(t.files, t.read);
      expect(findings.unresolved).toEqual([`docs/old/${ALLOWED}:1: ${BAD}`]);
      expect(findings.allowlistedNotSkipped).toEqual([`docs/old/${ALLOWED}`]);
    });

    it("an allowlisted basename on two paths is reported, at any depth", () => {
      // a PAIR — the smallest duplicate — one nested, one at the root
      const t = tree({ [`docs/old/${ALLOWED}`]: `${MARK}\n`, [ALLOWED]: `${MARK}\n` });
      const { findings } = audit(t.files, t.read);
      expect(findings.ambiguousAllowlisted).toEqual([
        `${ALLOWED}: docs/old/${ALLOWED}, ${ALLOWED}`,
      ]);
      expect(findings.unexpectedHistorical).toEqual([]);
      expect(findings.allowlistedNotSkipped).toEqual([]);
    });

    it("a tree without the allowlisted file is not an error (the public snapshot)", () => {
      const t = tree({ "src/a.ts": "const r = cfg.scan.radius;\n" });
      const { findings } = audit(t.files, t.read);
      expect(findings.unexpectedHistorical).toEqual([]);
      expect(findings.allowlistedNotSkipped).toEqual([]);
      expect(findings.ambiguousAllowlisted).toEqual([]);
    });
  });
});
