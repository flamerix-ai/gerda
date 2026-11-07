// The declared SRG dependency set the boot self-check (harness/main.js) verifies against the live
// srg_names.json of the running pack. This is the KNOWABLE surface of "every SRG name the code depends
// on": the two hardcoded token maps (which bypass the Mojang-name index and so can't self-check by
// lookup) plus the raw-vanilla `srg(cls, member)` call sites that today only fail-loud WHEN CALLED —
// often mid-run on the render thread. Enumerating them here lets boot resolve them all up front and
// scream once, instead of discovering rot one dropped-world-later at a time.
//
// Adding a new hardcoded `m_…_` token or a new `srg("Class","member")` call site → add it here (and to
// the safe-io.js mirror, which the contract test forces). This is the contract; the list is small.
import { SRG as BUNDLE_SRG, HARNESS_SCREEN_SRG } from "@/core/runtime/jsmacros/srg";
import type { SrgRequirement } from "@/shared/harness/srg-index";

/** main.js's hardcoded screen-primitive `SRG` map (eyes & hands: click/scroll/type/keypress + the
 *  main-thread sprint applier). Called by raw token, not through `srg()`, so they're checked by TOKEN
 *  PRESENCE in srg_names.json (findMissingTokens). DERIVED from the exempt SRG-token SSOT
 *  (jsmacros/srg.ts `HARNESS_SCREEN_SRG`, kept in lockstep with the map in main.js) so no raw token is
 *  inlined here. */
export const HARNESS_SRG_TOKENS: readonly string[] = Object.values(HARNESS_SCREEN_SRG);

/** The worker bundle's SRG member map (src/core/runtime/jsmacros/srg.ts) — also raw-token calls, checked by
 *  token presence. DERIVED from the bundle SSOT so a new bundle SRG entry can't silently escape the
 *  boot check (the contract test forces the safe-io.js mirror to match). srg_names.json is the ONE map
 *  the whole system shares, so main.js's boot check covering these tokens covers the bundle too — no
 *  separate worker-side wiring needed for the token half. */
export const BUNDLE_SRG_TOKENS: readonly string[] = Object.values(BUNDLE_SRG);

/** Every hardcoded SRG token the running system depends on (harness + bundle), verified present in
 *  srg_names.json at boot. */
export const REQUIRED_SRG_TOKENS: readonly string[] = [...HARNESS_SRG_TOKENS, ...BUNDLE_SRG_TOKENS];

/** The raw-vanilla `srg("Class","member")` call sites in the harness (ext.js) that must resolve for the
 *  feature that uses them to work. Verified by NAME LOOKUP (findMissingSrg) so a rename or a mapping
 *  gap is caught at boot, not lazily mid-run. */
export const REQUIRED_SRG_MEMBERS: readonly SrgRequirement[] = [
  { cls: "LocalPlayer", member: "respawn" }, // auto-respawn / recover
  { cls: "CompoundTag", member: "contains" }, // prospector NBT read
  { cls: "CompoundTag", member: "getCompound" },
  { cls: "ItemStack", member: "isDamageableItem" }, // durability read
  { cls: "ItemStack", member: "getDamageValue" },
  { cls: "ItemStack", member: "getMaxDamage" },
  { cls: "ItemStack", member: "getTag" },
  { cls: "Minecraft", member: "getInstance" }, // volumetric block-state scan
  { cls: "Minecraft", member: "level" },
  { cls: "RenderChunkRegion", member: "getBlockState" },
  { cls: "RenderChunkRegion", member: "getBlockEntity" },
  { cls: "TagKey", member: "location" }, // ore-tier tag read
];
