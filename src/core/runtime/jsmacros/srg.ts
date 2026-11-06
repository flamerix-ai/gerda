// SRG member-name SSOT for the jsMacros facet group. GraalJS resolves Java members by their
// obfuscated SRG name (a Mojang name reads as `undefined` — see CLAUDE.md), so every raw vanilla
// method the facade calls goes through a NAMED key here instead of an inline `m_…_` token scattered
// across the facet files. ONE place to re-map after a pack/MC-version bump; the defensive checker
// (scripts/check-defensive.ts) forbids a raw `m_…_`/`f_…_` token in any other src/ CODE, so a new
// call CANNOT reintroduce a loose token. This mirrors the harness-side SRG map in harness
// (main.js's `srg()`); each entry cites its Mojang signature. Regenerate names after a version
// change via `python scripts/dev/srg.py --export harness/srg_names.json`.
//
// `as const` is load-bearing: it gives each value a string-LITERAL type, which lets a consumer use
// `raw[SRG.respawn]()` and (crucially) declare a computed interface member `[SRG.getBlockEntity](…)`
// — a computed interface key requires a literal-typed expression.
export const SRG = {
  getBlockEntity: "m_7702_", // Level.getBlockEntity(BlockPos) → BlockEntity
  getBlockState: "m_8055_", // Level.getBlockState(BlockPos) → BlockState
  entityLevel: "m_9236_", // Entity.level() → Level
  respawn: "m_7583_", // LocalPlayer.respawn() ()V — sends the PERFORM_RESPAWN client command
  onGround: "m_20096_", // Entity.onGround() → boolean
  jumpFromGround: "m_6135_", // LivingEntity.jumpFromGround() — the one-shot upward impulse
  getMainHandItem: "m_21205_", // LivingEntity.getMainHandItem() → ItemStack
  finishUsingItem: "m_41671_", // ItemStack.finishUsingItem(Level, LivingEntity)
  setYRot: "m_146922_", // Entity.setYRot(float)
  setXRot: "m_146926_", // Entity.setXRot(float)
} as const;

// The plain-JS harness (harness/main.js) keeps its OWN hardcoded token map for the render-thread
// "eyes & hands" screen primitives (click/scroll/type/keypress) + the main-thread sprint applier —
// those live in main.js because they run in the supervisor's Java scope, not the bundle. This is the
// ONE tsc-checked mirror of that map (a JS file can't be imported), colocated in the SRG-token SSOT so
// the boot self-check (src/shared/harness/srg-required.ts) can enumerate every raw token the SYSTEM depends
// on without scattering literals. Keep in lockstep with main.js's `SRG` map (drift is caught at boot:
// a token dropped here isn't checked; one dropped in main.js rots — the map is small and stable).
export const HARNESS_SCREEN_SRG = {
  mouseClicked: "m_6375_", // Screen.mouseClicked(x,y,button)
  mouseReleased: "m_6348_", // Screen.mouseReleased(x,y,button)
  mouseScrolled: "m_6050_", // Screen.mouseScrolled(x,y,amount)
  charTyped: "m_5534_", // Screen.charTyped(char,modifiers)
  keyPressed: "m_7933_", // Screen.keyPressed(key,scancode,modifiers)
  keyReleased: "m_7920_", // Screen.keyReleased(key,scancode,modifiers)
  setSprinting: "m_6858_", // Entity.setSprinting(sprinting)
} as const;
