import { DRILL_RUN, DRILL_SLICE, resetDrillRun, veinKey } from "@/bot/missions/drill/state";
import { MINING_SLICE, setNavOverride } from "@/bot/missions/mine/mining-mem";
import { STATE } from "@/bot/profile/states";
import { decodeJson } from "@/core/prim/json";
// select-vein — the drill mission's vein CHOICE policy, split out of descend.ts (SRP). Given the
// prospector's cached vein markers it applies the whole selection funnel (fleet-claim
// deconfliction, drown-remap/skip, session skip-set, too-far veto) and aims the navigator at the
// chosen column; and it owns the "give up on THIS vein, re-target the next" recovery. The DESCEND
// handler + watchdogs live in descend.ts and call in here; floor-safety.ts calls skipUnreachableVein.
import { nearestVein, veinDigColumn } from "@/shared/domain/resource-target";
import { getSection, hazardNear, normalizeModel } from "@/shared/domain/world-model";
import type { Ctx } from "@/shared/kernel/capability";
import { greedyRelease } from "@/shared/nav";

/** Pick the nearest cached prospector vein of `ore` (any group if undefined) and aim the drill at
 *  its surface X/Z column (arrive → DESCEND). Returns true + clears `noTarget` when a vein exists;
 *  false + sets `noTarget` (the caller pauses) when the prospector cache is empty. Called by the
 *  mission init AND by the descend guard on resume — so a host `prospect` refresh + `resume`
 *  re-targets without restarting the mission. */
export function selectDrillVein(ctx: Ctx, ore: string | undefined): boolean {
  const drill = ctx.slice(DRILL_SLICE);
  const mem = ctx.slice(MINING_SLICE);
  drill.ore = ore;
  const posR = ctx.rt.player.pos();
  const sigR = ctx.rt.world.signature();
  if (!(posR.ok && sigR.ok)) {
    drill.noTarget = true;
    return false;
  }
  const rawR = ctx.rt.fs.read(ctx.cfg.worldModelPath);
  const parsed = rawR.ok && rawR.value ? decodeJson(rawR.value) : null;
  const model = normalizeModel(parsed?.ok ? parsed.value : null);
  const section = getSection(model, sigR.value);
  // Fleet context (fleet coordination): the hub pushes peers' claimed vein columns + the
  // fleet-union hazard set down in the assignment. Absent/old-shape assignment reads as no claims /
  // no extra hazards.
  const asgR = ctx.rt.world.assignment();
  const fleet = asgR.ok ? asgR.value : null;
  const fleetHazards = fleet?.hazards ?? [];
  const allHazards =
    fleetHazards.length === 0 ? section.hazards : [...section.hazards, ...fleetHazards];
  // "Mark it and don't come back" (Layer 3), upgraded to "mark the COLUMN, not the vein": a vein
  // whose marker column sits on/next to a recorded drowned column is RE-AIMED at an alternate dig
  // column inside its bbox (veinDigColumn) — the prospector centroid is a surface projection that
  // lands in a lake/river routinely on watery seeds, and one flooded column must not write off a
  // 400-cell vein. Only when EVERY candidate column is hazard-marked is the vein dropped. A wet
  // alternate aborts the same way (DRILL_WATER → recordDrowned at drill.vein = that column) so
  // candidates burn down honestly, one abort each. `allHazards` makes a PEER's drown trap count
  // like our own.
  let drownSkipped = 0;
  let drownRemapped = 0;
  const drownSafe: (typeof section.resources)[number][] = [];
  for (const r of section.resources) {
    if (ctx.cfg.drill.hazardRadius <= 0) {
      drownSafe.push(r);
      continue;
    }
    const col = veinDigColumn(
      r,
      (x, z) => !hazardNear(allHazards, x, z, ctx.cfg.drill.hazardRadius),
    );
    if (!col) {
      drownSkipped++;
      continue;
    }
    if (col.x !== r.x || col.z !== r.z) {
      drownRemapped++;
      drownSafe.push({ ...r, x: col.x, z: col.z });
    } else {
      drownSafe.push(r);
    }
  }
  // "Reach scattered veins, or skip them": drop veins this run already gave up pathing to
  // (parked across a ravine/gap — see the DESCEND step-1 GOTO-stall guard). Session skip-set only.
  const unclaimedPool = drownSafe.filter((r) => !drill.skip.includes(veinKey(r.x, r.z)));
  // Vein-claim deconfliction: a vein near a column another bot holds a lease on is THEIRS — target
  // the next-nearest instead of racing a peer down the same shaft. hazardNear doubles as the
  // proximity test (claims are {x,z} columns like hazards).
  const claims = fleet?.claimedVeins ?? [];
  const claimRadius = ctx.cfg.fleetVeinClaimRadius;
  const safe =
    claims.length > 0 && claimRadius > 0
      ? unclaimedPool.filter((r) => !hazardNear(claims, r.x, r.z, claimRadius))
      : unclaimedPool;
  const claimSkipped = unclaimedPool.length - safe.length;
  if (claimSkipped > 0) {
    ctx.log.info(ctx.st.tickCount, "DRILL_CLAIM_SKIP", {
      dropped: claimSkipped,
      claims: claims.length,
      radius: claimRadius,
    });
  }
  const vein = nearestVein(safe, posR.value, ore);
  if (!vein) {
    drill.noTarget = true;
    ctx.log.warn(ctx.st.tickCount, "DRILL_NO_CACHED_VEIN", {
      ore: ore ?? "any",
      drownSkipped,
      claimSkipped,
      unreachableSkipped: drill.skip.length,
    });
    return false;
  }
  // Beyond-the-horizon veto: when every local vein is filtered out (drowned/claimed/skipped),
  // "nearest" degrades to a marker from a PREVIOUS prospecting area — live, the
  // silver drill set off on a 10 km walk no task TTL survives. A too-far vein is the same
  // honest outcome as no vein: park noTarget (relocate + re-prospect), don't hike.
  if (vein.dist > ctx.cfg.drill.maxVeinDist) {
    drill.noTarget = true;
    ctx.log.warn(ctx.st.tickCount, "DRILL_VEIN_TOO_FAR", {
      ore: vein.kind,
      x: vein.x,
      z: vein.z,
      dist: Math.round(vein.dist),
      limit: ctx.cfg.drill.maxVeinDist,
    });
    return false;
  }
  drill.noTarget = false;
  drill.vein = { x: vein.x, y: Math.floor(posR.value.y), z: vein.z };
  drill.bbox = vein.bbox;
  ctx.log.info(ctx.st.tickCount, "DRILL_TARGET", {
    kind: vein.kind,
    x: vein.x,
    z: vein.z,
    dist: Math.round(vein.dist),
    drownRemapped, // >0 = some vein(s) re-aimed at an alternate bbox column past a drowned centre
  });
  // Walk to the vein's surface X/Z column, then DESCEND. An "xz" leg (the vein is a prospector X/Z
  // with no known surface Y) — greedy arrives on horizontal distance; the DESCEND owns the dig-down.
  setNavOverride(mem, drill.vein, STATE.DESCEND, "xz");
  return true;
}

/** GOTO-stall recovery ("reach scattered veins, or skip them"): the drill couldn't PATH
 *  to the current vein's marker column (parked across a ravine/gap for cfg.drill.approachBlockedTicks).
 *  Give up on THAT vein — add it to the session skip-set, then re-target the next-nearest cached vein
 *  (→GOTO) or end the run gracefully (PAUSED) when none remain. Turns a scattered, unreachable vein
 *  into a skip instead of the loud DRILL_STALL→ERROR. Called from the DESCEND step-1 approach walk. */
export function skipUnreachableVein(ctx: Ctx): void {
  const drill = ctx.slice(DRILL_SLICE);
  const run = ctx.slice(DRILL_RUN);
  if (drill.vein) {
    ctx.log.warn(ctx.st.tickCount, "DRILL_UNREACHABLE", {
      vein: { x: drill.vein.x, z: drill.vein.z },
    });
    drill.skip.push(veinKey(drill.vein.x, drill.vein.z));
  }
  greedyRelease(ctx.rt);
  resetDrillRun(run);
  if (selectDrillVein(ctx, drill.ore)) {
    ctx.transition(STATE.GOTO, "drill: vein unreachable → skip to next-nearest cached vein");
  } else {
    ctx.transition(STATE.PAUSED, "drill: no reachable vein left (all scattered/skipped)");
  }
}
