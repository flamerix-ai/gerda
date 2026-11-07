// Storage facet of the jsMacros runtime — reads a placed container WITHOUT opening it, via the
// Forge ITEM_HANDLER capability. Part of the exempt `src/core/runtime/jsmacros/` globals group.
import type { ContainerKindRule, ContainerView, ItemStack, Runtime } from "@/core/runtime/Runtime";
import { type Fx, stackOf } from "@/core/runtime/jsmacros/shared";
import { SRG } from "@/core/runtime/jsmacros/srg";
import type { Result, Vec3 } from "@/core/runtime/types";

// Minimal SRG-typed shapes for the remote-container read (Level.getBlockEntity returns a
// raw tile; getRaw().level() is declared `unknown`, so the storage read casts through these).
interface RawHandler {
  getSlots(): number;
  getStackInSlot(i: number): unknown;
}
interface RawTile {
  getCapability(cap: unknown, side: unknown): { orElse(d: unknown): RawHandler | null };
}
interface RawLevel {
  [SRG.getBlockEntity](bp: unknown): RawTile | null; // Level.getBlockEntity
  [SRG.getBlockState](bp: unknown): unknown; // Level.getBlockState
}

// Java class handles are resolved INSIDE read()'s `attempt`, never at module scope. A module-scope
// `Java.type` runs while worker.js evals the bundle, so ONE missing class kills the whole bundle
// load — measured on Fabric (intermediary class names, no `net.minecraft.core.BlockPos`)
// and on Forge < 1.19.2 (no ForgeCapabilities) the bundle never loaded (docs/PORTABILITY.md). Here a
// missing class is a per-call Result error naming it, and every other facet keeps working.
// test-ts/bundle-load.test.ts pins "loading the bundle performs no host class lookup".
const BLOCK_POS = "net.minecraft.core.BlockPos";
const FORGE_CAPS = "net.minecraftforge.common.capabilities.ForgeCapabilities";
const ITEM_STACK_HELPER = "xyz.wagyourtail.jsmacros.client.api.helpers.inventory.ItemStackHelper";

/** Coarse container kind from a block id (drawers are the only slot-aware case the storage
 *  geometry needs; everything else routes by shift-click). Rules are matched in order and
 *  supplied by the caller — the pack decides which mod ids are drawers, not this file. */
function classifyContainerKind(
  id: string,
  rules: readonly ContainerKindRule[],
): ContainerView["kind"] {
  for (const r of rules) if (id.includes(r.match)) return r.kind;
  return "container";
}

export function storageFacet(fx: Fx, kindRules: readonly ContainerKindRule[]): Runtime["storage"] {
  const { attempt } = fx;
  return {
    // Read a placed container WITHOUT opening it, via the Forge ITEM_HANDLER capability.
    // level().getBlockEntity(pos) → tile.getCapability(ITEM_HANDLER) → getSlots/getStackInSlot.
    // SRG names (entityLevel/getBlockEntity/getBlockState) resolve through the SRG map.
    // Item ids are read by wrapping the raw stack in jsMacros' own ItemStackHelper (the
    // registry route is unreliable here — see drawer_deposit derivation in ext.js).
    read(p: Vec3): Result<ContainerView> {
      return attempt(() => {
        const block = World.getBlock(p.x, p.y, p.z);
        if (!block) throw new Error(`no block at ${p.x},${p.y},${p.z}`);
        const id = block.getId();
        const pl = Player.getPlayer();
        if (!pl) throw new Error("no player");
        const BlockPos = Java.type(BLOCK_POS);
        const ForgeCaps = Java.type(FORGE_CAPS);
        const ISH = Java.type(ITEM_STACK_HELPER);
        const level = pl.getRaw()[SRG.entityLevel]() as RawLevel;
        const bp = new BlockPos(p.x, p.y, p.z);
        const tile = level[SRG.getBlockEntity](bp);
        if (!tile) throw new Error(`no block entity (${id})`);
        const handler = tile.getCapability(ForgeCaps.ITEM_HANDLER, null).orElse(null);
        if (!handler) throw new Error(`no item handler (${id})`);
        const n = handler.getSlots();
        const slots: (ItemStack | null)[] = [];
        for (let i = 0; i < n; i++) {
          slots.push(stackOf(new ISH(handler.getStackInSlot(i)) as ItemStackHelper));
        }
        const kind = classifyContainerKind(id, kindRules);
        let facing: string | null = null;
        if (kind === "drawer") {
          const m = String(level[SRG.getBlockState](bp)).match(/subfacing=(\w+)/);
          facing = m?.[1] ?? "north";
        }
        return { kind, facing, slots };
      });
    },
  };
}
