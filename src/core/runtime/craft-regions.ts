// Shared crafting-grid region resolution — used by BOTH the real runtime (jsmacros.ts) and
// the mock, so the fallback ordering can't drift between them and is unit-testable in
// isolation (the real impl can't run outside the game). The grid region name differs by
// which screen is open: the player 2×2 inventory exposes "crafting_in"/"craft_out", while a
// 3×3 crafting TABLE exposes "input"/"output" (live-confirmed: an open table reports regions
// ["output","input",…]). Resolve by trying the player names first, then the table names.
//
// `getSlots(region)` mirrors jsMacros' InventoryHelper.getSlots — it returns the slot
// indices for a region, or an empty array when that region isn't present on the open screen.

type SlotsFn = (region: string) => number[];

/** Input-grid slot indices for the open crafting screen (player 2×2 or table 3×3),
 *  or [] if no crafting grid is open. */
export function craftGridSlots(getSlots: SlotsFn): number[] {
  const cin = getSlots("crafting_in");
  return cin.length > 0 ? cin : getSlots("input");
}

/** Result-slot index for the open crafting screen, or undefined if none is open. */
export function craftOutSlot(getSlots: SlotsFn): number | undefined {
  const co = getSlots("craft_out");
  return (co.length > 0 ? co : getSlots("output"))[0];
}
