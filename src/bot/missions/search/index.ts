import { walkTo } from "@/bot/missions/_goto-leg";
import { intParamOr } from "@/bot/missions/_params";
import { STATE, type State } from "@/bot/profile/states";
import type { Vec3 } from "@/core/runtime/types";
// search — the survey/coverage mission: drive the bot over a serpentine grid and, at each stop,
// volumetric-scan a cuboid for loot containers (chests/barrels), recording what it finds into
// mc_world.json `storages` so a later `loot-run` sweeps them. This is the DISCOVERY half of the
// loot pipeline (search → loot-run); loot-run only consumes the list, so finding the scattered
// city chests was previously a manual `storage_scan`-at-each-spot chore. The mission exploits the
// scan's vertical reach (±cfg.search.scanHeight from the stand Y) to see upper/lower building floors
// WITHOUT climbing a ladder — one ground-level serpentine pass covers multi-floor builds.
//
// Coverage strategy: a boustrophedon (serpentine) grid of stops spaced `step` apart (≤ 2·radius so
// adjacent cuboids overlap, no blind seam). Multi-bot: pass `lanes`/`lane` to stripe the columns so
// N bots cover disjoint bands of the same area in parallel. Never ERROR — an unreachable stop is
// logged and skipped, like loot-run's best-effort visits.
//
// In-bundle scan vs the ext `storage_scan`: the ext does the whole cuboid synchronously on the main
// thread (fine as a one-off host command). Here we're autonomous in the worker, so the read is
// spread over ticks (`cfg.search.scanPerTick`) to never storm `getBlock` in a single tick.
import {
  type StorageMarker,
  mergeStorageMarkers,
  storageKindOf,
  withWorldSection,
} from "@/shared/domain/world-model";
import type { Ctx } from "@/shared/kernel/capability";
import type { PartialTransitionTable } from "@/shared/kernel/fsm";
import type { Mission } from "@/shared/kernel/mission";
import { defineSlice } from "@/shared/kernel/slice";
import { greedyRelease } from "@/shared/nav";

interface SearchMem {
  points: Vec3[]; // serpentine grid stands (the bot's Y, since the cuboid reaches up/down from it)
  pi: number; // current stop
  scanCenter: Vec3; // block-rounded centre of the current cuboid (captured on arrival)
  cursor: number; // flat index into the current cuboid (incremental scan progress)
  pending: StorageMarker[]; // containers found at the current stop (deduped, flushed on stop-complete)
  found: number; // running total recorded across all stops
  radius: number;
  height: number;
  done: boolean;
}

const SEARCH_SLICE = defineSlice<SearchMem>("search", () => ({
  points: [],
  pi: 0,
  scanCenter: { x: 0, y: 0, z: 0 },
  cursor: 0,
  pending: [],
  found: 0,
  radius: 12,
  height: 6,
  done: false,
}));

const mem = (ctx: Ctx): SearchMem => ctx.slice(SEARCH_SLICE);

const SEARCH_EDGES: PartialTransitionTable<State> = {
  GOTO: ["SCAN", "IDLE", "PAUSED", "ERROR"],
  SCAN: ["GOTO", "IDLE", "PAUSED", "ERROR"],
};

/** Boustrophedon (serpentine) grid of stands: rows scanned left→right then right→left, so the bot
 *  walks one continuous path with no return-to-start jumps. `lanes>1` keeps only every Nth column
 *  (offset `lane`) so multiple bots cover disjoint column bands of the same area. */
export function buildGrid(
  origin: Vec3,
  cols: number,
  rows: number,
  step: number,
  lanes: number,
  lane: number,
): Vec3[] {
  const pts: Vec3[] = [];
  for (let r = 0; r < rows; r++) {
    const order = [...new Array(cols).keys()];
    if (r % 2 === 1) order.reverse(); // snake back along odd rows
    for (const c of order) {
      if (lanes > 1 && ((c % lanes) + lanes) % lanes !== lane) continue;
      pts.push({ x: origin.x + c * step, y: origin.y, z: origin.z + r * step });
    }
  }
  return pts;
}

function advancePoint(ctx: Ctx, m: SearchMem): void {
  m.pi += 1;
  if (m.pi >= m.points.length) {
    ctx.log.info(ctx.st.tickCount, "SEARCH_DONE", { stops: m.points.length, found: m.found });
    m.done = true;
    return;
  }
  ctx.transition(STATE.GOTO, "search: next stop");
}

/** Merge the stop's finds into mc_world.json `storages` (deduped, existing entries' looted/recorded
 *  memory preserved). Read-modify-write on the worker thread, mirroring loot-run's recordLooted. */
function recordFound(ctx: Ctx, m: SearchMem): void {
  const here = m.pending.length;
  if (here === 0) {
    ctx.log.info(ctx.st.tickCount, "SEARCH_SCAN", { stop: m.scanCenter, here: 0, added: 0 });
    return;
  }
  let added = 0;
  const res = withWorldSection(ctx, (section) => {
    const before = section.storages.length;
    const storages = mergeStorageMarkers(section.storages, m.pending);
    added = storages.length - before;
    return { ...section, storages };
  });
  if (res.status === "no-signature") {
    ctx.log.warn(ctx.st.tickCount, "SEARCH_RECORD_FAIL", { err: "no world signature" });
  } else if (res.status === "write-failed") {
    ctx.log.warn(ctx.st.tickCount, "SEARCH_RECORD_FAIL", { err: res.error });
  } else {
    m.found += added;
    ctx.log.info(ctx.st.tickCount, "SEARCH_SCAN", { stop: m.scanCenter, here, added });
  }
}

/** One tick of the cuboid read: process up to `cfg.search.scanPerTick` voxels of the
 *  (2·radius+1)² × (2·height+1) cuboid centred on scanCenter, collecting container blocks into
 *  `pending` (deduped by position). Returns true once the whole cuboid is scanned. */
function stepScan(ctx: Ctx, m: SearchMem): boolean {
  const side = 2 * m.radius + 1;
  const vspan = 2 * m.height + 1;
  const total = side * side * vspan;
  const budget = Math.max(1, ctx.cfg.search.scanPerTick);
  const end = Math.min(total, m.cursor + budget);
  const seen = new Set(m.pending.map((p) => `${p.x}|${p.y}|${p.z}`));
  for (let i = m.cursor; i < end; i++) {
    const dy = Math.floor(i / (side * side));
    const rem = i - dy * side * side;
    const dz = Math.floor(rem / side);
    const dx = rem - dz * side;
    const p = {
      x: m.scanCenter.x + dx - m.radius,
      y: m.scanCenter.y + dy - m.height,
      z: m.scanCenter.z + dz - m.radius,
    };
    const idR = ctx.rt.world.blockId(p);
    if (!idR.ok) continue;
    const kind = storageKindOf(idR.value);
    const key = `${p.x}|${p.y}|${p.z}`;
    if (kind && !seen.has(key)) {
      seen.add(key);
      m.pending.push({ kind, x: p.x, y: p.y, z: p.z });
    }
  }
  m.cursor = end;
  return m.cursor >= total;
}

export const searchMission: Mission = {
  name: "search",
  edges: SEARCH_EDGES,
  initialPhase: STATE.GOTO,
  movementPhases: new Set([STATE.GOTO]),
  params: [
    { name: "cols", type: "int", required: false, desc: "grid columns (default cfg.search.cols)" },
    { name: "rows", type: "int", required: false, desc: "grid rows (default cfg.search.rows)" },
    {
      name: "step",
      type: "int",
      required: false,
      desc: "blocks between stops (default cfg.search.gridStep)",
    },
    {
      name: "radius",
      type: "int",
      required: false,
      desc: "scan radius per stop (default cfg.search.scanRadius)",
    },
    {
      name: "height",
      type: "int",
      required: false,
      desc: "± vertical scan reach (default cfg.search.scanHeight)",
    },
    { name: "x", type: "int", required: false, desc: "grid origin X (default bot X)" },
    { name: "z", type: "int", required: false, desc: "grid origin Z (default bot Z)" },
    {
      name: "lanes",
      type: "int",
      required: false,
      desc: "split columns across N bots (multi-bot striping)",
    },
    { name: "lane", type: "int", required: false, desc: "this bot's lane index [0..lanes-1]" },
  ],

  init(ctx: Ctx, params: Record<string, unknown>): void {
    const m = mem(ctx);
    const cfg = ctx.cfg;
    const posR = ctx.rt.player.pos();
    const here = posR.ok ? posR.value : { x: 0, y: 64, z: 0 };
    const origin = {
      x: intParamOr(params, "x", Math.round(here.x)),
      y: Math.round(here.y),
      z: intParamOr(params, "z", Math.round(here.z)),
    };
    const cols = Math.max(1, intParamOr(params, "cols", cfg.search.cols));
    const rows = Math.max(1, intParamOr(params, "rows", cfg.search.rows));
    const step = Math.max(1, intParamOr(params, "step", cfg.search.gridStep));
    const lanes = Math.max(1, intParamOr(params, "lanes", 1));
    const lane = ((intParamOr(params, "lane", 0) % lanes) + lanes) % lanes;
    m.radius = Math.max(1, intParamOr(params, "radius", cfg.search.scanRadius));
    m.height = Math.max(0, intParamOr(params, "height", cfg.search.scanHeight));
    m.points = buildGrid(origin, cols, rows, step, lanes, lane);
    m.pi = 0;
    m.found = 0;
    m.pending = [];
    m.cursor = 0;
    m.done = m.points.length === 0;
    ctx.log.info(ctx.st.tickCount, "SEARCH_PLAN", {
      stops: m.points.length,
      cols,
      rows,
      step,
      lane: lanes > 1 ? `${lane}/${lanes}` : "single",
      radius: m.radius,
      height: m.height,
    });
  },

  handlers: {
    GOTO(ctx: Ctx): void {
      const { rt, st } = ctx;
      const m = mem(ctx);
      const stop = m.points[m.pi];
      if (!stop) {
        m.done = true;
        return;
      }
      const skip = (event: "SEARCH_GOTO_TIMEOUT" | "SEARCH_GOTO_BLOCKED"): void => {
        greedyRelease(rt);
        ctx.log.warn(st.tickCount, event, { stop });
        advancePoint(ctx, m); // unreachable stop → skip, keep surveying
      };
      walkTo(ctx, stop, {
        onArrive: () => {
          greedyRelease(rt);
          const posR = rt.player.pos();
          const c = posR.ok ? posR.value : stop;
          m.scanCenter = { x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z) };
          m.cursor = 0;
          m.pending = [];
          ctx.transition(STATE.SCAN, "search arrived");
        },
        onTimeout: () => skip("SEARCH_GOTO_TIMEOUT"),
        onBlocked: () => skip("SEARCH_GOTO_BLOCKED"),
      });
    },

    SCAN(ctx: Ctx): void {
      const m = mem(ctx);
      if (stepScan(ctx, m)) {
        recordFound(ctx, m);
        advancePoint(ctx, m);
      }
    },
  },

  isDone(ctx: Ctx): boolean {
    return mem(ctx).done;
  },

  outputs(ctx: Ctx): Record<string, unknown> {
    const m = mem(ctx);
    return { found: m.found, stops: m.points.length };
  },

  onAbort(ctx: Ctx): void {
    ctx.rt.nav.stop();
  },
};
