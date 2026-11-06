import { cellCenter, dist, floorVec } from "@/core/prim/pos";
import type { Container, Runtime } from "@/core/runtime/Runtime";
import type { Vec3 } from "@/core/runtime/types";
// water-clutch reflex — emergency MLG fall-survival. A fall is sub-second, so this is a
// pre-dispatch guard (like air), NOT an FSM divert: it manages the whole fall in place over a
// few ticks and hands the mission straight back, never teleporting to RECOVER (which would
// abort the mission). The physics: landing in even ONE block of water negates ALL fall damage,
// so we don't predict total fall distance — we just guarantee water is on the floor below before
// impact, then scoop the source back up. Block-clutch is deliberately NOT here: placing a block
// under yourself changes where you land, not the damage (vanilla fall damage is distance-only) —
// that's pillarUp's job (rising), not a fall-saver.
//
// State machine (per-reflex slice, since it spans the fall):
//   idle    → not falling dangerously
//   armed   → falling, dangerous drop below, bucket equipped; keys released so we drop straight
//   placed  → water placed on the floor; waiting to land in it
//   retrieve→ landed; scooping the source back up (best-effort; abandon if out of reach)
//
// PROVISIONING (no cheats): the bucket can live ANYWHERE in the bag. On arming we swap it into
// the hand from a main-inventory slot — into a free hotbar slot, or displacing the held item if
// none is free — and undo that swap on exit. Equip happens on ARM (not at placement) so a server
// container move has a tick to apply before we use it; the minFall > reach invariant guarantees
// arm and placement land on different ticks.
import { isWater } from "@/shared/domain/block-traits";
import { type BlockReader, groundUnder, hazardAt } from "@/shared/domain/senses";
import { HOTBAR_VANILLA_START, isHotbar } from "@/shared/held";
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { REFLEX_SETTLED } from "@/shared/kernel/phase";
import { BODY, PLAYER } from "@/shared/kernel/resource";
import { defineSlice } from "@/shared/kernel/slice";
import { aimAt } from "@/shared/nav/break-cell";

type ClutchPhase = "idle" | "armed" | "placed" | "retrieve";
interface ClutchMem {
  phase: ClutchPhase;
  placedAt: Vec3 | null;
  attemptAt: Vec3 | null; // water cell of the last UNCONFIRMED use attempt (armed phase)
  attempts: number; // use attempts this fall (log evidence; >1 = the first raycasts missed)
  savedSlot: number; // hotbar index selected before we equipped the bucket (-1 = unset)
  swap: { a: number; b: number } | null; // the inventory swap to UNDO on restore (null = none)
  sinceLand: number; // ticks spent in retrieve
  noBucketWarned: boolean; // NO_BUCKET logged for this fall episode (reset on landing) — a bucketless fall lasts many ticks, one warn is enough
}
const CLUTCH_SLICE = defineSlice<ClutchMem>("waterClutch", () => ({
  phase: "idle",
  placedAt: null,
  attemptAt: null,
  attempts: 0,
  savedSlot: -1,
  swap: null,
  sinceLand: 0,
  noBucketWarned: false,
}));

/** A senses BlockReader backed by the live world (err/unloaded → null, never "air"). */
const readerFrom =
  (rt: Runtime): BlockReader =>
  (x, y, z) => {
    const r = rt.world.blockId({ x, y, z });
    return r.ok ? r.value : null;
  };

/** First carry slot holding `id`, hotbar preferred (cheapest to equip), or -1. */
function findBucketSlot(inv: Container, id: string): number {
  for (let i = 0; i <= 8; i++) {
    if (inv.slot(HOTBAR_VANILLA_START + i)?.id === id) return HOTBAR_VANILLA_START + i;
  }
  for (const s of inv.slots()) {
    if (!isHotbar(s) && inv.slot(s)?.id === id) return s;
  }
  return -1;
}

/** A free hotbar slot (absolute index), or -1. */
function freeHotbar(inv: Container): number {
  for (let i = 0; i <= 8; i++) {
    if (inv.slot(HOTBAR_VANILLA_START + i) === null) return HOTBAR_VANILLA_START + i;
  }
  return -1;
}

/** Equip a water bucket into the hand from ANYWHERE in the bag (no cheats, just inventory moves).
 *  Order: already in hand → a hotbar slot (just select) → swap a main-inv bucket into a free
 *  hotbar slot → (none free) displace the held item into the bucket's slot. Records the swap to
 *  undo in {@link restoreBag}. Returns false only if the bag carries no water bucket. */
function equipBucket(inv: Container, mem: ClutchMem, id: string): boolean {
  const held = inv.selectedHotbar();
  mem.savedSlot = held;
  mem.swap = null;
  if (inv.slot(HOTBAR_VANILLA_START + held)?.id === id) return true; // already in hand
  const src = findBucketSlot(inv, id);
  if (src < 0) return false;
  if (isHotbar(src)) {
    inv.selectHotbar(src - HOTBAR_VANILLA_START);
    return true;
  }
  const free = freeHotbar(inv);
  const dest = free >= 0 ? free : HOTBAR_VANILLA_START + held; // free slot, else displace the held
  inv.swap(src, dest);
  inv.selectHotbar(dest - HOTBAR_VANILLA_START);
  mem.swap = { a: src, b: dest };
  return true;
}

/** Undo {@link equipBucket}: return the (refilled/empty) bucket to its bag slot and the displaced
 *  item to the hand, then re-select the original hotbar slot. Clears the run's equip fields. */
function restoreBag(inv: Container, mem: ClutchMem): void {
  if (mem.swap) inv.swap(mem.swap.a, mem.swap.b);
  if (mem.savedSlot >= 0) inv.selectHotbar(mem.savedSlot);
  mem.swap = null;
  mem.savedSlot = -1;
}

/** Restore the held tool, release the walk-back keys, clear the run. */
function endSequence(
  ctx: Ctx,
  inv: Container,
  mem: ClutchMem,
  event: string,
  fields: Record<string, unknown>,
): void {
  ctx.rt.keys.set("key.forward", false);
  restoreBag(inv, mem);
  mem.phase = "idle";
  mem.placedAt = null;
  mem.attemptAt = null;
  mem.attempts = 0;
  mem.sinceLand = 0;
  ctx.log.info(ctx.st.tickCount, event, fields);
}

/** Decides the RETRIEVE tick: are we done scooping, out of patience, or still working at it?
 *  Returns whether the reflex keeps preempting the mission. Done = the bucket refilled in hand;
 *  give up = the source is gone or we've spent cfg.safety.waterClutchRetrieveTicks failing to reach it (the air
 *  reflex is the safety net if water is left behind). Otherwise face the source and either walk back
 *  into scoop range (the current shoved us off it) or use the bucket. */
function retrieveTick(ctx: Ctx, inv: Container, mem: ClutchMem, feet: Vec3): boolean {
  const { rt, cfg } = ctx;
  mem.sinceLand++;
  const held = inv.slot(HOTBAR_VANILLA_START + inv.selectedHotbar());
  if (held?.id === cfg.safety.waterBucketId) {
    endSequence(ctx, inv, mem, "WATER_CLUTCH_RETRIEVED", { at: mem.placedAt });
    return false; // bucket refilled → done, hand control back
  }
  const src = mem.placedAt;
  if (!src || mem.sinceLand > cfg.safety.waterClutchRetrieveTicks) {
    // genuinely stuck (timed out trying to reach the source) — abandon it as a last resort.
    // The air reflex (now active even when settled) is the safety net if water is left behind.
    endSequence(ctx, inv, mem, "WATER_CLUTCH_RETRIEVE_GIVEUP", { at: src, ticks: mem.sinceLand });
    return false;
  }
  void rt.interact.lookAt(cellCenter(src));
  if (dist(feet, src) > cfg.safety.waterClutchReach) {
    // the current shoved us off the source — WALK BACK to it (cleanup) rather than leaving the
    // water behind. Keep facing it (lookAt set the yaw) and press forward until in scoop range.
    rt.keys.set("key.forward", true);
    return true;
  }
  rt.keys.set("key.forward", false); // in range → stop and scoop
  void rt.interact.useItem();
  return true;
}

/** Decides when the PLACED wait is over: landing on ground OR standing in water means impact has
 *  happened (either way the fall is survived), so advance to retrieve. Always keeps preempting —
 *  the mission must not fight the fall we're managing. */
function placedTick(rt: Runtime, mem: ClutchMem, reader: BlockReader, feet: Vec3): boolean {
  const og = rt.player.onGround();
  const feetId = reader(feet.x, feet.y, feet.z);
  const inWater = feetId !== null && isWater(feetId);
  if ((og.ok && og.value) || inWater) {
    mem.phase = "retrieve";
    mem.sinceLand = 0;
  }
  return true;
}

/** Decides whether we CAN clutch: equip a bucket from anywhere in the bag and enter `armed`. False =
 *  the bag carries none, so the fall plays out (warned once per episode — a bucketless fall lasts
 *  many ticks and one warn is enough). */
function armClutch(ctx: Ctx, inv: Container, mem: ClutchMem, drop: number): boolean {
  if (!equipBucket(inv, mem, ctx.cfg.safety.waterBucketId)) {
    if (!mem.noBucketWarned) {
      mem.noBucketWarned = true;
      ctx.log.warn(ctx.st.tickCount, "WATER_CLUTCH_NO_BUCKET", { drop });
    }
    return false; // nothing to clutch with — let the fall / other reflexes play out
  }
  mem.phase = "armed";
  return true;
}

/** The place is CONFIRMED — the held bucket went empty, i.e. the server accepted the use and the
 *  water is (or is about to be) in `mem.attemptAt`. Record the source we owe a scoop and announce
 *  it (bus + log). Confirmation is by BUCKET STATE, not a world read: the emptied stack is synced
 *  back the moment the server applies the use, while the placed block can lag a tick behind — and
 *  a fall has no ticks to spare. */
function confirmClutchWater(ctx: Ctx, mem: ClutchMem, at: Vec3, drop: number): void {
  mem.placedAt = at;
  mem.attemptAt = null;
  ctx.bus.emit("waterClutch", { x: at.x, y: at.y, z: at.z, drop });
  ctx.log.info(ctx.st.tickCount, "WATER_CLUTCH_PLACE", {
    at,
    drop,
    surfaceY: at.y - 1,
    attempts: mem.attempts,
  });
}

export const waterClutch: Capability = {
  name: "waterClutch",
  survival: true, // a fatal fall kills an IDLE bot too — clutch even with no mission
  requires: [PLAYER, BODY],

  guard(ctx: Ctx): boolean {
    const { rt, cfg, st } = ctx;
    if (!cfg.safety.waterClutchEnabled) return false;
    if (REFLEX_SETTLED.has(st.phase)) return false;

    const mem = ctx.slice(CLUTCH_SLICE);
    const body = ctx.res(BODY);
    const feet = floorVec(ctx.res(PLAYER).pos);
    const reader = readerFrom(rt);

    const invR = rt.inv.open();
    // Can't touch the inventory this tick: only matters mid-sequence (keep preempting so the
    // mission doesn't fight a fall we're managing); idle → let the tick proceed.
    if (!invR.ok) return mem.phase !== "idle";
    const inv = invR.value;

    // ── retrieve: scoop the placed source back up ──────────────────────────────
    if (mem.phase === "retrieve") return retrieveTick(ctx, inv, mem, feet);

    // ── placed: wait until we've landed in the water, then scoop ────────────────
    if (mem.phase === "placed") return placedTick(rt, mem, reader, feet);

    // ── idle / armed: detect a dangerous fall and place water ──────────────────
    const og = rt.player.onGround();
    const falling = (!og.ok || !og.value) && body.velocity.y <= cfg.safety.waterClutchFallVy;
    const heldId = inv.slot(HOTBAR_VANILLA_START + inv.selectedHotbar())?.id ?? null;
    if (!falling) {
      if (mem.phase === "armed") {
        // Landed (or the fall aborted) mid-sequence. If an attempt DID empty the bucket — the
        // server accepted a use in the last ticks before impact — there is water on the floor we
        // owe a scoop: confirm it and hand straight to retrieve. Otherwise stand down honestly.
        if (mem.attemptAt && heldId === cfg.safety.emptyBucketId) {
          confirmClutchWater(ctx, mem, mem.attemptAt, 0);
          mem.phase = "retrieve";
          mem.sinceLand = 0;
          return true;
        }
        if (mem.attempts > 0) {
          // every raycast missed — the fall played out dry. Warn with the attempt count so a
          // "clutch that never works" is a loud pattern in the journal, not a silent RETRIEVED.
          ctx.log.warn(st.tickCount, "WATER_CLUTCH_MISSED", { attempts: mem.attempts });
        }
        restoreBag(inv, mem); // un-equip the bucket
        mem.phase = "idle";
        mem.attemptAt = null;
        mem.attempts = 0;
      }
      mem.noBucketWarned = false; // grounded → next fall is a new episode
      return false;
    }

    const g = groundUnder(reader, feet, cfg.safety.waterClutchScanDepth);
    if (!g) return mem.phase === "armed"; // no floor in range yet — keep preempting if armed
    // Arming gate is for the FIRST commit only: require a genuinely dangerous drop. Once armed,
    // `drop` shrinks as we fall toward the floor (toward `reach`), so it must NOT re-gate here —
    // else placement would never fire once drop dips back under minFall.
    if (mem.phase !== "armed" && g.drop < cfg.safety.waterClutchMinFall) return false;

    // A prior attempt CONFIRMED (held bucket went empty) → the water is down; stop attempting —
    // one more use with the now-EMPTY bucket would scoop the clutch water straight back up.
    if (mem.phase === "armed" && mem.attemptAt && heldId === cfg.safety.emptyBucketId) {
      confirmClutchWater(ctx, mem, mem.attemptAt, g.drop);
      mem.phase = "placed";
      return true;
    }

    // Predict the LANDING column: lead the current position by horizontal velocity over the
    // ticks left to impact (clamped). Placing under the column we are merely passing through is
    // how a walk-off's drift carried the bot past its own water (live, 5/5 misses).
    const pos = ctx.res(PLAYER).pos;
    const vy = Math.min(body.velocity.y, -1e-3);
    const ticksLeft = g.drop / -vy;
    const clamp = cfg.safety.waterClutchLeadClamp;
    const lead = (v: number): number => Math.max(-clamp, Math.min(clamp, v * ticksLeft));
    const landFeet = floorVec({
      x: pos.x + lead(body.velocity.x),
      y: feet.y,
      z: pos.z + lead(body.velocity.z),
    });
    // ground under the PREDICTED column (near an edge it differs from the current one); if it has
    // no floor in range, fall back to placing under ourselves — water below is better than none.
    const gl = groundUnder(reader, landFeet, cfg.safety.waterClutchScanDepth);
    const target = gl
      ? { x: landFeet.x, y: gl.y, z: landFeet.z }
      : { x: feet.x, y: g.y, z: feet.z };
    const targetDrop = gl ? gl.drop : g.drop;
    // never clutch onto a hazardous landing — water saves you from the fall, not from the lava
    if (hazardAt(reader, target)) return false;

    // arm (once): equip a bucket from ANYWHERE in the bag. A main-inv→hotbar swap applies a tick
    // before placement because minFall > reach forces arm and place onto different ticks.
    if (mem.phase !== "armed" && !armClutch(ctx, inv, mem, g.drop)) return false;
    void rt.keys.releaseAll(); // stop horizontal drift so we drop straight into the water
    // Aim at the landing floor EVERY armed tick (vertical-aware, same path as break-cell): the
    // rotation is long settled by the time the bucket raycast needs it, instead of a same-tick
    // lookAt+use race. Keep falling until the floor is in reach.
    aimAt(rt, cfg, target);
    if (targetDrop > cfg.safety.waterClutchReach) return true; // still too high to place

    // Attempt the place EVERY tick until the bucket-state confirms it (checked above next tick).
    // A single fired-and-forgotten use was a lottery: the first tick with drop ≤ reach still has
    // the EYES ~drop+1.6 above the floor — often past the ~4.5 use reach — and the miss is silent.
    if (heldId === cfg.safety.waterBucketId) {
      void rt.interact.useItem();
      mem.attemptAt = { x: target.x, y: target.y + 1, z: target.z };
      mem.attempts += 1;
    }
    return true;
  },
};
