// GERDA BOT'S PHASE CATALOG — bot tier, not kernel.
//
// State names + edge tables as DATA. The kernel knows only the four LIFECYCLE phases and
// consumes the rest through the PhaseCatalog exported at the bottom of this file; a fork
// swaps this module for its own vocabulary and the kernel is unchanged. The State union is
// shared across ALL of THIS bot's missions (one widened type, no per-mission generics); each
// mission declares the subset it uses. Adding a phase = one entry here + the owning mission's
// edge table.
import type { PartialTransitionTable } from "@/shared/kernel/fsm";
import { LIFECYCLE, type PhaseCatalog } from "@/shared/kernel/phase";

export const STATE = {
  // The four kernel-owned lifecycle phases, spelled through LIFECYCLE so this catalog and the
  // kernel cannot drift apart on their names (assertCatalog would catch it, but a shared
  // constant means it can't happen in the first place).
  IDLE: LIFECYCLE.IDLE,
  SCAN: "SCAN",
  GOTO: "GOTO",
  MINE: "MINE",
  LOOT: "LOOT",
  HOME: "HOME",
  DUMP: "DUMP",
  RETURN: "RETURN",
  // RECOVER — universal safety landing (teleport-out → resume mission or IDLE).
  // Replaces the old "safety-HOME"; the mining HOME/DUMP/RETURN are mine-internal.
  RECOVER: LIFECYCLE.RECOVER,
  // RESTOCK — fetch mission: withdraw from a chest after walking to it.
  RESTOCK: "RESTOCK",
  // STASH — stash mission: after walking to a chest (GOTO), open it (useOnBlock) and deposit a
  // whitelist of items. The deposit counterpart of fetch's RESTOCK; the sustain loop's "unload"
  // leg. Sub-stepped (open→deposit) within the one state, like SMELT.
  STASH: "STASH",
  // STORE — storage mission: the kernel-native storage-network deposit. After walking to a
  // container (GOTO), deposit there — a drawer via look-aimed use-interaction, a chest via
  // open+shift-click — then GOTO the next container in the planned visit order. Smart-routes
  // each item (type-match → category → empty) across the configured base; superset of STASH.
  STORE: "STORE",
  // CRAFT — craft mission: a stationary sub-stepped craft sequence (place table →
  // open → craft the recipe chain). Mission-internal, not a universal target.
  CRAFT: "CRAFT",
  // SMELT — smelt mission: a stationary sub-stepped furnace cycle (open furnace → shift-click
  // load input+fuel → wait for the smelt → collect the output). Like CRAFT it owns ONE kernel
  // state and runs an internal step machine. Mission-internal, not a universal target. The first
  // mod-machine processing capability — the pattern future machines (drawers/GTCEu) follow.
  SMELT: "SMELT",
  // EAT — maintenance interrupt: suspend the active phase, eat until fed, then RESUME
  // the exact phase we left (not the mission's initial phase). Universal target so it
  // can be entered from anywhere; the resume edges are added per active mission.
  EAT: "EAT",
  // DESCEND — drill mission: dig a 1-wide shaft straight down (real hammer breaks, no
  // teleport) until the local scan exposes the prospected vein, then hand off to MINE.
  DESCEND: "DESCEND",
  // DIG_TO — drill mission (3D vein-chase): mine a staircase/tunnel to an offset/above ore cell
  // the greedy walker can't reach, then hand off to MINE. Straight-overhead ore (no offset) is
  // climbed by driving the navigator's pillarUp move directly (jump-place filler), not a separate
  // phase. Runaway / no filler → cache + SCAN.
  // (A gap toward an at-or-above ore is bridged in-engine by greedyStep's driveBridgeStep, gated on
  // cfg.nav.bridge — there is no separate BRIDGE phase any more; the drill's DIG_TO/GOTO legs bridge as they walk.)
  DIG_TO: "DIG_TO",
  // EXCAVATE — drill mission: once the shaft reaches the vein's ore Y-band, strip-mine the
  // prospected vein VOLUME — dig a serpentine of 1-wide corridors over the footprint × band (reusing
  // the DIG_TO hands), whose walls expose the scattered ore for MINE's vein-follow to sweep. A vein is
  // a sparse 3D ore cloud, not a solid mass, so one 1×1 shaft grazes almost nothing; this excavates
  // the volume the way a human mines a GTCEu vein. Plan exhausted / budget hit → SCAN → PAUSED.
  EXCAVATE: "EXCAVATE",
  // SEEK / CHASE / STRIKE — hunt mission. SEEK reads the mob snapshot and locks the nearest
  // huntable target; CHASE greedy-walks toward its (moving) cell until within melee reach;
  // STRIKE aims + swings on a cooldown until the target leaves the snapshot (killed/fled),
  // then lingers for auto-pickup and loops back to SEEK until the kill-count is met.
  SEEK: "SEEK",
  CHASE: "CHASE",
  STRIKE: "STRIKE",
  // FOLLOW — follow mission. Single movement phase: lock a peer (player/bot) by name (or
  // nearest), greedy-walk toward their MOVING cell, holding a follow-gap so we trail rather
  // than crowd. Persistent (runs until stopped) — losing the peer waits + re-acquires, never
  // ends. The first consumer of the peer sensor (world.peers(), bridged main→worker like mobs).
  FOLLOW: "FOLLOW",
  // RANSACK — loot-run mission: the inverse of STORE. After walking to a registered container
  // (GOTO), open its GUI + take everything (or a whitelist) via shift-click, then mark it `looted`
  // in mc_world.json so a later run / another fleet bot skips it, and GOTO the next. Sub-stepped
  // (open→take→close) within the one state, like STORE.
  RANSACK: "RANSACK",
  // INTERACT — interact mission: right-click a held item onto a block face (place into an item
  // frame, drop onto a display/pedestal/showcase, flip a lever). The generalized counterpart of the
  // storage drawer's look-aimed use — GOTO the block, then AIM (hold+lookAt the face) → USE
  // (useOnBlock) → VERIFY per the target's profile (frame/display consume the held item →
  // `consumed`; a lever/button just dispatches → `none`). Sub-stepped within the one state.
  INTERACT: "INTERACT",
  PAUSED: LIFECYCLE.PAUSED,
  ERROR: LIFECYCLE.ERROR,
} as const;

export type State = (typeof STATE)[keyof typeof STATE];

// Emergency targets reachable from ANY state — the mission-agnostic landings every
// reflex can divert to. RECOVER is the safety teleport-out (replaced safety→HOME);
// HOME is now ONLY a mine-mission-internal dump-trip edge, not a universal target.
// EAT is a maintenance interrupt (not an emergency) but is also enter-from-anywhere.
export const UNIVERSAL_TARGETS: readonly State[] = [
  STATE.RECOVER,
  STATE.PAUSED,
  STATE.ERROR,
  STATE.EAT,
];

// Phases exempt from the progress watchdog's DEFAULT feet-position backstop. Two groups:
//   1. Resting / terminal landings — IDLE/PAUSED/ERROR wait for a human command; RECOVER/EAT run
//      their OWN backoff / meal timeout. Standing still here is correct, indefinitely.
//   2. Legitimately-stationary work phases — a furnace cycle (SMELT), a manual craft (CRAFT), a
//      container deposit/withdraw (STORE/STASH/RESTOCK/RANSACK/DUMP), a held-item interaction
//      (INTERACT), a spread-over-ticks scan (SCAN), and the hunt's stand-and-swing / lock-target
//      legs (SEEK/STRIKE) all stand still by design, bounded by their own sub-step timeouts.
//      A movement/teleport leg (HOME/RETURN) can also sit through a teleport-wait.
// Exemption ONLY suppresses the feet DEFAULT — a phase here may still declare an EXPLICIT
// ProgressPolicy (e.g. a sub-step heartbeat), which always runs. Movement phases NOT listed here
// (GOTO/MINE/LOOT/CHASE/DIG_TO) get the feet backstop; FOLLOW/DESCEND/EXCAVATE declare their own.
export const STALL_EXEMPT: ReadonlySet<State> = new Set([
  STATE.IDLE,
  STATE.PAUSED,
  STATE.ERROR,
  STATE.RECOVER,
  STATE.EAT,
  STATE.SCAN,
  STATE.SMELT,
  STATE.CRAFT,
  STATE.STORE,
  STATE.STASH,
  STATE.RESTOCK,
  STATE.RANSACK,
  STATE.DUMP,
  STATE.INTERACT,
  STATE.SEEK,
  STATE.STRIKE,
  STATE.HOME,
  STATE.RETURN,
]);

/** Edges true regardless of mission — the kernel merges these with the active
 *  mission's edges + UNIVERSAL_TARGETS. Mission-specific edges (the mining table)
 *  live with the mission, not here. */
export const GLOBAL_EDGES: PartialTransitionTable<State> = {
  IDLE: ["PAUSED", "ERROR", "RECOVER"],
  RECOVER: ["IDLE", "PAUSED", "ERROR"],
  PAUSED: ["IDLE", "ERROR"],
  ERROR: ["IDLE"],
};

/** Everything above, bundled as the injectable catalog the Kernel is constructed with.
 *  This object IS the tier seam: the kernel reads phases only through it, so replacing this
 *  module (and the missions that name its phases) replaces the bot's whole vocabulary. */
export const GERDA_PHASES: PhaseCatalog = {
  all: new Set(Object.values(STATE)),
  universalTargets: UNIVERSAL_TARGETS,
  globalEdges: GLOBAL_EDGES,
  stallExempt: STALL_EXEMPT,
  // EAT is the one resumable interrupt today (suspend → eat → resume the EXACT phase left).
  interruptPhases: [STATE.EAT],
};

/** The mine mission's edge table (re-exported as MINE_EDGES). Partial — it covers
 *  only the mining phases; global edges come from GLOBAL_EDGES at merge time. */
export const TRANSITIONS: PartialTransitionTable<State> = {
  IDLE: ["SCAN", "PAUSED", "ERROR"],
  SCAN: ["GOTO", "MINE", "LOOT", "HOME", "PAUSED", "ERROR"],
  GOTO: ["MINE", "SCAN", "PAUSED", "ERROR"],
  MINE: ["GOTO", "SCAN", "LOOT", "HOME", "PAUSED", "ERROR"],
  LOOT: ["SCAN", "MINE", "PAUSED", "ERROR"],
  HOME: ["DUMP", "SCAN", "PAUSED", "ERROR"],
  DUMP: ["RETURN", "PAUSED", "ERROR"],
  RETURN: ["SCAN", "PAUSED", "ERROR"],
  RECOVER: ["IDLE", "PAUSED", "ERROR"],
  PAUSED: ["SCAN", "IDLE", "ERROR"],
  ERROR: ["IDLE"],
};
