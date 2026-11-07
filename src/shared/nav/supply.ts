import type { Runtime } from "@/core/runtime/Runtime";
// Navigator supply seams — the live bag/peer reads the pure planner can't do itself. The executor
// checks these and passes flags/sets into planPath; the planner stays pure data-in data-out.
import type { Config } from "@/shared/config/schema";
import { columnKey } from "@/shared/domain/movement-types";
import { fillerCount } from "@/shared/nav/place-cell";

/** SEAM — filler supply. The ONE place the bot judges "do I carry enough filler to commit
 *  to a place-chain (pillarUp/bridgePlace)?". Today it is pure detection — `enough` = ≥cfg.nav.fillerMin
 *  (not just >0: starting a bridge/pillar the bag can't finish strands the bot mid-route over a void).
 *  This is deliberately POLICYLESS: a future active-refill capability (mine cobble / RETURN-to-restock on
 *  empty) plugs in by READING this status and acting on it, without touching the planner or executor
 *  (for now the low-filler guard escalates; it does not refill). A
 *  read-only open — equipFiller does the actual hotbar dance later, only if a place move is executed. */
export interface FillerStatus {
  readonly count: number;
  readonly enough: boolean;
}
export function fillerStatus(rt: Runtime, cfg: Config): FillerStatus {
  const invR = rt.inv.open();
  const count = invR.ok ? fillerCount(invR.value, cfg.nav.fillerBlocks) : 0;
  return { count, enough: count >= cfg.nav.fillerMin };
}
export function hasFillerInBag(rt: Runtime, cfg: Config): boolean {
  return fillerStatus(rt, cfg).enough;
}

/** Does the bag carry a water bucket right now? Gates the planner's proactive waterDrop dive — the
 *  pure planner can't read inventory, so the executor checks here and passes the flag into planPath.
 *  The clutch reflex equips it for real at clutch-time; this is only the may-we-plan-a-dive gate. */
export function hasWaterBucketInBag(rt: Runtime, cfg: Config): boolean {
  const invR = rt.inv.open();
  if (!invR.ok) return false;
  const inv = invR.value;
  for (const slot of inv.slots()) {
    if (inv.slot(slot)?.id === cfg.safety.waterBucketId) return true;
  }
  return false;
}

/** PEER-AS-OBSTACLE: the X/Z columns nearby peers stand in (plus cfg.nav.peerClearance around
 *  each), as a PlanOpts.avoid set — peers read as AIR to the block reader, so without this the
 *  planner routes straight through a teammate. Rebuilt from the live snapshot every call, so the
 *  route cache's edgeValid re-vetoes a cached step a peer has since walked into (stale plan
 *  obstacles self-heal via replan-on-blocked). Returns undefined (zero planner overhead) when the
 *  feature is off or no peer is in range — the single-bot path is unchanged. Exported for tests. */
export function peerAvoidColumns(rt: Runtime, cfg: Config): Set<string> | undefined {
  if (!cfg.nav.peerObstacle) return undefined;
  const peersR = rt.world.peers(cfg.nav.peerRadius);
  if (!peersR.ok || peersR.value.length === 0) return undefined;
  const c = Math.max(0, Math.floor(cfg.nav.peerClearance));
  const out = new Set<string>();
  for (const p of peersR.value) {
    const px = Math.floor(p.x);
    const pz = Math.floor(p.z);
    for (let dx = -c; dx <= c; dx++) {
      for (let dz = -c; dz <= c; dz++) out.add(columnKey(px + dx, pz + dz));
    }
  }
  return out;
}
