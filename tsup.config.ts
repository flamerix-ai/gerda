import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// OPTIONAL fork/user config override, baked into the bundle at build time (like __BUILD_REV__).
// The file is gitignored; absent → "{}" (build unchanged). Present → it MUST parse to a JSON object
// (the deep-partial ConfigOverrides shape makeConfig accepts). A malformed file or a non-object
// fails the BUILD loudly — a silent-empty fallback would hide the fork author's typo. The returned
// JSON text is `define`d as the `__CONFIG_OVERRIDES__` identifier, so esbuild substitutes an object
// literal (do NOT JSON.stringify it again at the define site). Runtime keys still win — the bundle
// re-validates the top-level keys and merges these UNDER worldModelPath/JM (see worker-bundle.ts).
const OVERRIDES_FILE = "config/local.overrides.json";
function readConfigOverrides(): string {
  let text: string;
  try {
    text = readFileSync(OVERRIDES_FILE, "utf8");
  } catch {
    return "{}"; // absent → no overrides, build unchanged
  }
  const parsed: unknown = JSON.parse(text); // malformed JSON throws → fails the build (fail-loud)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const got = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
    throw new Error(`${OVERRIDES_FILE}: expected a JSON object, got ${got}`);
  }
  return JSON.stringify(parsed);
}

// Build provenance baked into the bundle so a running bot can report exactly what's
// loaded (commit + `-dirty` when the tree had uncommitted changes at build time).
function buildRev(): string {
  try {
    const rev = execSync("git rev-parse --short HEAD").toString().trim();
    // "dirty" reflects only the bundle's OWN inputs (src/ + ts/tsup config) — not
    // unrelated working-tree noise (.envrc, macros, etc.), so the stamp means "this
    // bundle was built from uncommitted source".
    const dirty =
      execSync("git status --porcelain -- src tsconfig.json tsup.config.ts").toString().trim()
        .length > 0;
    return dirty ? `${rev}-dirty` : rev;
  } catch {
    return "unknown";
  }
}
function buildTime(): string {
  try {
    return new Date().toISOString();
  } catch {
    return "unknown";
  }
}

// Build the TS kernel into a single jsMacros-loadable bundle.
//
// worker.js does `eval(code)` then reads a bare `Module`. esbuild's IIFE wraps
// everything in a closure, so the entry assigns `globalThis.Module = ...` as a
// side effect — a global property resolves as the bare `Module` identifier in the
// worker's eval scope (GraalJS is ES2022, globalThis is available).
export default defineConfig({
  entry: { "__gerda_bot.bundle": "src/bot/entry/worker-bundle.ts" },
  format: ["iife"],
  target: "es2020",
  platform: "neutral",
  outDir: "dist",
  bundle: true,
  treeshake: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  minify: false,
  dts: false,
  define: {
    __BUILD_REV__: JSON.stringify(buildRev()),
    __BUILD_TIME__: JSON.stringify(buildTime()),
    __CONFIG_OVERRIDES__: readConfigOverrides(),
  },
  outExtension: () => ({ js: ".js" }),
});
