import type { Plan } from "@/bot/orchestrator/plan";
import { makeGerdaConfig } from "@/bot/profile/config";
// sustain-cycle — Stage 2 of the sustain loop: the INFINITE autonomous economy
// (mine→smelt→craft→repair). Where Stage 1 (sustain-mine-smelt) was a finite linear proof, this is
// the real loop the bot runs unattended while the user does the complex work:
//
//   mine a batch → walk to base → COLLECT ready ingots → LOAD the new ore → PROSPECT next vein → repeat
//
// The last step's `next: () => 0` branches the chain back to step 0, so it never finishes — the
// operator stops it with `plan_abort` / `halt`. There are deliberately NO blocking guards on the
// steps: the orchestrator's guards PARK the plan when they fail (they gate entry, they don't skip),
// which would stall an unattended loop — so the cycle is unconditional and self-bounding (mine stops
// at `count` OR on exhaustion, each smelt finishes its sub-cycle). Bag-full mid-mine is handled
// INSIDE the mine mission (its own inventory→DUMP), not here.
//
// THE DEFER/COLLECT OVERLAP, for free: each lap LOADs this batch's ore and leaves it cooking
// server-side (a furnace cooks in a loaded chunk whether or not the bot waits — smelt `mode:load`),
// then the NEXT lap COLLECTs it. So collect finds nothing on lap 1 and harvests lap (N-1)'s ingots
// on lap N — the bot never babysits a smelt. (collect-before-load each lap: drain the finished
// batch, then start the fresh one.)
//
// THE DYNAMIC SHAFT (the #21 fix): the final leg is `prospect`, NOT a fixed `goto SHAFT`. It walks
// the bot to the nearest non-depleted vein from the HV prospector's cache (mc_world.json resources[]
// — the human runs the prospector to seed it; the worker can't drive that GUI). When the current
// vein runs dry, mine SELF-COMPLETES on exhaustion (mining-mem `exhausted`) and persistence marks it
// depleted, so next lap `prospect` picks the NEXT vein — the loop walks itself across a field of
// veins instead of grinding one fixed coord. With an empty cache prospect is a no-op (found:false)
// and mine just SCANs locally around base — the loop still runs, it just doesn't relocate.
//
// Base coord + ore/ingot/fuel ids + batch size all come from config (cfg.sustain*), which defaults
// to the sustain-cycle arena and is overridden per real deployment — the plan SHAPE is fixed.
import type { Config } from "@/shared/config/schema";

/** Build the sustain loop bound to this config's base/ore/fuel/batch. */
export function makeSustainCycle(cfg: Config): Plan {
  const base = { x: cfg.sustain.basePos.x, y: cfg.sustain.basePos.y, z: cfg.sustain.basePos.z };
  const ore = cfg.sustain.oreItem;
  const ingot = cfg.sustain.ingotItem;
  const fuel = cfg.sustain.fuelItem;
  return {
    name: "sustain-cycle",
    defaultMode: "auto",
    steps: [
      // 0 — dig a bounded batch (mine self-completes at `count` OR on exhaustion → step advances).
      { mission: "mine", id: "mine", params: { count: cfg.sustain.mineCount } },
      // 1 — walk to the base furnace bank.
      { mission: "goto", id: "to-base", params: base },
      // 2 — collect the PREVIOUS lap's ingots (cooked while we mined). Nothing on lap 1.
      { mission: "smelt", id: "collect", params: { mode: "collect", output: ingot, ...base } },
      // 3 — load THIS lap's raw ore and leave it cooking unattended (defer).
      {
        mission: "smelt",
        id: "load",
        params: { mode: "load", input: ore, output: ingot, fuel, ...base },
      },
      // 4 — restock small parts (#22): top up the carried stock of a "small part" from what the
      //     loop produces. CONDITIONAL via craft `want`/`min` — no-ops (DONE same tick) when we
      //     already carry ≥min OR the ingredients are short, so the unattended loop never stalls
      //     or ERRORs here. Default = iron nuggets from a smelted ingot (2×2 grid → table:false).
      {
        mission: "craft",
        id: "restock",
        params: {
          want: cfg.sustain.restockItem,
          min: cfg.sustain.restockMin,
          chain: cfg.sustain.restockChain,
          table: false,
        },
      },
      // 5 — replace the worn tool (#23): keep a fresh SPARE pickaxe so the tool reflex always
      //     has a backup to hot-swap to (autonomous "worn? craft new"). Same conditional craft —
      //     no-ops when ≥min spares carried OR materials/table short (3×3 → table:true, places its
      //     own crafting table from a carried one). The bot starts on a diamond pickaxe; a crafted
      //     iron spare is a valid same-kind backup (toolKind is material-agnostic).
      {
        mission: "craft",
        id: "tool",
        params: {
          want: cfg.sustain.toolItem,
          min: cfg.sustain.toolMin,
          chain: cfg.sustain.toolChain,
        },
      },
      // 6 — UNLOAD the surplus into the base storage network (drawers/chests the user configured
      //     via storage_scan/add). Smart-routes each id (type-match → category → empty). Runs AFTER
      //     the crafts so they keep their ingots; skip-safe (empty registry / nothing to deposit →
      //     self-completes). Walks within the base, so it's a cheap leg between the furnace bank
      //     and the next vein. `items: []` (cfg) makes this a same-tick no-op.
      {
        mission: "storage",
        id: "store",
        params: { items: cfg.sustain.storeItems },
      },
      // 7 — walk to the nearest non-depleted prospected vein (the dynamic shaft), then loop to
      //     step 0 forever (the autonomy). Empty cache → no-op, mine SCANs locally next lap.
      { mission: "prospect", id: "to-vein", params: { ore: cfg.sustain.oreKind }, next: () => 0 },
    ],
  };
}

/** Pack-default sustain loop (the arena/dev binding; worker-bundle builds its own from live cfg).
 *  Bot tier, so it binds the PACK-LOADED config — the shared defaults carry no ore/ingot ids. */
export const sustainCycle: Plan = makeSustainCycle(makeGerdaConfig());
