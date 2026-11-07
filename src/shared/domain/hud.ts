// Pure HUD line formatter — the capability gathers live data and passes it here so
// the layout stays unit-testable (no jsMacros).
import { idPath } from "@/core/prim/pos";

export interface HudData {
  readonly phase: string;
  readonly running: boolean;
  readonly phaseTicks: number;
  readonly toolId: string | null;
  readonly toolPct: number | null;
  readonly waypoints: number;
  readonly dumps: number;
  readonly veinsFound: number;
}

export function formatHudLines(d: HudData): string[] {
  const status = d.running ? `${d.phase} (${d.phaseTicks}t)` : "STOPPED";
  const tool = d.toolId ? `${idPath(d.toolId)} ${d.toolPct ?? "?"}%` : "-";
  return [
    `§6Miner§r: ${status}`,
    `Tool: ${tool}`,
    `WP:${d.waypoints} Dump:${d.dumps} Vein:${d.veinsFound}`,
  ];
}
