import { navEngine } from "@/bot/capabilities/nav-engine";
import { makeGerdaConfig } from "@/bot/profile/config";
import { createMockRuntime } from "@/core/runtime/mock";
import type { Vec3 } from "@/core/runtime/types";
import type { Ctx } from "@/shared/kernel/capability";
import { type NavEngine, navEngineCfg, parseNavEngine } from "@/shared/nav/engine";
import { describe, expect, it } from "vitest";
import { makeBot } from "./harness";

// A minimal Ctx for the pure resolver: it reads only cfg, rt.player.pos() (default {0,64,0}), and
// the engine slice. Distance to the test target sets the auto-mode threshold.
function resolverCtx(mode: NavEngine, config = makeGerdaConfig()): Ctx {
  return {
    cfg: config,
    rt: createMockRuntime(),
    slice: () => ({ mode }),
  } as unknown as Ctx;
}

describe("parseNavEngine", () => {
  it("accepts the four engines case-insensitively, rejects garbage", () => {
    expect(parseNavEngine("DStar")).toBe("dstar");
    expect(parseNavEngine("AUTO")).toBe("auto");
    expect(parseNavEngine("default")).toBe("default");
    expect(parseNavEngine("astar")).toBe("astar");
    expect(parseNavEngine("baritone")).toBeNull();
    expect(parseNavEngine(undefined)).toBeNull();
  });
});

describe("navEngineCfg", () => {
  const target: Vec3 = { x: 0, y: 64, z: 10 };

  it("default mode returns the baked cfg untouched (zero behaviour change)", () => {
    const ctx = resolverCtx("default");
    expect(navEngineCfg(ctx, target)).toBe(ctx.cfg); // same reference → no merge
    expect(navEngineCfg(ctx, target).nav.dStar).toBe(false);
  });

  it("astar forces D* off; dstar forces it on", () => {
    expect(navEngineCfg(resolverCtx("astar"), target).nav.dStar).toBe(false);
    expect(navEngineCfg(resolverCtx("dstar"), target).nav.dStar).toBe(true);
  });

  it("astar is a no-op (same ref) when D* was already off in the baked cfg", () => {
    const ctx = resolverCtx("astar"); // baked cfg.nav.dStar: false
    expect(navEngineCfg(ctx, target)).toBe(ctx.cfg);
  });

  it("auto engages D* only for a leg ≥ cfg.nav.autoDStarDist", () => {
    const cfg = makeGerdaConfig({ nav: { autoDStarDist: 48 } });
    // near leg (10 blocks) → A*
    expect(navEngineCfg(resolverCtx("auto", cfg), { x: 0, y: 64, z: 10 }).nav.dStar).toBe(false);
    // far leg (100 blocks) → D*
    expect(navEngineCfg(resolverCtx("auto", cfg), { x: 0, y: 64, z: 100 }).nav.dStar).toBe(true);
  });
});

describe("nav_engine command", () => {
  it("reports the default mode, sets a new one, and rejects garbage", () => {
    const { kernel, st } = makeBot({ caps: [navEngine] });

    kernel.command(st, { type: "nav_engine" });
    expect(kernel.lastCommandOutcome()?.data).toMatchObject({ engine: "default" });

    kernel.command(st, { type: "nav_engine", engine: "dstar" });
    expect(kernel.lastCommandOutcome()?.data).toMatchObject({ engine: "dstar" });

    // the change persisted in the slice
    kernel.command(st, { type: "nav_engine" });
    expect(kernel.lastCommandOutcome()?.data).toMatchObject({ engine: "dstar" });

    kernel.command(st, { type: "nav_engine", engine: "rocket" });
    const out = kernel.lastCommandOutcome();
    expect(out?.data?.["error"]).toContain("unknown engine");
    // mode unchanged after a bad set
    kernel.command(st, { type: "nav_engine" });
    expect(kernel.lastCommandOutcome()?.data).toMatchObject({ engine: "dstar" });
  });
});
