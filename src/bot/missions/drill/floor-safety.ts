import { skipUnreachableVein } from "@/bot/missions/drill/select-vein";
import { DRILL_SLICE } from "@/bot/missions/drill/state";
import { STATE } from "@/bot/profile/states";
import { canSurviveFall } from "@/core/prim/movement-physics";
import type { Vec3 } from "@/core/runtime/types";
// floor-safety — the drill mission's dig-down SAFETY policy, split out of descend.ts (SRP). The
// pure verdict (floorVerdict) + the footprint geometry (footprintAt) answer "is it safe to break
// the support under our feet"; floorUnsafe wires the verdict into the mission (log + graceful
// PAUSE once bands are mined, else record-drowned + skip via select-vein). The DESCEND handler in
// descend.ts calls floorUnsafe/footprintAt/recordDrowned; only the pure pair is unit-tested.
import { isWater } from "@/shared/domain/block-traits";
import { type BlockReader, hazardAt } from "@/shared/domain/senses";
import { writeHazardMarker } from "@/shared/domain/world-model";
import type { Ctx } from "@/shared/kernel/capability";

export const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);

/** Verdict for breaking the support cell `b` (a foot column at feet.y-1) and falling onto whatever
 *  is below. Pure — over an HONEST reader (null = UNKNOWN). The safe-digging rule:
 *   • `unknown` — the block we'd break, or any cell of the fall column down to the landing, is
 *     unreadable. "Never dig under yourself unless you know what is below."
 *     Never assume solid; refuse.
 *   • `hazard`  — the floor or the cell directly under it is lava/fire/magma.
 *   • `water`   — the block we'd break, or a cell in the fall column, is water. Landing in water is
 *     harmless for a general fall, but a 1-wide auto-shaft that opens into an aquifer FLOODS: the bot
 *     sits at the bottom of a water column it can't break (water is unmineable) and DROWNS. So the
 *     descent refuses to dig into water rather than plunge into a drowning trap (a player drowned exactly this way in live play).
 *   • `void`    — breaking opens a fall deeper than `maxFall` (or one that would damage past
 *     `maxFallDamage`): a cave/void we'd plunge into.
 *   • `safe`    — known solid landing within a tolerable drop.
 *  This is the constructive form of the user's principle: digging through KNOWN terrain (cache or
 *  live) is fine; only the UNKNOWN frontier is refused. */
export type FloorVerdict = "safe" | "hazard" | "water" | "void" | "unknown";

export function floorVerdict(
  read: BlockReader,
  b: Vec3,
  maxFall: number,
  maxFallDamage: number,
): FloorVerdict {
  const here = read(b.x, b.y, b.z);
  if (here === null) return "unknown"; // the block we'd break must be known
  if (isWater(here)) return "water"; // the floor we'd break IS water → drown trap, don't dig in
  if (hazardAt(read, b) || hazardAt(read, { x: b.x, y: b.y - 1, z: b.z })) return "hazard";
  // Fall column from just below the broken floor: every cell KNOWN until a solid landing; an
  // unknown cell short-circuits to `unknown` (don't fall into what we can't see), and water is a
  // drowning trap for a 1-wide shaft (floods, unbreakable) — refuse rather than land in it.
  let fall = 0;
  for (let dy = 1; dy <= maxFall + 1; dy++) {
    const id = read(b.x, b.y - dy, b.z);
    if (id === null) return "unknown";
    if (isWater(id)) return "water"; // fall column opens into water → flood/drown, refuse
    if (!AIR.has(id)) break; // solid landing reached
    fall++;
  }
  // Prevention (task-specific, stays here per the safety boundary): refuse to open a shaft floor
  // over a drop too deep OR one that would hurt to land in — via the unified SSOT predicate.
  if (fall > maxFall || !canSurviveFall(fall + 1, { maxFallDamage })) return "void";
  return "safe";
}

/** The block columns the player's AABB rests on, at level `y`. The bot rarely stands
 *  block-centred, so a 0.6-wide body straddles 1–4 columns; the shaft must clear every one or
 *  the bot wedges on a leftover support. Returns each support cell at `y`. */
export function footprintAt(hw: number, pos: Vec3, y: number): Vec3[] {
  const xs = [...new Set([Math.floor(pos.x - hw), Math.floor(pos.x + hw)])];
  const zs = [...new Set([Math.floor(pos.z - hw), Math.floor(pos.z + hw)])];
  const out: Vec3[] = [];
  for (const x of xs) for (const z of zs) out.push({ x, y, z });
  return out;
}

/** Record the current drill column as a `drowned` hazard in mc_world.json (read-modify-write on the
 *  worker thread, mirroring search's recordFound) so `selectDrillVein` skips it next time. Keyed to
 *  the VEIN marker's X/Z (what the selector filters on), falling back to the shaft column. Best-effort:
 *  a write failure is logged, not fatal — the run is aborting anyway. */
export function recordDrowned(ctx: Ctx, at: Vec3): void {
  const drill = ctx.slice(DRILL_SLICE);
  const col = drill.vein ? { x: drill.vein.x, z: drill.vein.z } : { x: at.x, z: at.z };
  const res = writeHazardMarker(ctx, "drowned", col.x, col.z, ctx.st.tickCount);
  if (res.status === "written") ctx.log.info(ctx.st.tickCount, "DRILL_DROWNED_MARKED", { ...col });
  else if (res.status === "write-failed")
    ctx.log.warn(ctx.st.tickCount, "DRILL_DROWNED_MARK_FAIL", { err: res.error });
}

/** Breaking the floor under us is unsafe — an UNKNOWN cell below (dig-blind), a hazard adjacent to
 *  any support column, or a fall deeper than tolerated (cave/void)? Reads with the HONEST reader so
 *  an unreadable cell is refused, never assumed solid stone. Logs the DRILL_* cause, then PAUSEs
 *  (bands already mined) or skips the vein via skipUnreachableVein; returns true. */
export function floorUnsafe(ctx: Ctx, kr: BlockReader, foot: Vec3[]): boolean {
  const { cfg, st } = ctx;
  for (const b of foot) {
    const verdict = floorVerdict(kr, b, cfg.drill.maxFall, cfg.nav.maxFallDamage);
    if (verdict === "safe") continue;
    // Multi-band terminus ("dig every vein on the way down"): once the descent has already stripped
    // ≥1 band, an unsafe floor below (void/water/hazard/unknown) is just the bottom of what the
    // shaft can safely reach — the veins are mined, so STOP gracefully (PAUSED). A shaft that hit
    // an unsafe floor having mined NOTHING logs its distinct DRILL_* cause below and skips the vein
    // (skipUnreachableVein → next cached vein, or PAUSED when none remain).
    if (ctx.slice(DRILL_SLICE).bandsMined > 0) {
      ctx.log.info(st.tickCount, "DRILL_DEPTH_DONE", {
        at: b,
        verdict,
        bands: ctx.slice(DRILL_SLICE).bandsMined,
      });
      ctx.transition(STATE.PAUSED, "drill: can't safely dig deeper — all reachable bands mined");
      return true;
    }
    const event =
      verdict === "hazard"
        ? "DRILL_HAZARD"
        : verdict === "water"
          ? "DRILL_WATER"
          : verdict === "unknown"
            ? "DRILL_UNKNOWN_BELOW"
            : "DRILL_VOID";
    ctx.log.warn(st.tickCount, event, { at: b, verdict });
    // The shaft opened into water OR a void having mined nothing → this column is a dead dig. Mark
    // it persistently ("mark it and don't come back" — Layer 3 of the drowning fix): without the
    // mark a re-enqueued mission re-digs the SAME doomed shaft (session skip-set resets per
    // mission), while with it veinDigColumn re-aims the vein at an alternate bbox column (live:
    // the silver shaft dug 150 blocks to y-42, hit a cave, and a naive re-run would
    // have done it all again).
    if (verdict === "water" || verdict === "void") recordDrowned(ctx, b);
    // The shaft can't be productively dug (void/water/hazard/unknown below) and NOTHING was mined
    // here — e.g. a vein sitting on a ravine edge where digging down just opens the void
    // (live-caught on a gold vein). Rather than fail loud, treat it like an unreachable vein: skip
    // to the next cached vein, or PAUSE when none remain ("skip them without falling into ERROR").
    // The distinct DRILL_* event above keeps the real cause visible; skipUnreachableVein owns the
    // skip-set + re-target/PAUSE.
    skipUnreachableVein(ctx);
    return true;
  }
  return false;
}
