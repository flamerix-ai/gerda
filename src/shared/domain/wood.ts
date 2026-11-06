// Pure wood predicates for the chop-wood mission — mirrors domain/scan.ts isOre but
// for tree blocks. No jsMacros: takes plain ids so it's unit-testable.
import type { Config } from "@/shared/config/schema";

export function isLog(id: string, cfg: Pick<Config, "chop">): boolean {
  if (cfg.chop.logIds.has(id)) return true;
  // Covers modded logs + the 6-sided "_wood" / stripped variants (all end in _log/_wood).
  return cfg.chop.allowAllLogs && (id.endsWith("_log") || id.endsWith("_wood"));
}

export function isLeaves(id: string): boolean {
  return id.endsWith("_leaves");
}

export function isSapling(id: string): boolean {
  return id.endsWith("_sapling");
}
