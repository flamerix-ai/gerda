// Defensive-code checker — the structural enforcer for the fail-loud paradigm. It walks
// src/ with the TypeScript compiler API and flags the patterns that let a bug hide
// instead of scream:
//
//   1. try/catch outside the few designated boundaries (it swallows throws);
//   2. an EMPTY catch (a silent swallow, always);
//   3. a DROPPED Result — a `Result<T>`-returning call used as a bare statement, its
//      ok/err never inspected (the whole point of Result is that the caller branches);
//   4. an `as` type assertion outside the designated narrowing boundaries.
//
// Every rule has ONE escape hatch: a `// reliability-ok: <reason>` comment on the
// offending line (or the contiguous comment block above it). Explicit, greppable, and it
// forces a written reason.
//
// The syntactic rules (1, 2, 4) live in ./defensive-rules so the vitest self-test can
// import them node-free; this file adds the type-aware rule (3) and the CLI. Run via
// `bun run scripts/check-defensive.ts` (wired into `bun run check`).
import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  ESCAPE,
  type Violation,
  hasEscape,
  lineOf,
  scanSyntactic,
} from "./defensive-rules.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(ROOT, "src");
const HARNESS = resolve(ROOT, "harness");

// Harness game-safety rule: a blocking call (Thread.sleep / infinite loop) inside a
// Client.runOnMainThread(...) callback runs ON the render thread and FREEZES the game
// (>500ms → jsMacros watchdog kills the service; multi-second → the world unloads). The
// plain-JS Services aren't TS, so this is a balanced-paren text scan. Escape: a
// `// reliability-ok:` on the runOnMainThread line (or the line above).
const HARNESS_BLOCKING = /Thread\s*\.\s*sleep|while\s*\(\s*(?:true|1)\s*\)|for\s*\(\s*;\s*;/;

function harnessArgBlock(code: string, openIdx: number): string {
  let depth = 1;
  let j = openIdx + 1;
  for (; j < code.length && depth > 0; j++) {
    const c = code[j];
    if (c === "(") depth++;
    else if (c === ")") depth--;
  }
  return code.slice(openIdx + 1, j - 1);
}

function lineAtIndex(code: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx; i++) if (code[i] === "\n") line++;
  return line;
}

function scanHarness(out: Violation[]): void {
  let files: string[];
  try {
    files = readdirSync(HARNESS).filter((f) => f.endsWith(".js"));
  } catch {
    return; // no harness dir → nothing to scan
  }
  for (const f of files) {
    const code = readFileSync(resolve(HARNESS, f), "utf8");
    const lines = code.split("\n");
    const re = /runOnMainThread\s*\(/g;
    let m: RegExpExecArray | null = re.exec(code);
    while (m !== null) {
      const block = harnessArgBlock(code, re.lastIndex - 1);
      if (HARNESS_BLOCKING.test(block)) {
        const ln = lineAtIndex(code, m.index);
        const here = lines[ln - 1] ?? "";
        const above = lines[ln - 2] ?? "";
        if (!here.includes(ESCAPE) && !above.includes(ESCAPE)) {
          out.push({
            file: `harness/${f}`,
            line: ln,
            rule: "no-render-thread-block",
            message:
              "blocking (Thread.sleep / infinite loop) inside runOnMainThread runs on the render thread and FREEZES the game",
          });
        }
      }
      m = re.exec(code);
    }
  }
}

function relPath(file: string): string {
  return relative(ROOT, file).split("\\").join("/");
}

// A Result is dropped if a `Result<…>`-typed call is the whole expression of an
// ExpressionStatement (return value ignored). `void expr`, assignment, return, and
// member/await chaining all CONSUME it, so they aren't statements-of-a-call here.
function isDroppedResult(stmt: ts.ExpressionStatement, checker: ts.TypeChecker): boolean {
  const expr = stmt.expression;
  if (!ts.isCallExpression(expr)) return false;
  const type = checker.getTypeAtLocation(expr);
  return checker.typeToString(type).startsWith("Result<");
}

function checkFile(sf: ts.SourceFile, checker: ts.TypeChecker, out: Violation[]): void {
  const rel = relPath(sf.fileName);
  scanSyntactic(sf, rel, out); // type-checker-free rules
  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node) && isDroppedResult(node, checker) && !hasEscape(sf, node)) {
      out.push({ file: rel, line: lineOf(sf, node), rule: "no-dropped-result", message: "a Result is discarded — branch on .ok, expectOk(), or `void` it with a reason" });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function main(): void {
  const configPath = resolve(ROOT, "tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, ts.sys as unknown as ts.ParseConfigFileHost);
  if (!parsed) {
    console.error("check-defensive: could not read tsconfig.json");
    process.exit(2);
    return;
  }
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const out: Violation[] = [];
  for (const sf of program.getSourceFiles()) {
    // NOTE: declaration files are NOT skipped here — a .d.ts under src/ can still
    // import across tiers. scanSyntactic() narrows itself to the tier rule for them.
    if (!sf.fileName.startsWith(SRC)) continue; // src/ only — tests may stub
    checkFile(sf, checker, out);
  }
  scanHarness(out); // plain-JS Services: game-safety (render-thread blocking)
  if (out.length === 0) {
    console.log("check-defensive: clean — no defensive patterns found in src/ or harness/");
    return;
  }
  out.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
  for (const v of out) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}]  ${v.message}`);
  }
  console.error(`\ncheck-defensive: ${out.length} violation(s). Fix, or annotate the line with // ${ESCAPE}: <reason>.`);
  process.exit(1);
}

main();
