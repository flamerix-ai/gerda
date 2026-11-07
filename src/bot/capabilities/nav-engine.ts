// navEngine capability — the always-on command surface for the runtime navigator-engine override.
// `nav_engine {engine}` lets the operator say "plan routes with D* Lite" (or force A*,
// or `auto` = D* on long legs only) without a redeploy. The override lives in NAV_ENGINE_SLICE; the
// production GOTO (missions/mine/navigation.ts) reads it via navEngineCfg per leg. See nav-engine.ts
// for the honest caveat (D* only engages on filler-free legs → it helps long surface travel, not the
// digging itself).
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { NAV_ENGINE_SLICE, parseNavEngine } from "@/shared/nav/engine";

export const navEngine: Capability = {
  name: "navEngine",

  commands: {
    // nav_engine {engine} — set the navigator engine for production GOTO legs.
    //   default → honour cfg.nav.dStar (A* unless baked on); astar/dstar → force one engine;
    //   auto → engage D* Lite only on legs ≥ cfg.nav.autoDStarDist. No arg → report the current mode.
    nav_engine(ctx: Ctx, cmd: Record<string, unknown>): void {
      const slice = ctx.slice(NAV_ENGINE_SLICE);
      const raw = cmd["engine"];
      if (raw === undefined || raw === null || raw === "") {
        ctx.reply({ engine: slice.mode, autoDist: ctx.cfg.nav.autoDStarDist });
        return;
      }
      const mode = parseNavEngine(raw);
      if (mode === null) {
        ctx.reply({ error: `unknown engine '${String(raw)}' — use default|astar|dstar|auto` });
        return;
      }
      slice.mode = mode;
      ctx.reply({ engine: slice.mode, autoDist: ctx.cfg.nav.autoDStarDist });
    },
  },
};
