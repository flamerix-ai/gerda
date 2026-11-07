import type { PlayerInput } from "@/core/runtime/Runtime";
// human reflex — hand control back to the player. If movement input appears while the BOT is not
// the one producing it, the human grabbed the keyboard → PAUSED.
//
// The hard part is "not the one producing it": the bot drives its body with the same keys, so its
// own driving reads EXACTLY like a human at the keyboard. Two filters keep an unattended run from
// pausing on the bot's OWN inputs:
//   1. a settle window keyed on BOT-DRIVE ACTIVITY (below), and
//   2. a debounce — input must persist for cfg.safety.inputHoldTicks consecutive ticks before we
//      yield. A deliberate human takeover holds keys well past that; a transient blip decays first.
//
// BOT-DRIVE ACTIVITY is deliberately mission-SPANNING, and that is the fix for the sustain-loop
// pause (live journal, 3/3 laps: mine → goto → smelt paused itself mid-lap with nobody
// at the keyboard). The old gate asked "was the PREVIOUS PHASE a movement phase OF THE ACTIVE
// MISSION" — so at a cross-mission handoff (goto's GOTO → smelt's stationary SMELT, MISSION_DONE +
// MISSION_START on the same tick) the settle window silently did not exist: SMELT's mission does not
// own GOTO, and st.phaseTicks restarted anyway. The nav's residual input (a long leg latches
// forward/jump/sprint; the game's input state does not collapse the instant the keys are released)
// then read as a takeover exactly cfg.safety.inputHoldTicks later → REFLEX_DIVERT → PAUSED, which is terminal.
//
// So we track the TICK at which the bot was last driving — in a movement phase of WHATEVER mission
// was active then, or holding a drive key (rt.keys.driveHeld(), bot-owned by construction) — and
// suppress the verdict for cfg.safety.inputSettleTicks ticks after it. Recording the tick (not
// reading the active mission's phase set) is what makes it survive a mission swap; a held key
// re-arms the window every tick, so the window starts at the RELEASE, not at the phase change.
//
// That held-key arm is BOUNDED (cfg.safety.driveHeldMaxTicks), and the bound is not theoretical:
// a phase can leave a drive key latched and exit by a PLAIN transition, which releases nothing
// (RECOVER's capped-pocket fall-through held key.jump, then ran toMissionStart). driveHeld() then
// reads true forever, this reflex stays suppressed forever, and the human can never take the
// keyboard back — invisibly, because movementHeld() is horizontal-only and never sees a jump.
// So: once a drive key has been held for driveHeldMaxTicks CONTINUOUSLY while OUTSIDE a movement
// phase, that arm stops suppressing (and says so ONCE in the journal, naming the keys). A movement
// phase — where the nav genuinely owns the keys — keeps re-arming unconditionally, as before.
import type { Capability, Ctx } from "@/shared/kernel/capability";
import { LIFECYCLE, REFLEX_SETTLED } from "@/shared/kernel/phase";
import { PLAYER } from "@/shared/kernel/resource";
import { defineSlice } from "@/shared/kernel/slice";
import {
  type WindowCounter,
  bump,
  freshCounter,
  resetCounter,
} from "@/shared/reflexes/window-counter";

function isHumanActive(input: PlayerInput): boolean {
  return input.forward !== 0 || input.strafe !== 0 || input.jumping || input.sprinting;
}

interface HumanMem {
  // consecutive ticks of sustained human input while the reflex is live (reset whenever the
  // reflex is gated off or the input stops, so only an unbroken hold counts toward the divert)
  active: WindowCounter;
  // st.tickCount of the last tick the BOT itself was driving the body (movement phase of the
  // then-active mission, or a bot-held drive key). null = never observed since boot. Lives in the
  // GLOBAL blackboard slice, which survives startMission/abortMission — that persistence IS the
  // cross-mission part of the fix.
  lastBotDriveTick: number | null;
  // st.tickCount at which the CURRENT uninterrupted "drive key held OUTSIDE a movement phase"
  // run began. null = no such run in progress (key released, or the nav owns the keys). This is
  // what bounds the driveHeld arm — see the header.
  driveHeldSince: number | null;
  // HUMAN_REFLEX_DRIVE_LATCH is logged once per latch, not once per tick (the latch persists for
  // as long as the key stays stuck, which is unbounded). Cleared when the run breaks.
  latchLogged: boolean;
}
const HUMAN_SLICE = defineSlice<HumanMem>("human", () => ({
  active: freshCounter(),
  lastBotDriveTick: null,
  driveHeldSince: null,
  latchLogged: false,
}));

export const human: Capability = {
  name: "human",
  requires: [PLAYER],

  guard(ctx: Ctx): boolean {
    const { cfg, st } = ctx;
    const mem = ctx.slice(HUMAN_SLICE);

    // Record bot-drive activity FIRST, unconditionally: this tick's observation must land even in
    // a phase where the reflex itself is gated off, or the window would have a hole at the seam.
    const inMovementPhase = ctx.isMovementPhase();
    const driveHeld = ctx.rt.keys.driveHeld();
    if (inMovementPhase || !driveHeld) {
      mem.driveHeldSince = null; // the nav owns the keys, or nothing is held → no latch to bound
      mem.latchLogged = false;
    } else if (mem.driveHeldSince === null) {
      mem.driveHeldSince = st.tickCount; // first tick of a stationary hold — start the clock
    }
    const latched =
      mem.driveHeldSince !== null &&
      st.tickCount - mem.driveHeldSince >= cfg.safety.driveHeldMaxTicks;
    if (latched && !mem.latchLogged) {
      mem.latchLogged = true;
      ctx.log.warn(st.tickCount, "HUMAN_REFLEX_DRIVE_LATCH", {
        keys: ctx.rt.keys.driveHeldKeys(),
        heldTicks: cfg.safety.driveHeldMaxTicks,
        phase: st.phase,
      });
    }
    if (inMovementPhase || (driveHeld && !latched)) mem.lastBotDriveTick = st.tickCount;

    // Reflex gated off: already settled, or we're inside the post-drive settle window (which
    // includes "the bot is driving right now" — distance 0). Either → reset the debounce so a held
    // key during the gate doesn't carry over into a spurious divert the moment the gate lifts.
    const settling =
      mem.lastBotDriveTick !== null &&
      st.tickCount - mem.lastBotDriveTick <= cfg.safety.inputSettleTicks;
    if (REFLEX_SETTLED.has(st.phase) || settling) {
      resetCounter(mem.active);
      return false;
    }

    // bump() counts consecutive sustained-input ticks (a transient blip resets it) and fires only
    // once the input has held for the full debounce window.
    if (!bump(mem.active, isHumanActive(ctx.res(PLAYER).input), cfg.safety.inputHoldTicks))
      return false;

    // divert → release the bot's own inputs before handing control to the human.
    ctx.divert(LIFECYCLE.PAUSED, "human input detected");
    return true;
  },
};
