import type { Container } from "@/core/runtime/Runtime";
import type { Config } from "@/shared/config/schema";
// Pure inventory predicates. The capability supplies (slot,id) pairs read from a
// Container; this stays jsMacros-free and unit-testable.
import { isOre } from "@/shared/domain/scan";

export function isJunk(id: string, junkItems: readonly string[]): boolean {
  return junkItems.includes(id);
}

// Region names that belong to the player's own inventory screen. Anything else in
// regions() means an external container (chest/barrel/drawer) screen is open, so a
// shift-click quick-move deposits INTO it rather than shuffling our own slots.
const PLAYER_REGIONS = new Set([
  "hotbar",
  "main",
  "offhand",
  "armor",
  "boots",
  "leggings",
  "chestplate",
  "helmet",
  "crafting_in",
  "craft_out", // jsMacros' real region name (verified live; was "crafting_out" — a typo
  // that made the player's own result slot look like an external container)
]);

export function hasContainerOpen(regions: readonly string[]): boolean {
  return regions.some((r) => !PLAYER_REGIONS.has(r));
}

/** The non-player (external container / machine) regions of an open screen — every region that
 *  isn't part of the player's own inventory. Region-name-AGNOSTIC: a furnace, chest, drawer, or
 *  GTCEu machine all expose their slots under names we don't hardcode, so callers read those slots
 *  via `inv.slots(...containerRegions(regions))` instead of guessing region names. */
export function containerRegions(regions: readonly string[]): string[] {
  return regions.filter((r) => !PLAYER_REGIONS.has(r));
}

export function fullness(occupied: number, total: number): number {
  return total > 0 ? occupied / total : 0;
}

export interface SlotEntry {
  readonly slot: number;
  readonly id: string;
}

/** Total count of items across the carry inventory (main+hotbar) whose id is in `ids`. */
export function carryCount(c: Container, ids: ReadonlySet<string>): number {
  let n = 0;
  for (const slot of c.slots()) {
    const s = c.slot(slot);
    if (s && ids.has(s.id)) n += s.count;
  }
  return n;
}

/** Carry-inventory (main+hotbar) slot indices holding one of `ids` (in slot order — callers that
 *  shift-click sort descending themselves so a compacting impl can't invalidate lower indices). */
export function carrySlots(c: Container, ids: ReadonlySet<string>): number[] {
  const out: number[] = [];
  for (const slot of c.slots()) {
    const s = c.slot(slot);
    if (s && ids.has(s.id)) out.push(slot);
  }
  return out;
}

/** Build the {slot,id} entries for the given `slots` (default: the whole carry inventory), skipping
 *  empty slots. The one slot→SlotEntry reader the inventory/storage capabilities share. */
export function readEntries(c: Container, slots: number[] = c.slots()): SlotEntry[] {
  const out: SlotEntry[] = [];
  for (const slot of slots) {
    const s = c.slot(slot);
    if (s) out.push({ slot, id: s.id });
  }
  return out;
}

export function classify(
  entries: readonly SlotEntry[],
  cfg: Pick<Config, "inventory" | "ore">,
): { oreSlots: number[]; junkSlots: number[] } {
  const oreSlots: number[] = [];
  const junkSlots: number[] = [];
  for (const e of entries) {
    if (isOre(e.id, cfg)) oreSlots.push(e.slot);
    else if (isJunk(e.id, cfg.inventory.junkItems)) junkSlots.push(e.slot);
  }
  return { oreSlots, junkSlots };
}
