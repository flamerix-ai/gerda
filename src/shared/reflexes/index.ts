// The reflex layer — mission-agnostic, guard-only safety capabilities
// that run before any mission logic, every tick. Order matters: the first reflex to
// fire preempts the rest, so the most life-threatening checks come first
// (death → vitals → air → waterClutch → tool → stuck → hazard → hunger → human). death is the
// already-dead backstop; hunger is last of the body reflexes because it never preempts
// (sensor-only). All target the universal landings (RECOVER / ERROR / PAUSED), so they
// need no FSM edges of their own.
import type { Capability } from "@/shared/kernel/capability";
import { air } from "@/shared/reflexes/air";
import { death } from "@/shared/reflexes/death";
import { hazard } from "@/shared/reflexes/hazard";
import { human } from "@/shared/reflexes/human";
import { hunger } from "@/shared/reflexes/hunger";
import { stuck } from "@/shared/reflexes/stuck";
import { swimOut } from "@/shared/reflexes/swim-out";
import { tool } from "@/shared/reflexes/tool";
import { vitals } from "@/shared/reflexes/vitals";
import { waterClutch } from "@/shared/reflexes/water-clutch";

export { vitals, air, tool, stuck, hazard, human, hunger, death, waterClutch, swimOut };

/** Registration order = evaluation order. waterClutch sits after the immediate-state life
 *  threats (death/vitals/air) but before tool/stuck/hazard, so a healthy bot in a dangerous
 *  fall clutches into water instead of stuck/hazard diverting it to a teleport RECOVER. swimOut
 *  follows waterClutch (an active clutch owns the tick) and precedes tool/stuck, so a bot submerged
 *  in a flooded pocket floats up in place instead of stuck/hazard teleporting it home — while air
 *  (BEFORE it) stays the terminal escape once breath runs critical. */
export const reflexes: readonly Capability[] = [
  death,
  vitals,
  air,
  waterClutch,
  swimOut,
  tool,
  stuck,
  hazard,
  hunger,
  human,
];
