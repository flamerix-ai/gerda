// Bundle load is version-portable: evaluating the bundle entry performs NO host class lookup.
//
// worker.js evals the whole bundle in one go; a `Java.type(...)` at MODULE scope runs during that
// eval, so a single class missing on the running game kills the bundle load outright. Measured
// docs/PORTABILITY.md: storage.ts resolved BlockPos + ForgeCapabilities at module scope,
// and the bundle loaded on NO runtime but Forge 1.20.1 — Fabric (intermediary class names) and
// Forge 1.18.2 (no ForgeCapabilities) both answered "no module loaded" to every command. Host
// classes are looked up lazily, inside the facade call that needs them, where a miss is a Result.
//
// Neg-control: put any `Java.type("…")` back at module scope in src/ and this test fails — the
// stub records the lookup AND throws, exactly like GraalJS does for a class it cannot find.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

type Globals = Record<string, unknown>;

describe("bundle module evaluation", () => {
  it("performs no host class lookup and still publishes Module", async () => {
    const g = globalThis as Globals;
    const saved = { Java: g["Java"], Module: g["Module"] };
    const lookups: string[] = [];
    g["Java"] = {
      type(name: string): never {
        lookups.push(name);
        throw new Error(`Access to host class ${name} is not allowed or does not exist.`);
      },
    };
    g["Module"] = undefined;
    vi.resetModules();
    const loaded = await import("@/bot/entry/worker-bundle").then(
      () => "loaded",
      (e: unknown) => `threw: ${String(e)}`,
    );
    const published = g["Module"] as { init?: unknown; tick?: unknown } | undefined;
    g["Java"] = saved.Java;
    g["Module"] = saved.Module;

    expect(lookups).toEqual([]);
    expect(loaded).toBe("loaded");
    expect(typeof published?.init).toBe("function");
    expect(typeof published?.tick).toBe("function");
    // Transforming the whole bundle source graph takes ~3 s alone and >5 s (vitest's default) under
    // the parallel `bun run check` load — a generous budget, not a performance claim.
  }, 60_000);

  // worker.js (sloppy mode) direct-evals the bundle inside loadBundle() and then reads the bare
  // `Module`. The plain-JS template is strict mode, so a `var Module` there stays inside the eval —
  // the shipped template loaded as NO module until it assigned globalThis.Module (docs/PORTABILITY.md,
  // D-5). A Function body is sloppy like worker.js, so this replays the exact lookup. Neg-control:
  // put `var Module = MyModule;` back in the template and `published` is undefined.
  it("harness/bot_template.js is visible to worker.js's eval", () => {
    const g = globalThis as Globals;
    const saved = g["Module"];
    const code = readFileSync("harness/bot_template.js", "utf8");
    const workerEval = new Function(
      "code",
      "globalThis.Module = undefined; eval(code); return typeof Module === 'undefined' ? undefined : Module;",
    ) as (code: string) => { init?: unknown; tick?: unknown; command?: unknown } | undefined;
    const published = workerEval(code);
    g["Module"] = saved;

    expect(typeof published?.init).toBe("function");
    expect(typeof published?.tick).toBe("function");
    expect(typeof published?.command).toBe("function");
  });
});
