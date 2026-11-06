import type { Container, ItemStack, Runtime } from "@/core/runtime/Runtime";
// The item in the player's selected hotbar slot. Shared by safety (durability
// tiers / hot-swap) and scan (tool-specific mining strategy). Vanilla hotbar slots
// are the inventory indices 36..44; selectedHotbar() is 0..8.
import { kindSatisfiesClass, toolClassForBlock, toolKind } from "@/shared/domain/tooling";

export const HOTBAR_VANILLA_START = 36;
/** Vanilla hotbar width — inventory indices 36..44 (a physical UI invariant, not a tunable). */
export const HOTBAR_SLOTS = 9;

/** Is this vanilla carry-slot index one of the 9 hotbar slots (36..44)? The "already reachable
 *  without a swap" predicate every equip dance branches on. */
export function isHotbar(slot: number): boolean {
  return slot >= HOTBAR_VANILLA_START && slot < HOTBAR_VANILLA_START + HOTBAR_SLOTS;
}

/** Inventory index of the currently-held hotbar slot, or -1 if unavailable. */
export function heldSlotIndex(inv: Container): number {
  const sel = inv.selectedHotbar();
  return sel >= 0 && sel < HOTBAR_SLOTS ? HOTBAR_VANILLA_START + sel : -1;
}

export function heldFrom(inv: Container): ItemStack | null {
  const i = heldSlotIndex(inv);
  if (i < 0) return null;
  // The inventory menu transiently reports ZERO slots (boot / world not yet loaded);
  // reading a hotbar index then throws "Index N out of bounds for length 0". Treat an
  // empty inventory as "held item not readable yet" (null) rather than letting the read
  // throw and spam an FX_FAIL every tick. (jsMacros' getSlots() with NO args also returns
  // empty, so we probe the "hotbar" region specifically.) totalSlots() catches the OTHER
  // empty-menu shape: a custom mod GUI (the prospector) whose region MAP still claims
  // hotbar indices while the menu slot list is EMPTY — live FX_FAIL spam on an open
  // prospector screen.
  if (inv.totalSlots() === 0 || inv.slots("hotbar").length === 0) return null;
  return inv.slot(i);
}

export function heldStack(rt: Runtime): ItemStack | null {
  const invR = rt.inv.open();
  return invR.ok ? heldFrom(invR.value) : null;
}

/** Carry-inventory slot (vanilla index) holding the freshest ore-mining tool — pickaxe, GTCEu
 *  drill, or hammer (an axe fells trees, not ore, so it's excluded) — or -1 if the bag has none. */
function bestMiningToolSlot(inv: Container): number {
  let best = -1;
  let bestDur = -1;
  for (const slot of inv.slots()) {
    const it = inv.slot(slot);
    if (!it) continue;
    const k = toolKind(it.id);
    if (k !== "pickaxe" && k !== "drill" && k !== "hammer") continue;
    if (it.durabilityPct > bestDur) {
      bestDur = it.durabilityPct;
      best = slot;
    }
  }
  return best;
}

/** Ensure a real TOOL is held before breaking. The bot's own prospect/scan step leaves the
 *  prospector (toolKind "none") held, and breaking ore with it is a SILENT no-op that only
 *  surfaces as a DRILL_BREAK_TIMEOUT minutes later (live-diagnosed). If the held item
 *  is NOT a tool (prospector / a stack of filler / empty), equip the freshest pickaxe-class tool.
 *  Any real tool already held is LEFT ALONE — so the chop mission keeps its axe; only a non-tool
 *  is replaced. Returns false if the bag has no mining tool (caller keeps the current item — no
 *  worse than before). Cheap: one inventory read; call once per new break target, not per tick. */
export function ensureMiningTool(rt: Runtime): boolean {
  const invR = rt.inv.open();
  if (!invR.ok) return false;
  const inv = invR.value;
  if (toolKind(heldFrom(inv)?.id ?? null) !== "none") return true; // any tool: respect caller intent
  const slot = bestMiningToolSlot(inv);
  if (slot < 0) return false;
  equipSlot(inv, slot);
  return true;
}

/** Bring a carry slot into the hand (select if already on the hotbar, else swap into the held
 *  hotbar slot). The canonical "select-or-swap" dance — safety/tool/craft/maintenance all reuse
 *  this rather than re-inlining the hotbar branch. NOTE: the non-hotbar path swaps into
 *  the CURRENT held slot (displacing whatever is held); callers that need an EMPTY-hotbar-slot
 *  preference (filler/bucket, so the tool isn't clobbered) roll their own — see equipFiller. */
export function equipSlot(inv: Container, slot: number): void {
  if (isHotbar(slot)) {
    inv.selectHotbar(slot - HOTBAR_VANILLA_START);
  } else {
    inv.swap(slot, HOTBAR_VANILLA_START + inv.selectedHotbar());
  }
}

/** Freshest tool in the bag whose kind satisfies `cls`, or -1. */
function bestToolSlotFor(inv: Container, cls: "pickaxe" | "axe" | "shovel"): number {
  let best = -1;
  let bestDur = -1;
  for (const slot of inv.slots()) {
    const it = inv.slot(slot);
    if (!it) continue;
    if (!kindSatisfiesClass(toolKind(it.id), cls)) continue;
    if (it.durabilityPct > bestDur) {
      bestDur = it.durabilityPct;
      best = slot;
    }
  }
  return best;
}

/** Ensure the RIGHT tool for the block about to be broken is held ("sand with a shovel, wood
 *  with an axe, not a pickaxe"): classify the target block (sand→shovel, wood→axe,
 *  stone/ore→pickaxe family) and equip the freshest matching tool from the bag. Class not
 *  represented in the bag → degrade to ensureMiningTool's old contract (any real tool held is
 *  respected, a non-tool is swapped for a mining tool) so a shovel-less bot still digs dirt
 *  with what it has instead of the bare fist. Cheap: one inventory read; call once per new
 *  break target, not per tick. */
export function ensureToolFor(rt: Runtime, blockId: string | null): boolean {
  const cls = toolClassForBlock(blockId);
  if (cls === "none") return ensureMiningTool(rt);
  const invR = rt.inv.open();
  if (!invR.ok) return false;
  const inv = invR.value;
  if (kindSatisfiesClass(toolKind(heldFrom(inv)?.id ?? null), cls)) return true; // already right
  const slot = bestToolSlotFor(inv, cls);
  if (slot < 0) return ensureMiningTool(rt); // no such class in the bag → old behaviour
  equipSlot(inv, slot);
  return true;
}

/** Make the held (selected-hotbar) item be `id`, staging it out of the main inventory into the
 *  held hotbar slot if it isn't already on the hotbar (mirrors ensureMiningTool's select/swap).
 *  The drawer-deposit primitive: a USE interaction deposits whatever is HELD. Returns the vanilla
 *  carry slot now held, or -1 if the bag has no `id`. */
export function holdItemById(inv: Container, id: string): number {
  const heldI = heldSlotIndex(inv);
  if (heldI >= 0 && inv.slot(heldI)?.id === id) return heldI; // already held
  let src = -1;
  for (const slot of inv.slots()) {
    if (inv.slot(slot)?.id === id) {
      src = slot;
      break;
    }
  }
  if (src < 0) return -1;
  if (isHotbar(src)) {
    inv.selectHotbar(src - HOTBAR_VANILLA_START);
    return src;
  }
  const dest = HOTBAR_VANILLA_START + inv.selectedHotbar();
  inv.swap(src, dest); // bring it into the held slot (the prior held item swaps back to main)
  return dest;
}
