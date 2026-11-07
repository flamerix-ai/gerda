// home-teleport — the one gate for cfg.homeCommand, shared by RECOVER and the mine HOME leg.
// A bot with no home set (FTB: no `/sethome base`) gets "Unknown destination!" back, does not
// move, and used to send the command again on every recovery: the server kicked it for spam
// within a minute. So every send is effect-checked once the teleport has had time to land
// (cfg.teleportWaitTicks): a send that moved the bot less than cfg.teleportMinMoveBlocks is a
// no-move. A no-move feeds the disable streak only when it is evidence of a missing home:
//   - the leg is RECOVER (the dump leg's HOME often starts at the base already);
//   - the bot did not start within cfg.teleportMinMoveBlocks of its recorded home waypoint
//     (persistence records "home"). A bot with no recorded home counts: the mine HOME leg records
//     it only where its /home moved the bot, so a fresh bot on chop/goto/fetch/hunt has none, and
//     exempting it sent /home without bound.
// A moved send resets the streak. After cfg.safety.homeNoEffectLimit counted no-moves in a row the
// bot stops sending and logs HOME_COMMAND_DISABLED once, naming the fix. The disable is not
// permanent: a /home on cooldown (FTB Essentials, docs/SERVER_SETUP.md) looks the same as a
// missing home, so the gate re-arms itself cfg.safety.homeRearmTicks later. A chat `home` from a
// player re-arms it at once.
import { PERSIST_SLICE } from "@/bot/capabilities/persistence";
import { nearestWaypoint } from "@/shared/domain/waypoints";
import type { Ctx } from "@/shared/kernel/capability";
import { defineSlice } from "@/shared/kernel/slice";

/** Who sent the teleport. Only "recover" feeds the disable streak. */
export type HomeLeg = "recover" | "home";

interface HomeTeleportMem {
  noEffect: number; // counted no-move sends in a row
  disabled: boolean;
  disabledAt: number; // tickCount of the disable; the re-arm window counts from here
  pending: boolean; // a send is waiting for its effect check
  known: boolean; // the pre-send position was readable
  awayFromHome: boolean; // no home waypoint, or the pre-send position was ≥ teleportMinMoveBlocks from it
  fromX: number;
  fromZ: number;
}

export const HOME_TELEPORT_SLICE = defineSlice<HomeTeleportMem>("home-teleport", () => ({
  noEffect: 0,
  disabled: false,
  disabledAt: 0,
  pending: false,
  known: false,
  awayFromHome: false,
  fromX: 0,
  fromZ: 0,
}));

/** Lift an expired disable (cfg.safety.homeRearmTicks after HOME_COMMAND_DISABLED). */
function rearmIfExpired(ctx: Ctx, mem: HomeTeleportMem): void {
  if (!mem.disabled) return;
  const after = ctx.st.tickCount - mem.disabledAt;
  if (after < ctx.cfg.safety.homeRearmTicks) return;
  mem.disabled = false;
  mem.noEffect = 0;
  ctx.log.info(ctx.st.tickCount, "HOME_COMMAND_REARMED", { afterTicks: after });
}

/** Send cfg.homeCommand unless it is unset or disabled; true when it was sent. */
export function sendHome(ctx: Ctx): boolean {
  const mem = ctx.slice(HOME_TELEPORT_SLICE);
  rearmIfExpired(ctx, mem);
  if (ctx.cfg.homeCommand === "" || mem.disabled) {
    mem.pending = false; // no send → no effect check against an older snapshot
    return false;
  }
  const p = ctx.rt.player.pos();
  mem.known = p.ok;
  mem.awayFromHome = false;
  if (p.ok) {
    mem.fromX = p.value.x;
    mem.fromZ = p.value.z;
    const home = nearestWaypoint(ctx.slice(PERSIST_SLICE).waypoints, p.value, "home");
    mem.awayFromHome =
      home === null ||
      Math.hypot(p.value.x - home.x, p.value.z - home.z) >= ctx.cfg.teleportMinMoveBlocks;
  }
  mem.pending = true;
  ctx.rt.chat.say(ctx.cfg.homeCommand);
  return true;
}

/** Effect-check the last send (once): TELEPORT_OK, or TELEPORT_NO_MOVE (+ the disable streak).
 *  True only for TELEPORT_OK: a send this check saw move the bot. */
export function verifyHome(ctx: Ctx, leg: HomeLeg): boolean {
  const { rt, cfg, st } = ctx;
  const mem = ctx.slice(HOME_TELEPORT_SLICE);
  if (!mem.pending) return false;
  mem.pending = false;
  const p = rt.player.pos();
  if (!mem.known || !p.ok) return false; // could not read either end — nothing to assert
  const moved = Math.hypot(p.value.x - mem.fromX, p.value.z - mem.fromZ);
  if (moved >= cfg.teleportMinMoveBlocks) {
    mem.noEffect = 0;
    ctx.log.info(st.tickCount, "TELEPORT_OK", { leg, moved: Math.round(moved) });
    return true;
  }
  const counted = leg === "recover" && mem.awayFromHome;
  if (counted) mem.noEffect++;
  ctx.log.warn(st.tickCount, "TELEPORT_NO_MOVE", {
    leg,
    moved: Math.round(moved),
    counted,
    inARow: mem.noEffect,
  });
  if (counted && mem.noEffect >= cfg.safety.homeNoEffectLimit) {
    mem.disabled = true;
    mem.disabledAt = st.tickCount;
    ctx.log.err(st.tickCount, "HOME_COMMAND_DISABLED", {
      command: cfg.homeCommand,
      failed: mem.noEffect,
      rearmInTicks: cfg.safety.homeRearmTicks,
      fix: "set the home where the bot should flee to (FTB Essentials: /sethome base), or change cfg.homeCommand; a chat `home` re-arms it",
    });
  }
  return false;
}

/** A player asked for home: forget the streak and allow sending again. */
export function rearmHome(ctx: Ctx): void {
  const mem = ctx.slice(HOME_TELEPORT_SLICE);
  mem.disabled = false;
  mem.noEffect = 0;
}
