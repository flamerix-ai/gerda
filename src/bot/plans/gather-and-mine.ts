// gather-and-mine — a demonstration plan: chop wood for tools/fuel, then mine ore.
// Both gathering steps require bag headroom so they don't immediately overflow. The
// orchestrator validates each step's mission name against the registry before starting,
// so a typo'd mission parks the plan in `failed` rather than running a no-op.
import { inventoryHasRoom } from "@/bot/orchestrator/guards";
import type { Plan } from "@/bot/orchestrator/plan";

export const gatherAndMine: Plan = {
  name: "gather-and-mine",
  defaultMode: "auto",
  steps: [
    { mission: "chop", id: "wood", params: { count: 8 }, guards: [inventoryHasRoom(0.9)] },
    { mission: "mine", id: "ore", guards: [inventoryHasRoom(0.9)] },
  ],
};
