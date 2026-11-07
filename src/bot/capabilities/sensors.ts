import { stockOf, veinReading } from "@/bot/orchestrator/sensors";
// sensors capability — a live read-out of the sustain-loop sensors (vein exhaustion + item
// stock) so the operator can watch what the autonomous cycle's guards see, without running a
// plan. Read-only: it never transitions. `sensors {items?: string[], includeStorage?: bool}`
// reports the vein reading plus the count of each requested item id (carry, or +open storage).
import type { Capability, Ctx } from "@/shared/kernel/capability";

export const sensors: Capability = {
  name: "sensors",

  commands: {
    sensors(ctx: Ctx, cmd: Record<string, unknown>): void {
      const rawItems = cmd["items"];
      const items = Array.isArray(rawItems)
        ? rawItems.filter((x): x is string => typeof x === "string")
        : [];
      const includeStorage = cmd["includeStorage"] === true;
      const stock: Record<string, number> = {};
      for (const id of items) stock[id] = stockOf(ctx, id, { includeStorage });
      ctx.reply({ vein: veinReading(ctx), stock, includeStorage });
    },
  },
};
