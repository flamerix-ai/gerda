// Defensive-code rules — the type-checker-free half of the checker (try/catch, empty
// catch, `as` cast), plus the shared escape-hatch detection. Kept in its own module with
// NO node imports so the checker's vitest self-test can import it without dragging
// node:path/process/import.meta into the test's type graph. The CLI runner
// (check-defensive.ts) re-exports these and adds the type-aware dropped-Result rule.
import ts from "typescript";

export interface Violation {
  file: string;
  line: number;
  rule: string;
  message: string;
}

export const ESCAPE = "reliability-ok";

// The ONE file allowed to hold raw SRG tokens as string literals — the SRG member-name SSOT
// (src/core/runtime/jsmacros/srg.ts). Every other src/ file must resolve members through its `SRG` map.
const SRG_MAP_FILE = "src/core/runtime/jsmacros/srg.ts";
// A Forge SRG member token: `m_7583_` (method) / `f_92095_` (field). GraalJS resolves Java members
// by this obfuscated name, so a Mojang name reads as undefined and a token baked inline goes stale
// silently on a pack/MC bump — the exact failure the SRG map centralises away.
const SRG_TOKEN = /\b[mf]_\d+_\b/g;

// Replace COMMENT bytes with spaces (newlines preserved so line numbers hold), leaving string
// literals intact — a raw token in a comment is documentation, but one in executable code (incl. a
// bracket-access string key like `raw["m_7583_"]`) is a violation. A tiny char state-machine so a
// `//`-looking sequence inside a string (a URL) isn't mistaken for a comment, and vice-versa.
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue; // the \n is copied on the next loop
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      i += 2; // consume the closing */
      out += "  ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < n && text[i] !== c) {
        if (text[i] === "\\") {
          out += text[i] + (text[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += text[i];
        i++;
      }
      out += text[i] ?? "";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Flag a raw SRG member token in executable code (comments excluded, srg.ts whitelisted). */
export function scanSrgTokens(rel: string, text: string, out: Violation[]): void {
  if (rel === SRG_MAP_FILE) return; // the SSOT map is the one allowed home
  const code = stripComments(text);
  const lines = code.split("\n");
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln] ?? "";
    if (line.includes(ESCAPE)) continue; // per-line escape hatch, same as the other rules
    SRG_TOKEN.lastIndex = 0;
    const m = SRG_TOKEN.exec(line);
    if (m) {
      out.push({
        file: rel,
        line: ln + 1,
        rule: "no-inline-srg",
        message: `raw SRG token '${m[0]}' in code — resolve it through the SRG map in ${SRG_MAP_FILE}`,
      });
    }
  }
}

// The FFI facade is now split by facet under `src/core/runtime/jsmacros/` — the WHOLE directory is one
// exempt boundary (all facet files may touch the jsMacros globals + translate FFI throws).
const JSMACROS_GROUP = "src/core/runtime/jsmacros/";

// try/catch is legitimate ONLY at the boundaries that translate an alien failure mode
// into our own vocabulary: the FFI facade (jsmacros), the JSON decoder, and the kernel
// error-classification boundary. Everywhere else a throw must propagate.
export const TRYCATCH_ALLOW = new Set(["src/core/prim/json.ts", "src/shared/kernel/capability.ts"]);
// `as` is legitimate at the FFI facade (untyped Java), the mock's mirror of it, and
// validated JSON decoders (where each cast sits behind an explicit typeof/Array.isArray
// shape check that re-establishes the type the parsed `unknown` lost).
export const AS_ALLOW = new Set(["src/core/runtime/mock.ts", "src/shared/domain/world-model.ts"]);

/** try/catch allowed here — a designated FFI/decoder/kernel boundary or the jsmacros facet group. */
export function allowsTryCatch(rel: string): boolean {
  return TRYCATCH_ALLOW.has(rel) || rel.startsWith(JSMACROS_GROUP);
}
/** `as` cast allowed here — a narrowing boundary or the jsmacros facet group. */
export function allowsAsCast(rel: string): boolean {
  return AS_ALLOW.has(rel) || rel.startsWith(JSMACROS_GROUP);
}

// ── Tier boundary (tier import boundary: CORE < SHARED < BOT) ──────────────────────────
// src/ is layered CORE < SHARED < BOT and a fork takes the layers à la carte, so imports
// may only ever point INWARD: bot → shared → core. One `@/bot/...` inside shared/ makes
// shared unusable on its own again, and nothing else would notice — it type-checks, the
// bundle builds, every test passes. The boundary is an architectural claim, so it needs a
// checker; before this rule it was only ever verified by a grep someone remembered to run.
const TIER_RANK: Record<string, number> = { core: 0, shared: 1, bot: 2 };

/** The tier a repo-relative path belongs to, or "" for anything outside the tiered tree. */
function tierOf(rel: string): string {
  const m = /^src\/([^/]+)\//.exec(rel);
  const seg = m?.[1] ?? "";
  return seg in TIER_RANK ? seg : "";
}

// Resolve `./x`, `../x` against the importer's directory — no node:path, since this module
// stays node-free for the vitest self-test. Purely lexical (matching how the bundler and
// tsconfig `@/*` resolve), so no filesystem access and no ordering dependency.
function resolveRelative(fromRel: string, spec: string): string {
  const parts = fromRel.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/** The tier an import specifier lands in — via the `@/*` alias or a relative hop. */
function targetTier(fromRel: string, spec: string): string {
  if (spec.startsWith("@/")) return tierOf(`src/${spec.slice(2)}/`);
  if (spec.startsWith(".")) return tierOf(`${resolveRelative(fromRel, spec)}/`);
  return ""; // a bare package specifier — not ours to police
}

/**
 * Flag an import that points OUTWARD across the tier boundary (core → shared/bot, shared →
 * bot). Deliberately covers relative specifiers too: `../../bot/x` is the same violation as
 * `@/bot/x`, and a rule that only understood the alias would teach people the workaround.
 */
export function scanTierImports(sf: ts.SourceFile, rel: string, out: Violation[]): void {
  const from = tierOf(rel);
  if (!from) return; // outside src/<tier>/ — entry glue, scripts, tests
  const visit = (node: ts.Node): void => {
    const spec =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
        ? node.moduleSpecifier
        : ts.isImportTypeNode(node)
          ? node.argument
          : ts.isCallExpression(node) &&
              node.expression.kind === ts.SyntaxKind.ImportKeyword &&
              node.arguments[0]
            ? node.arguments[0]
            : undefined;
    if (spec && ts.isStringLiteralLike(spec)) {
      const to = targetTier(rel, spec.text);
      // A same-tier or inward import is the whole point of the layering — only outward breaks it.
      if (to && (TIER_RANK[to] ?? 0) > (TIER_RANK[from] ?? 0) && !hasEscape(sf, node)) {
        out.push({
          file: rel,
          line: lineOf(sf, node),
          rule: "no-outward-tier-import",
          message: `'${from}' imports '${spec.text}' from the OUTER tier '${to}' — tiers may only import inward (bot → shared → core), else '${from}' can no longer be taken on its own. Inject the value instead of importing it, or annotate // reliability-ok:`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function lineText(sf: ts.SourceFile, target: number): string {
  if (target < 0 || target >= sf.getLineStarts().length) return "";
  const start = sf.getPositionOfLineAndCharacter(target, 0);
  const end =
    target + 1 < sf.getLineStarts().length
      ? sf.getPositionOfLineAndCharacter(target + 1, 0)
      : sf.text.length;
  return sf.text.slice(start, end);
}

// True if `// reliability-ok:` appears on the node's own line or anywhere in the
// CONTIGUOUS comment block directly above it (so a multi-line `//` justification — the
// codebase's usual style — counts no matter which of its lines carries the keyword).
export function hasEscape(sf: ts.SourceFile, node: ts.Node): boolean {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  if (lineText(sf, line).includes(ESCAPE)) return true;
  for (let target = line - 1; target >= 0; target--) {
    const t = lineText(sf, target).trim();
    if (!t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")) break; // end of block
    if (t.includes(ESCAPE)) return true;
  }
  return false;
}

export function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

// The type-checker-free rules (try/catch, empty catch, `as` cast, inline SRG token, tier import).
export function scanSyntactic(sf: ts.SourceFile, rel: string, out: Violation[]): void {
  scanTierImports(sf, rel, out);
  // A .d.ts declares types and carries no runtime code, so the rules below (SRG token,
  // try/catch, `as` cast) have nothing to bite — but its IMPORTS are real dependencies,
  // so the tier rule above must still run on it: an ambient declaration under src/shared
  // that imports from src/bot breaks the tier exactly as a .ts one would. This lives here
  // rather than in check-defensive.ts's file loop so it stays reachable from
  // analyzeSyntacticText(), i.e. so a test can hold it.
  if (sf.isDeclarationFile) return;
  scanSrgTokens(rel, sf.text, out);
  const visit = (node: ts.Node): void => {
    if (ts.isTryStatement(node)) {
      if (!allowsTryCatch(rel) && !hasEscape(sf, node)) {
        out.push({ file: rel, line: lineOf(sf, node), rule: "no-try-catch", message: "try/catch outside a designated boundary swallows throws — let it propagate, or annotate // reliability-ok:" });
      }
      const cb = node.catchClause;
      if (cb && cb.block.statements.length === 0 && !hasEscape(sf, cb)) {
        out.push({ file: rel, line: lineOf(sf, cb), rule: "no-empty-catch", message: "empty catch silently swallows the error" });
      }
    }
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && node.type.kind !== ts.SyntaxKind.ConstKeyword) {
      const isAsConst = ts.isAsExpression(node) && node.type.getText(sf) === "const";
      if (!isAsConst && !allowsAsCast(rel) && !hasEscape(sf, node)) {
        out.push({ file: rel, line: lineOf(sf, node), rule: "no-as-cast", message: `'as ${node.type.getText(sf)}' assertion outside a narrowing boundary — prove it via must()/a guard, or annotate // reliability-ok:` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** Parse a source string and run the syntactic rules — the testable entry point. */
export function analyzeSyntacticText(rel: string, text: string): Violation[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true);
  const out: Violation[] = [];
  scanSyntactic(sf, rel, out);
  return out;
}
