// persistence — durable waypoints + run stats that survive a service restart or
// death. A cross-cutting guard (never short-circuits): loads the store on init,
// detects phase transitions to auto-record waypoints (dump spot, found veins; home is
// recorded by the mine HOME leg through recordHome), and saves periodically when dirty.
// Optionally mirrors each waypoint into JourneyMap's on-disk format so the human sees bot markers on their map
// (Monifactory ships JourneyMap). Commands add/remove waypoints on demand.
//
// Storage is the unified, WORLD-SCOPED mc_world.json (stage 5): this capability owns
// the current world's waypoints+stats section and read-modify-writes it, preserving
// the prospector-owned `resources` section. Keying by rt.world.signature() stops a
// different save/dimension's waypoints from leaking in.
import { MINING_SLICE, resetScanProgress, setNavOverride } from "@/bot/missions/mine/mining-mem";
import { STATE } from "@/bot/profile/states";
import type { Vec3 } from "@/core/runtime/types";
import {
  type Waypoint,
  type WaypointKind,
  asWaypointKind,
  makeWaypoint,
  markDepletedNear,
  nearestWaypoint,
  removeWaypoint,
  toJourneyMapWaypoint,
  upsertWaypoint,
} from "@/shared/domain/waypoints";
import type { WorldSection } from "@/shared/domain/world-model";
import type { Capability, Ctx } from "@/shared/kernel/capability";
import type { Phase } from "@/shared/kernel/phase";
import { WORLD_SCOPE } from "@/shared/kernel/resource";
import { defineSlice } from "@/shared/kernel/slice";
import {
  type SectionIO,
  save,
  scopeIfChanged,
  scopedForCommand,
} from "@/shared/kernel/world-store";

interface PersistStats {
  dumps: number;
  veinsFound: number;
  boots: number;
}
interface PersistBlob {
  waypoints: Waypoint[];
  stats: PersistStats;
}
interface PersistMem extends PersistBlob {
  loaded: boolean;
  dirty: boolean;
  prevPhase: Phase;
  sig: string; // world signature this run is scoped to
  // One-shot latch so a sustained `exhausted` flag (set for a whole batch-completion + the
  // following plan steps) only deplete-marks ONCE. Cleared when the next scan re-arms.
  exhaustHandled: boolean;
}

export const PERSIST_SLICE = defineSlice("persist", initPersistMem);

function initPersistMem(): PersistMem {
  return {
    waypoints: [],
    stats: { dumps: 0, veinsFound: 0, boots: 0 },
    loaded: false,
    dirty: false,
    prevPhase: STATE.IDLE,
    sig: "",
    exhaustHandled: false,
  };
}

// The POLICY seam handed to the world-store mechanism: persistence OWNS the section's `waypoints`
// + `stats`, and preserves every foreign field (resources/storages/hazards) on save. `load` copies a
// freshly-read section into mem (bumping `boots` on the first scope of a run); `gather` rebuilds the
// section to persist from mem. The IO + scope lifecycle (read/save/re-scope) lives in world-store.ts.
function sectionIO(ctx: Ctx, mem: PersistMem): SectionIO {
  return {
    load(section: WorldSection, firstScope: boolean): void {
      mem.waypoints = section.waypoints;
      mem.stats = {
        dumps: section.stats.dumps,
        veinsFound: section.stats.veinsFound,
        boots: section.stats.boots + (firstScope ? 1 : 0),
      };
      ctx.log.info(ctx.st.tickCount, "PERSIST_LOAD", {
        sig: mem.sig,
        waypoints: mem.waypoints.length,
        boots: mem.stats.boots,
      });
    },
    gather(prev: WorldSection, tick: number): WorldSection {
      return {
        waypoints: mem.waypoints,
        resources: prev.resources,
        storages: prev.storages, // ext/scan-owned (storage registry) — preserve, never clobber
        hazards: prev.hazards, // drill-owned (drowned columns) — preserve, never clobber
        stats: mem.stats,
        updatedAt: tick,
      };
    },
  };
}

function exportJourneyMap(ctx: Ctx, wp: Waypoint): void {
  const dir = ctx.cfg.journeyMapDir;
  if (!ctx.cfg.journeyMapExport || !dir) return;
  const jm = toJourneyMapWaypoint(wp);
  const w = ctx.rt.fs.write(`${dir}/${jm.id}.json`, JSON.stringify(jm));
  // The JourneyMap mirror is cosmetic (the human's map markers) — a failure is logged
  // but never blocks the authoritative world-model save above.
  if (!w.ok) ctx.log.warn(ctx.st.tickCount, "JOURNEYMAP_WRITE_FAIL", { id: jm.id, error: w.error });
}

function record(ctx: Ctx, mem: PersistMem, name: string, pos: Vec3, kind: WaypointKind): void {
  const wp = makeWaypoint(name, pos, kind);
  mem.waypoints = upsertWaypoint(mem.waypoints, wp);
  mem.dirty = true;
  exportJourneyMap(ctx, wp);
  ctx.log.info(ctx.st.tickCount, "WAYPOINT", { name, kind, x: wp.x, y: wp.y, z: wp.z });
}

/** Record the "home" waypoint where the bot stands. The mine HOME leg calls it only after its
 *  /home moved the bot (verifyHome): a /home that did nothing (no server home, a cooldown) leaves
 *  the bot in the field, and that spot is not its home. */
export function recordHome(ctx: Ctx): void {
  const posR = ctx.rt.player.pos();
  if (posR.ok) record(ctx, ctx.slice(PERSIST_SLICE), "home", posR.value, "home");
}

// Grey out the veins around `pos` as mined-out (vein→depleted within cfg.scan.radius). Driven by
// the mining slice's `exhausted` flag, which is set ONLY when SCAN has cycled cfg.scan.maxCycles dry
// — covering BOTH exhaustion paths: an unlimited run parks at PAUSED, a batch run (sustain loop)
// self-completes and the orchestrator advances within the same tick (so there's no clean
// SCAN→PAUSED transition for onTransition to catch). A manual human pause never sets exhausted,
// so the map is never wrongly depleted. markDepletedNear is idempotent; the exhaustHandled latch
// keeps it to one log line per exhaustion. This is what stops re-prospecting a dead shaft.
function depleteHereIfExhausted(ctx: Ctx, mem: PersistMem): void {
  const exhausted = ctx.slice(MINING_SLICE).exhausted;
  if (!exhausted) {
    mem.exhaustHandled = false;
    return;
  }
  if (mem.exhaustHandled) return;
  mem.exhaustHandled = true;
  const posR = ctx.rt.player.pos();
  if (!posR.ok) return;
  const { waypoints, changed } = markDepletedNear(mem.waypoints, posR.value, ctx.cfg.scan.radius);
  if (changed.length > 0) {
    mem.waypoints = waypoints;
    mem.dirty = true;
    for (const wp of changed) exportJourneyMap(ctx, wp);
    ctx.log.info(ctx.st.tickCount, "VEINS_DEPLETED", { count: changed.length });
  }
}

function onTransition(ctx: Ctx, mem: PersistMem, from: Phase, to: Phase): void {
  const posR = ctx.rt.player.pos();
  const pos = posR.ok ? posR.value : null;

  // Finished a dump → count it and mark the chest spot.
  if (pos && from === STATE.DUMP && to === STATE.RETURN) {
    mem.stats.dumps++;
    record(ctx, mem, "dump", pos, "dump");
  }
  // Acquired a mining target → drop a vein marker, deduped by cfg.scan.veinRadius.
  if (to === STATE.MINE && from !== STATE.MINE) {
    const mining = ctx.slice(MINING_SLICE);
    const t = mining.target;
    if (t) {
      const near = nearestWaypoint(mem.waypoints, t, "vein");
      const far =
        !near ||
        (near.x - t.x) ** 2 + (near.y - t.y) ** 2 + (near.z - t.z) ** 2 >
          ctx.cfg.scan.veinRadius ** 2;
      if (far) {
        mem.stats.veinsFound++;
        record(ctx, mem, `vein_${t.x}_${t.y}_${t.z}`, t, "vein");
      }
    }
  }
}

export const persistence: Capability = {
  name: "persistence",
  // The guard read/writes the world-scoped model → it must not run until the world is
  // ready. WORLD_SCOPE gates that structurally (guard skipped while it's unavailable).
  requires: [WORLD_SCOPE],

  // goto_waypoint can be issued while the bot is idle or paused, so allow those
  // states to begin navigating (SCAN/MINE → GOTO are already legal).
  edges: { [STATE.IDLE]: [STATE.GOTO], [STATE.PAUSED]: [STATE.GOTO] },

  init(ctx: Ctx): void {
    const mem = ctx.slice(PERSIST_SLICE);
    mem.prevPhase = ctx.st.phase;
    // The section load is DEFERRED to the first guard tick where WORLD_SCOPE resolves
    // (at boot tick 0 the level often isn't loaded → signature() errors → guard skipped).
  },

  guard(ctx: Ctx): boolean {
    const mem = ctx.slice(PERSIST_SLICE);
    const io = sectionIO(ctx, mem);
    const scope = ctx.res(WORLD_SCOPE);
    scopeIfChanged(ctx, mem, scope, io);
    if (ctx.st.phase !== mem.prevPhase) {
      onTransition(ctx, mem, mem.prevPhase, ctx.st.phase);
      mem.prevPhase = ctx.st.phase;
    }
    depleteHereIfExhausted(ctx, mem);
    if (mem.dirty && ctx.st.tickCount % ctx.cfg.persistInterval === 0) save(ctx, mem, io);
    return false;
  },

  commands: {
    add_waypoint(ctx: Ctx, cmd: Record<string, unknown>): void {
      const mem = ctx.slice(PERSIST_SLICE);
      const io = sectionIO(ctx, mem);
      if (!scopedForCommand(ctx, mem, io)) return;
      const rawName = cmd["name"];
      const rawKind = cmd["kind"];
      const cx = cmd["x"];
      const cy = cmd["y"];
      const cz = cmd["z"];
      const name = typeof rawName === "string" ? rawName : `wp_${ctx.st.tickCount}`;
      const kind: WaypointKind = asWaypointKind(typeof rawKind === "string" ? rawKind : "custom");
      let pos: Vec3 | null =
        typeof cx === "number" && typeof cy === "number" && typeof cz === "number"
          ? { x: cx, y: cy, z: cz }
          : null;
      if (!pos) {
        const r = ctx.rt.player.pos();
        pos = r.ok ? r.value : null;
      }
      if (!pos) return;
      record(ctx, mem, name, pos, kind);
      save(ctx, mem, io);
    },

    remove_waypoint(ctx: Ctx, cmd: Record<string, unknown>): void {
      const mem = ctx.slice(PERSIST_SLICE);
      const io = sectionIO(ctx, mem);
      if (!scopedForCommand(ctx, mem, io)) return;
      const rawName = cmd["name"];
      if (typeof rawName !== "string") return;
      mem.waypoints = removeWaypoint(mem.waypoints, rawName);
      mem.dirty = true;
      save(ctx, mem, io);
    },

    save_now(ctx: Ctx): void {
      const mem = ctx.slice(PERSIST_SLICE);
      const io = sectionIO(ctx, mem);
      if (!scopedForCommand(ctx, mem, io)) return;
      save(ctx, mem, io);
    },

    // Send the bot to a known waypoint and re-scan there. `name` → that waypoint;
    // omitted → nearest non-depleted vein. The human does discovery (Prospector /
    // JourneyMap), the bot extracts: it walks to the area (forgiving GoalXZ to
    // dodge the GoalBlock-unreachable trap), then SCAN finds the exposed ore and
    // the normal scan→mine loop takes over, auto-marking/​depleting as it goes.
    goto_waypoint(ctx: Ctx, cmd: Record<string, unknown>): void {
      const mem = ctx.slice(PERSIST_SLICE);
      if (!scopedForCommand(ctx, mem, sectionIO(ctx, mem))) return;
      const mining = ctx.slice(MINING_SLICE);
      const r = ctx.rt.player.pos();
      const pos = r.ok ? r.value : null;

      const rawName = cmd["name"];
      let wp: Waypoint | null = null;
      if (typeof rawName === "string") {
        wp = mem.waypoints.find((w) => w.name === rawName) ?? null;
      } else if (pos) {
        wp = nearestWaypoint(mem.waypoints, pos, "vein");
      }
      if (!wp) {
        ctx.log.warn(ctx.st.tickCount, "GOTO_WP_NONE", {
          name: typeof rawName === "string" ? rawName : null,
        });
        return;
      }

      // Check legality instead of catching — a command issued from a phase with no GOTO
      // edge is a benign user error (warn + skip), not a crash. Checked BEFORE touching the
      // blackboard so a refused waypoint leaves the current nav target untouched.
      if (!ctx.canTransition(STATE.GOTO)) {
        ctx.log.warn(ctx.st.tickCount, "GOTO_WP_BLOCKED", { from: ctx.st.phase });
        return;
      }

      // Clean the scan blackboard so SCAN re-anchors at the arrival spot rather
      // than reusing a stale origin/cache/cycle count from the previous area.
      resetScanProgress(mining);
      mining.origin = null;
      mining.scanCycle = 0;
      setNavOverride(mining, { x: wp.x, y: wp.y, z: wp.z }, STATE.SCAN, "xz");
      ctx.st.running = true;
      ctx.transition(STATE.GOTO, `goto_waypoint ${wp.name}`);
      ctx.log.info(ctx.st.tickCount, "GOTO_WP", { name: wp.name, x: wp.x, y: wp.y, z: wp.z });
    },
  },
};
