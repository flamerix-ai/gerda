// sustain-mine-smelt — Stage 1 of the autonomous sustain loop (the productive pipeline core):
// mine a fixed batch of ore, then smelt it into ingots. LINEAR + finite so it's bounded and
// arena-testable — it proves the missions chain through the orchestrator: `mine {count}` now
// self-completes (brokenCount ≥ goal), the orchestrator advances to `smelt`, and a full
// load→wait→collect furnace cycle turns the dug raw ore into ingots.
//
// NOT YET the full autonomous loop — that "later" phase adds: looping forever (next → step 0),
// a base-return walk between mining and the furnace bank, fanning smelt `mode:load` across many
// furnaces + mining the NEXT batch while they cook + a `mode:collect` sweep (the defer/collect
// overlap pays off there, not in a back-to-back linear chain), restock-craft on lowStock, tool
// repair, and prospecting a new shaft on veinExhausted. The sensors + smelt modes for all of
// that already exist (orchestrator/sensors.ts, smelt mode:load/collect); this is the seed.
//
// Base coords are pinned to the sustain-base arena's middle furnace (5,101,1) — they move to
// config / a "base" waypoint when the loop binds a real base.
import { inventoryHasRoom } from "@/bot/orchestrator/guards";
import type { Plan } from "@/bot/orchestrator/plan";

const FURNACE = { x: 5, y: 101, z: 1 };
const ORE = "minecraft:raw_iron"; // what iron ore drops (the smelt input)
const INGOT = "minecraft:iron_ingot";

export const sustainMineSmelt: Plan = {
  name: "sustain-mine-smelt",
  defaultMode: "auto",
  steps: [
    // Mine a fixed batch (stop at count → the step completes → advance). Skip if the bag is full.
    { mission: "mine", id: "mine", params: { count: 3 }, guards: [inventoryHasRoom(0.95)] },
    // Smelt the dug raw ore into ingots (full cycle: load + wait + collect).
    {
      mission: "smelt",
      id: "smelt",
      params: { mode: "full", input: ORE, output: INGOT, fuel: "minecraft:coal", ...FURNACE },
    },
  ],
};
