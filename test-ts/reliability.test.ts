// Reliability paradigm — the structural guarantees from the fail-loud refactor:
//   - a capability whose required resource is unavailable is SKIPPED, not run half-ready;
//   - ctx.res throws if you read a resource you didn't declare in `requires`;
//   - WORLD_SCOPE is unobtainable until the world signature resolves;
//   - the defensive-code checker actually bites on bad patterns and respects the escape.
import { analyzeSyntacticText } from "@/../scripts/defensive-rules";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { ContractError } from "@/core/prim/invariant";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import { Bus } from "@/shared/kernel/bus";
import { type Capability, type Ctx, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogSink, Logger } from "@/shared/kernel/logger";
import { PLAYER, WORLD_SCOPE } from "@/shared/kernel/resource";
import { describe, expect, it } from "vitest";

const sink: LogSink = { emit: () => {} };
const mk = (rt: MockRuntime) =>
  new Kernel(rt, new Logger(sink, "ERR"), new Bus(), makeGerdaConfig(), GERDA_PHASES);

describe("declarative resources", () => {
  it("skips a guard whose required resource is unavailable (no throw, guard never runs)", () => {
    const rt = createMockRuntime();
    rt.state.playerPresent = false; // player.* now resolves err → PLAYER unavailable
    let ran = false;
    const cap: Capability = {
      name: "needsPlayer",
      requires: [PLAYER],
      guard: () => {
        ran = true;
        return true;
      },
    };
    const k = mk(rt).register(cap);
    const st = makeInitialState();
    st.running = true;
    st.phase = "SCAN";
    expect(() => k.tick(st)).not.toThrow();
    expect(ran).toBe(false); // skipped, not run on a missing player
  });

  it("runs the guard and injects the resource once the player is present", () => {
    const rt = createMockRuntime();
    let seenHealth: number | null = null;
    const cap: Capability = {
      name: "readsPlayer",
      requires: [PLAYER],
      guard: (ctx: Ctx) => {
        seenHealth = ctx.res(PLAYER).health;
        return false;
      },
    };
    const k = mk(rt).register(cap);
    const st = makeInitialState();
    st.running = true;
    st.phase = "SCAN";
    k.tick(st);
    expect(seenHealth).not.toBeNull();
  });

  it("ctx.res throws a ContractError for a resource not declared in requires", () => {
    const rt = createMockRuntime();
    let thrown: unknown = null;
    const cap: Capability = {
      name: "undeclared",
      // NOTE: no `requires` — reading PLAYER is a contract violation.
      guard: (ctx: Ctx) => {
        try {
          ctx.res(PLAYER);
        } catch (e) {
          thrown = e;
        }
        return false;
      },
    };
    const k = mk(rt).register(cap);
    const st = makeInitialState();
    st.running = true;
    st.phase = "SCAN";
    k.tick(st);
    expect(thrown).toBeInstanceOf(ContractError);
  });
});

describe("WorldScope", () => {
  it("is unobtainable while the world signature is not ready", () => {
    const rt = createMockRuntime();
    rt.state.worldSig = ""; // signature() → err
    const r = WORLD_SCOPE.resolve({ rt });
    expect(r.ok).toBe(false);
  });

  it("resolves to a handle carrying the live signature once ready", () => {
    const rt = createMockRuntime();
    rt.state.worldSig = "LOCAL_main|minecraft:overworld";
    const r = WORLD_SCOPE.resolve({ rt });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.sig).toBe("LOCAL_main|minecraft:overworld");
  });
});

describe("defensive-code checker (self-test)", () => {
  it("flags an un-annotated try/catch, empty catch, and `as` cast", () => {
    const bad = [
      "function f(x: unknown) {",
      "  try { return JSON.parse(String(x)); } catch (e) { return null; }",
      "  const y = x as string;",
      "}",
    ].join("\n");
    const rules = analyzeSyntacticText("src/fake.ts", bad).map((v) => v.rule);
    expect(rules).toContain("no-try-catch");
    expect(rules).toContain("no-as-cast");
  });

  it("flags an empty catch specifically", () => {
    const bad = "try { risky(); } catch {}";
    const rules = analyzeSyntacticText("src/fake.ts", bad).map((v) => v.rule);
    expect(rules).toContain("no-empty-catch");
  });

  it("honours the // reliability-ok escape hatch", () => {
    const ok = ["// reliability-ok: boundary", "const y = (x as string);"].join("\n");
    expect(analyzeSyntacticText("src/fake.ts", ok)).toHaveLength(0);
  });

  it("is clean on ordinary, non-defensive code", () => {
    const good = "export function add(a: number, b: number): number { return a + b; }";
    expect(analyzeSyntacticText("src/fake.ts", good)).toHaveLength(0);
  });

  it("flags a raw SRG token in code (dot-call and bracket-key)", () => {
    const dot = analyzeSyntacticText("src/fake.ts", "const y = raw.m_7583_();");
    expect(dot.map((v) => v.rule)).toContain("no-inline-srg");
    const bracket = analyzeSyntacticText("src/fake.ts", 'const y = raw["m_6135_"]();');
    expect(bracket.map((v) => v.rule)).toContain("no-inline-srg");
  });

  it("does NOT flag an SRG token that only appears in a comment", () => {
    const commented = [
      "// respawn is SRG m_7583_ (descriptor ()V)",
      "const y = raw[SRG.respawn]();",
    ].join("\n");
    expect(analyzeSyntacticText("src/fake.ts", commented)).toHaveLength(0);
    const block = "/* Entity.onGround → f_20096_ */\nexport const x = 1;";
    expect(analyzeSyntacticText("src/fake.ts", block)).toHaveLength(0);
  });

  it("whitelists the SRG map file itself", () => {
    const map = 'export const SRG = { respawn: "m_7583_" } as const;';
    expect(analyzeSyntacticText("src/core/runtime/jsmacros/srg.ts", map)).toHaveLength(0);
    // …but the SAME literal is a violation anywhere else.
    expect(analyzeSyntacticText("src/other.ts", map).map((v) => v.rule)).toContain("no-inline-srg");
  });
});

// The tier import boundary. CORE < SHARED < BOT, and the direction is what
// makes the layers separable — so it is checked, not merely intended.
describe("tier-import rule (self-test)", () => {
  const rules = (rel: string, text: string): string[] =>
    analyzeSyntacticText(rel, text).map((v) => v.rule);

  it("flags an outward import at each step of the ladder", () => {
    expect(rules("src/core/runtime/a.ts", 'import { x } from "@/shared/nav/route";')).toContain(
      "no-outward-tier-import",
    );
    expect(rules("src/core/runtime/a.ts", 'import { x } from "@/bot/plans/p";')).toContain(
      "no-outward-tier-import",
    );
    expect(rules("src/shared/nav/a.ts", 'import { x } from "@/bot/profile/pack";')).toContain(
      "no-outward-tier-import",
    );
  });

  it("allows inward and same-tier imports — the direction is the whole rule", () => {
    expect(rules("src/bot/plans/a.ts", 'import { x } from "@/shared/nav/route";')).toHaveLength(0);
    expect(rules("src/bot/plans/a.ts", 'import { x } from "@/core/prim/invariant";')).toHaveLength(
      0,
    );
    expect(
      rules("src/shared/nav/a.ts", 'import { x } from "@/core/runtime/Runtime";'),
    ).toHaveLength(0);
    expect(rules("src/shared/nav/a.ts", 'import { x } from "@/shared/domain/pos";')).toHaveLength(
      0,
    );
  });

  // The alias is a convention, not a barrier: a relative hop reaches the same file. A rule
  // that only understood `@/` would flag the honest spelling and wave the sneaky one through.
  it("resolves relative specifiers, so `../../bot/x` cannot smuggle the same import", () => {
    expect(rules("src/shared/nav/a.ts", 'import { x } from "../../bot/profile/pack";')).toContain(
      "no-outward-tier-import",
    );
    expect(rules("src/shared/nav/a.ts", 'import { x } from "./route";')).toHaveLength(0);
    expect(rules("src/shared/nav/a.ts", 'import { x } from "../domain/pos";')).toHaveLength(0);
  });

  it("covers re-exports, type-only imports, and dynamic import()", () => {
    expect(rules("src/shared/k/a.ts", 'export { x } from "@/bot/p";')).toContain(
      "no-outward-tier-import",
    );
    expect(rules("src/shared/k/a.ts", 'import type { X } from "@/bot/p";')).toContain(
      "no-outward-tier-import",
    );
    expect(rules("src/shared/k/a.ts", 'const m = await import("@/bot/p");')).toContain(
      "no-outward-tier-import",
    );
  });

  it("ignores bare packages and files outside the tiered tree", () => {
    expect(rules("src/shared/k/a.ts", 'import ts from "typescript";')).toHaveLength(0);
    // The repo-root config/ JSON the pack profile reads — a data file, not a tier.
    expect(
      rules("src/bot/profile/pack.ts", 'import O from "../../../config/o.json";'),
    ).toHaveLength(0);
    expect(rules("src/entry.ts", 'import { x } from "@/bot/p";')).toHaveLength(0);
  });

  // A .d.ts used to slip past the whole gate: check-defensive.ts skipped every
  // declaration file before it ever reached the tier rule, so an ambient
  // `src/shared/**/*.d.ts` importing `@/bot/...` passed a fully green run. Types are
  // dependencies too — shared/ would stop type-checking on its own.
  it("holds declaration files to the tier rule, but not to the runtime rules", () => {
    expect(rules("src/shared/k/a.d.ts", 'import type { X } from "@/bot/p";')).toContain(
      "no-outward-tier-import",
    );
    expect(rules("src/shared/k/a.d.ts", 'import type { X } from "@/core/prim/pos";')).toHaveLength(
      0,
    );
    // The runtime-only rules stay off for declarations — an SRG token in a .d.ts is
    // a type name, not a call that can hit the render thread.
    expect(rules("src/shared/k/a.d.ts", "export declare const m_7583_: number;")).toHaveLength(0);
  });
});
