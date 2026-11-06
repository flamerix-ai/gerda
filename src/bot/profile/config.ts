import { GERDA_PACK } from "@/bot/profile/pack";
// GERDA BOT'S CONFIG ENTRY POINT — bot tier.
//
// Shared `makeConfig` yields a pack-NEUTRAL config: the Config TYPE is complete, but every
// pack-specific field (ore ids, filler/junk/food item ids, recipes, base coords, container kinds)
// is empty, because src/shared/config/schema.ts is SHARED code and must never name a mod id. This is the
// bot's PACK-LOADED counterpart: it stacks GERDA_PACK as the first layer, so everything the
// shipped bot resolves to comes from src/bot/profile/pack.ts, and any caller layer (the build-time
// local.overrides.json, a test's tweak) still merges on top and wins.
import { type Config, type ConfigOverrides, makeConfig } from "@/shared/config/schema";

/** Build THIS bot's config: DEFAULT_CONFIG ← the Gerda pack profile ← `layers` (left-to-right). */
export function makeGerdaConfig(...layers: ConfigOverrides[]): Config {
  return makeConfig(GERDA_PACK, ...layers);
}
