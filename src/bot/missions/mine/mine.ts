import { MINING_SLICE, type MiningMem, setMiningTarget } from "@/bot/missions/mine/mining-mem";
import { STATE } from "@/bot/profile/states";
import { must } from "@/core/prim/invariant";
// mine — AIM → BREAK using the native async breaker (InteractionManager
// .breakBlockAsync, verified present in 1.9.2). This replaces the legacy
// held-`key.attack` + poll-for-air hack: the game owns break timing and signals
// completion via callback, which removes the whole stuck-key class of bugs.
//
// Vein continuation: on a successful break we don't bounce straight back to SCAN.
// Instead we refill a small layer-first queue of exposed ore around the cleared
// block and mine the next cell directly (MINE→MINE if reachable, else MINE→GOTO).
// Only when the local cluster is dry do we fall back to SCAN (which re-enters dense
// VEIN mode / spiral). With a hammer's 3×3 AOE this clears a layer per break and
// the air-skip in `nextVeinTarget` drops the cells the AOE already took.
import { encodePos } from "@/core/prim/pos";
import type { Vec3 } from "@/core/runtime/types";
import { isExposed } from "@/shared/domain/scan";
import { strategyForTool } from "@/shared/domain/tooling";
import { type VeinCell, collectVeinCube, orderHorizonFirst } from "@/shared/domain/vein";
import { heldStack } from "@/shared/held";
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { defineSlice } from "@/shared/kernel/slice";
import { liveReader } from "@/shared/nav";
import { type BreakRun, freshBreakRun, stepBreak } from "@/shared/nav/break-cell";

const MINE_RUN = defineSlice<BreakRun>("mineRun", freshBreakRun);

const AIR = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);

function refillVein(ctx: Ctx, mem: MiningMem, center: Vec3, ref: Vec3): void {
  const { rt, cfg } = ctx;
  const profile = must(mem.profile, "harvest mine without a profile (mission init missed)");
  const blockId = (x: number, y: number, z: number): string => {
    const r = rt.world.blockId({ x, y, z });
    // reliability-ok: an unreadable block reads as solid stone — never collected as a target,
    // never seen as exposing air. A conservative LOCAL choice, not a facade-level fake.
    return r.ok ? r.value : "minecraft:stone";
  };
  const cells = collectVeinCube(
    blockId,
    (id) => profile.isTarget(id),
    (x, y, z) => isExposed(blockId, x, y, z),
    center,
    profile.veinRadius,
    cfg.scan.maxBlocksPerTick,
    (key) => mem.veinMined.has(key),
  );
  const queued = new Set(mem.veinQueue.map((c) => encodePos(c.x, c.y, c.z)));
  const fresh = cells.filter((c) => !queued.has(encodePos(c.x, c.y, c.z)));
  for (const c of orderHorizonFirst(fresh, ref)) mem.veinQueue.push(c);
}

function nextVeinTarget(ctx: Ctx, mem: MiningMem): VeinCell | null {
  while (mem.veinQueue.length > 0) {
    const c = must(mem.veinQueue.shift(), "veinQueue.shift on non-empty queue");
    const key = encodePos(c.x, c.y, c.z);
    if (mem.veinMined.has(key)) continue;
    const idR = ctx.rt.world.blockId({ x: c.x, y: c.y, z: c.z });
    if (!idR.ok || AIR.has(idR.value)) continue; // unreadable or already air → skip
    return c;
  }
  return null;
}

// The target is gone (broken, AOE'd by a neighbour, or mined by someone else): tally it,
// then advance the vein LOCALLY — refill the layer-first queue around the cleared block and
// mine the next exposed cell (MINE if reachable, else GOTO). Only a fully-dry local cluster
// falls back to SCAN.
function onTargetCleared(ctx: Ctx, mem: MiningMem, target: Vec3, key: string): void {
  const { rt } = ctx;
  rt.mine.cancel();
  if (!mem.veinMined.has(key)) {
    mem.brokenCount++;
    ctx.bus.emit("blockMined", { x: target.x, y: target.y, z: target.z });
  }
  mem.veinMined.add(key);

  const posR = rt.player.pos();
  if (posR.ok) {
    const p = posR.value;
    if (mem.veinQueue.length === 0) refillVein(ctx, mem, target, p);
    const next = nextVeinTarget(ctx, mem);
    if (next) {
      const strategy = strategyForTool(heldStack(rt)?.id ?? null);
      // World-aware solve: an exposed ore is mined from BESIDE it on stable ground, not by
      // climbing on top (the exposed-slab blocked_no_path). The live reader enables that choice.
      const sol = setMiningTarget(mem, next, strategy, p, liveReader(rt));
      ctx.transition(sol.sameStandPos ? STATE.MINE : STATE.GOTO, "vein next");
      return;
    }
  }

  mem.target = null;
  ctx.transition(STATE.SCAN, "vein exhausted");
}

export const mine: Capability = {
  name: "mine",

  handlers: {
    MINE(ctx: Ctx): void {
      const mem = ctx.slice(MINING_SLICE);
      const run = ctx.slice(MINE_RUN);

      const target = mem.target;
      const face = mem.face;
      if (!target || !face) {
        ctx.transition(STATE.SCAN, "mine without target");
        return;
      }

      // Shared AIM→BREAK (looks AT the target, so it breaks up/down too — not just whatever the
      // crosshair happened to face). Cleared → advance the vein; timeout → re-scan.
      const outcome = stepBreak(ctx.rt, ctx.cfg, ctx.st.tickCount, run, target, face);
      if (outcome === "cleared") {
        onTargetCleared(ctx, mem, target, encodePos(target.x, target.y, target.z));
      } else if (outcome === "timeout") {
        ctx.transition(STATE.SCAN, "mine break timeout");
      }
    },
  },
};
