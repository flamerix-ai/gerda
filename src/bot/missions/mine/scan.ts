import type { HarvestProfile } from "@/bot/missions/harvest/profile";
import { MINING_SLICE, type MiningMem, setMiningTarget } from "@/bot/missions/mine/mining-mem";
import { STATE } from "@/bot/profile/states";
import { must } from "@/core/prim/invariant";
// scan — spiral/vein search for exposed ore. Ported from scan/core.js (trimmed):
// iterate offsets from the player (or around a vein hint), skip cached cells, and
// on the first exposed ore switch to dense VEIN mode; pick the nearest find
// (penalised by distance from the mining origin so the bot works outward rather
// than tunnelling), solve the stand position, and hand off to GOTO/MINE.
import { encodePos, floorVec } from "@/core/prim/pos";
import type { FleetAssignment, Vec3 } from "@/core/runtime/types";
import { inAssignment } from "@/shared/domain/region";
import { type Offset, isExposed, makeSpiralOffsets, makeVeinOffsets } from "@/shared/domain/scan";
import { strategyForTool } from "@/shared/domain/tooling";
import { type HazardMarker, hazardNear, readWorldSection } from "@/shared/domain/world-model";
import { heldStack } from "@/shared/held";
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { liveReader } from "@/shared/nav";

// Offset rings are pure functions of their radii — memoise per (radius,yRange) so the
// ore and wood profiles (different extents) don't clobber a single shared cache.
const spiralCache = new Map<string, Offset[]>();
const veinCache = new Map<string, Offset[]>();
function spiralFor(radius: number, yRange: number): Offset[] {
  const key = `${radius}:${yRange}`;
  let o = spiralCache.get(key);
  if (!o) {
    o = makeSpiralOffsets(radius, yRange);
    spiralCache.set(key, o);
  }
  return o;
}
function veinFor(radius: number): Offset[] {
  let o = veinCache.get(`${radius}`);
  if (!o) {
    o = makeVeinOffsets(radius);
    veinCache.set(`${radius}`, o);
  }
  return o;
}

interface Found extends Vec3 {
  id: string;
  score: number;
}

// The ring being walked this tick: spiral (wide search) or dense vein, with its origin
// and the resume index. Picked once per tick from mem so the cell loop stays branch-free.
interface ScanRing {
  offsets: Offset[];
  origin: Vec3;
  startIdx: number;
  inVein: boolean;
}

function scanRing(mem: MiningMem, profile: HarvestProfile, p: Vec3): ScanRing {
  const inVein = mem.mode === "VEIN" && mem.veinHint !== null;
  return inVein
    ? {
        offsets: veinFor(profile.veinScanRadius),
        origin: must(mem.veinHint, "VEIN mode without a vein hint"),
        startIdx: mem.veinIdx,
        inVein: true,
      }
    : {
        offsets: spiralFor(profile.scanRadius, profile.scanYRange),
        origin: floorVec(p),
        startIdx: mem.spiralIdx,
        inVein: false,
      };
}

// Evaluate one offset cell: cache it, read it, and (if it's an exposed target) escalate
// to VEIN mode and return a scored Found. Returns null for cached/unreadable/non-target
// cells — every call still counts against the per-tick budget in the caller.
function evalCell(
  ctx: Ctx,
  mem: MiningMem,
  profile: HarvestProfile,
  origin: Vec3,
  o: Offset,
  p: Vec3,
  region: FleetAssignment | null,
): Found | null {
  const bx = origin.x + o.dx;
  const by = origin.y + o.dy;
  const bz = origin.z + o.dz;
  const key = encodePos(bx, by, bz);
  if (mem.cache.has(key)) return null;
  mem.cache.add(key);
  const idR = ctx.rt.world.blockId({ x: bx, y: by, z: bz });
  if (!idR.ok) return null; // unreadable chunk — never act on a fake value
  const id = idR.value;
  // reliability-ok: a neighbour we can't read reads as solid stone → "not exposing"
  // (conservative: never tunnel toward an unloaded block).
  const neighbourId = (x: number, y: number, z: number): string => {
    const r = ctx.rt.world.blockId({ x, y, z });
    return r.ok ? r.value : "minecraft:stone";
  };
  if (!(profile.isTarget(id) && isExposed(neighbourId, bx, by, bz))) return null;
  // Fleet assignment (fleet hub assignment): drop ore outside this bot's region / inside a peer's
  // claim BEFORE it can escalate the scan to VEIN mode, so two bots never converge on one vein. A
  // null region = no assignment = mine anywhere (single-bot identity).
  if (region !== null && !inAssignment(bx, bz, region)) return null;
  if (profile.escalateToVein && mem.mode === "SPIRAL") {
    mem.mode = "VEIN";
    mem.veinHint = { x: bx, y: by, z: bz, id };
    mem.veinIdx = 0;
  }
  const pd = (p.x - bx) ** 2 + (p.y - by) ** 2 + (p.z - bz) ** 2;
  const od = mem.origin
    ? (bx - mem.origin.x) ** 2 + (by - mem.origin.y) ** 2 + (bz - mem.origin.z) ** 2
    : 0;
  return { x: bx, y: by, z: bz, id, score: pd + profile.originBias * od };
}

// Walk the ring from startIdx, budgeted to cfg.scan.maxBlocksPerTick CELLS examined (cached
// ones included), collecting every exposed target found. Returns the resume index.
function scanCells(
  ctx: Ctx,
  mem: MiningMem,
  profile: HarvestProfile,
  ring: ScanRing,
  p: Vec3,
  region: FleetAssignment | null,
): { found: Found[]; nextIdx: number } {
  const found: Found[] = [];
  let idx = ring.startIdx;
  let checked = 0;
  while (idx < ring.offsets.length && checked < ctx.cfg.scan.maxBlocksPerTick) {
    const f = evalCell(
      ctx,
      mem,
      profile,
      ring.origin,
      must(ring.offsets[idx], "scan offset in range"),
      p,
      region,
    );
    if (f) found.push(f);
    checked++;
    idx++;
  }
  return { found, nextIdx: idx };
}

// Recorded hazard columns (drowned/ravine) for this world, read once per find-tick (dispatch leaves
// SCAN, so this is not the per-cell hot path — same cadence as drill's selectDrillVein). Empty on
// any read/parse failure (a hazard skip must never wall mining on an unreadable model). Unions the
// bot's OWN file-recorded hazards with the FLEET-SHARED set the hub pushed down (assignment.hazards
// — every peer's markers aggregated host-side), so one bot drowning teaches this one too (fleet
// coordination).
function loadHazards(ctx: Ctx): ReadonlyArray<{ readonly x: number; readonly z: number }> {
  const own: readonly HazardMarker[] = readWorldSection(ctx)?.hazards ?? [];
  const asgR = ctx.rt.world.assignment();
  const fleet = asgR.ok ? (asgR.value?.hazards ?? []) : [];
  return fleet.length === 0 ? own : [...own, ...fleet];
}

// Drop finds sitting within cfg.nav.ravineHazardRadius of a recorded hazard column (cross-run "don't
// come back" — the in-run cache only guards this run). radius ≤ 0 disables the skip. Any dropped
// find is logged so the reason a nearby ore is ignored is visible.
function withoutHazardous(ctx: Ctx, found: Found[]): Found[] {
  const radius = ctx.cfg.nav.ravineHazardRadius;
  if (radius <= 0 || found.length === 0) return found;
  const hazards = loadHazards(ctx);
  if (hazards.length === 0) return found;
  const kept = found.filter((f) => !hazardNear(hazards, f.x, f.z, radius));
  if (kept.length < found.length) {
    ctx.log.info(ctx.st.tickCount, "SCAN_HAZARD_SKIP", {
      dropped: found.length - kept.length,
      radius,
    });
  }
  return kept;
}

// Best find (nearest, origin-biased) → solve the stand pos and hand off to MINE/GOTO.
function dispatchFound(
  ctx: Ctx,
  mem: MiningMem,
  profile: HarvestProfile,
  found: Found[],
  p: Vec3,
): void {
  found.sort((a, b) => a.score - b.score);
  const best = must(found[0], "found is non-empty");
  // A find proves the area is alive — exhaustion needs CONSECUTIVE dry passes, not a
  // lifetime total (scanCycle otherwise accumulates across finds and trips early).
  mem.scanCycle = 0;
  const strategy = strategyForTool(heldStack(ctx.rt)?.id ?? null);
  // World-aware solve (live reader): prefer a SIDE stand beside an exposed ore over climbing on top.
  const sol = setMiningTarget(
    mem,
    { x: best.x, y: best.y, z: best.z, id: best.id },
    strategy,
    p,
    liveReader(ctx.rt),
  );
  if (profile.emitOreFound) {
    ctx.bus.emit("oreFound", { x: best.x, y: best.y, z: best.z, id: best.id });
  }
  ctx.log.info(ctx.st.tickCount, profile.findEvent, {
    id: best.id,
    x: best.x,
    y: best.y,
    z: best.z,
  });
  ctx.transition(sol.sameStandPos ? STATE.MINE : STATE.GOTO, `${profile.label} ${best.id}`);
}

// Spiral walked dry with nothing found: reset it for another pass (optionally clearing
// the cache) and PAUSE once we've cycled the configured number of times.
function onSpiralExhausted(ctx: Ctx, mem: MiningMem, profile: HarvestProfile): void {
  mem.spiralIdx = 0;
  if (profile.clearCacheOnCycle) mem.cache = new Set();
  mem.scanCycle++;
  if (mem.scanCycle >= ctx.cfg.scan.maxCycles) {
    ctx.log.warn(ctx.st.tickCount, profile.exhaustEvent, { cycles: mem.scanCycle });
    // The area is mined out. Flag it (persistence marks the vein depleted off this).
    mem.exhausted = true;
    // A batch run (goalCount>0, e.g. the sustain loop's `mine count:N`) COMPLETES on this via
    // isDone so the plan advances to prospect a NEW vein — staying in SCAN lets the kernel
    // collapse it this same tick (PAUSED is a universal target and would BLOCK isDone). An
    // unlimited run (goalCount==0, a standalone `mine`) still parks at PAUSED as before.
    if (mem.goalCount <= 0) {
      ctx.transition(STATE.PAUSED, profile.exhaustReason);
    }
  }
}

export const scan: Capability = {
  name: "scan",

  handlers: {
    SCAN(ctx: Ctx): void {
      const mem = ctx.slice(MINING_SLICE);
      const profile = must(mem.profile, "harvest scan without a profile (mission init missed)");

      const posR = ctx.rt.player.pos();
      if (!posR.ok) return;
      const p = posR.value;
      if (!mem.origin) mem.origin = floorVec(p);

      // Chunk-aware re-anchor: the spiral index persists across ticks but is anchored at the live
      // pos, so a SCAN resumed far from the last anchor (mined-out vein, teleport, waypoint walk)
      // would skip the near rings around the new spot. When in SPIRAL mode and the bot has moved
      // ≥ cfg.scan.reanchorDist (horizontally) from the anchor, reset the index so the CURRENT
      // position's inner rings are searched first. (VEIN mode is anchored at a fixed ore cluster,
      // not the player, so it's exempt.) SCAN is a stationary phase, so once re-anchored at p the
      // next tick won't re-trigger.
      if (mem.mode === "SPIRAL") {
        const here = floorVec(p);
        if (mem.scanAnchor === null) {
          mem.scanAnchor = here;
        } else if (
          Math.hypot(here.x - mem.scanAnchor.x, here.z - mem.scanAnchor.z) >=
          ctx.cfg.scan.reanchorDist
        ) {
          ctx.log.info(ctx.st.tickCount, "SCAN_REANCHOR", {
            from: mem.scanAnchor,
            to: here,
            droppedIdx: mem.spiralIdx,
          });
          mem.spiralIdx = 0;
          mem.scanAnchor = here;
        }
      }

      // Read the fleet assignment once per tick (cheap snapshot read) and thread it through the
      // cell loop — out-of-region/forbidden ore is filtered at evalCell. ok(null) or err → no
      // filtering (single-bot identity; an unreadable assignment must never silently wall mining).
      const asgR = ctx.rt.world.assignment();
      const region = asgR.ok ? asgR.value : null;

      const ring = scanRing(mem, profile, p);
      const raw = scanCells(ctx, mem, profile, ring, p, region);
      const nextIdx = raw.nextIdx;
      if (ring.inVein) mem.veinIdx = nextIdx;
      else mem.spiralIdx = nextIdx;

      // Vein ring walked dry → drop back to spiral search next tick.
      if (nextIdx >= ring.offsets.length && mem.mode === "VEIN") {
        mem.mode = "SPIRAL";
        mem.veinHint = null;
      }

      // Drop finds on/near a recorded hazard column (drowned/ravine) before dispatch — the persistent
      // cross-run twin of mem.cache. Done here (not in the per-cell hot loop): reads the model once,
      // only when there's something to dispatch.
      const found = withoutHazardous(ctx, raw.found);
      if (found.length > 0) {
        dispatchFound(ctx, mem, profile, found, p);
        return;
      }

      if (nextIdx >= ring.offsets.length && mem.mode === "SPIRAL") {
        onSpiralExhausted(ctx, mem, profile);
      }
    },
  },
};
