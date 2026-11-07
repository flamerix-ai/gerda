import { dist } from "@/core/prim/pos";
import type { Vec3 } from "@/core/runtime/types";
// nav-engine — the user-facing navigator-engine override. Production GOTO normally
// runs whatever cfg.nav.dStar bakes (A* by default). This slice lets the operator flip the engine at
// runtime WITHOUT a redeploy — "plan this route with D* Lite", "force A*", or "auto" (engage D* only
// on long legs). It mutates nothing in the baked Config; it derives a per-leg Config the navigation
// layer hands to greedyStep.
//
// HONEST CAVEAT (why this isn't a global "make it faster" switch): D* Lite only engages on a
// point-goal leg over the BOUNDED move set — no bridge/pillar/mine/waterDrop (dstar.ts engageable()).
// A mining leg that lays filler or digs as it moves keeps A* regardless of this override. So the real
// use of `dstar`/`auto` is a LONG SURFACE TRAVERSE between dig sites, not the digging itself.
import type { Config } from "@/shared/config/schema";
import type { Ctx } from "@/shared/kernel/capability";
import { defineSlice } from "@/shared/kernel/slice";

/** Operator-selected navigator engine. `default` = honour the baked cfg.nav.dStar (zero behaviour
 *  change); `astar`/`dstar` force one engine; `auto` engages D* only on legs ≥ cfg.nav.autoDStarDist. */
export type NavEngine = "default" | "astar" | "dstar" | "auto";

export const NAV_ENGINE_SLICE = defineSlice<{ mode: NavEngine }>("navEngine", () => ({
  mode: "default",
}));

/** Parse a free-form engine string from a command into a NavEngine (null if unknown). The switch
 *  narrows `s` to the literal union — no cast, so an added engine that isn't handled fails to type. */
export function parseNavEngine(raw: unknown): NavEngine | null {
  const s = String(raw ?? "").toLowerCase();
  switch (s) {
    case "default":
    case "astar":
    case "dstar":
    case "auto":
      return s;
    default:
      return null;
  }
}

/** Derive the per-leg Config the navigation layer drives greedyStep with, applying the runtime
 *  engine override. `default` returns cfg untouched; the others toggle cfg.nav.dStar (engageability
 *  still gates whether D* actually runs — see engageable()). `auto` flips D* on for a far goal only. */
export function navEngineCfg(ctx: Ctx, target: Vec3): Config {
  const { cfg, rt } = ctx;
  const { mode } = ctx.slice(NAV_ENGINE_SLICE);
  switch (mode) {
    case "default":
      return cfg;
    case "astar":
      return cfg.nav.dStar ? { ...cfg, nav: { ...cfg.nav, dStar: false } } : cfg;
    case "dstar":
      return cfg.nav.dStar ? cfg : { ...cfg, nav: { ...cfg.nav, dStar: true } };
    case "auto": {
      const p = rt.player.pos();
      const far = p.ok && dist(p.value, target) >= cfg.nav.autoDStarDist;
      return { ...cfg, nav: { ...cfg.nav, dStar: far } };
    }
  }
}
