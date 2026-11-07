import type { HarvestProfile } from "@/bot/missions/harvest/profile";
import type { State } from "@/bot/profile/states";
import type { Face, MiningStrategy, StandSolution, Vec3 } from "@/core/runtime/types";
// Shared harvest blackboard slice — produced by scan, consumed by navigation/mine. Shared
// by BOTH the mine and chop missions (one active at a time); the `profile` field selects
// ore vs wood behaviour (see harvest/profile.ts).
import type { BlockReader } from "@/shared/domain/senses";
import { solveMiningTarget } from "@/shared/domain/solveMiningTarget";
import type { VeinCell } from "@/shared/domain/vein";
import { defineSlice } from "@/shared/kernel/slice";

type ScanMode = "SPIRAL" | "VEIN";

// How navigation phrases the greedy goal (domain/goal.ts). "block" → GoalBlock (exact 3D
// feet cell — a solved standable air cell). "xz" → GoalXZ (horizontal/forgiving column,
// Y-free — send the bot to a waypoint area without the exact-cell-unreachable trap).
type NavMode = "block" | "xz";

interface OreTarget extends Vec3 {
  readonly id: string;
}

export interface MiningMem {
  // Selects ore vs wood behaviour; set by the mission's init (must be present before any
  // handler runs). Null only between slice creation and mission init.
  profile: HarvestProfile | null;
  // Completion accounting: blocks broken this run, and the goal (0 = unlimited → never done
  // by count; mine runs until aborted, chop stops at `count`).
  brokenCount: number;
  goalCount: number;
  spiralIdx: number;
  veinIdx: number;
  mode: ScanMode;
  veinHint: OreTarget | null;
  cache: Set<string>;
  scanCycle: number;
  origin: Vec3 | null;
  // Where the SPIRAL search was last anchored (spiralIdx reset to 0). The spiral re-anchors at the
  // live player pos every tick but its index PERSISTS, so a SCAN resumed far from here (after mining
  // out a vein, a teleport, a goto_waypoint) would skip the near rings around the new spot until the
  // whole spiral wrapped. When the bot has moved ≥ cfg.scan.reanchorDist from this anchor, the SCAN
  // handler resets spiralIdx so the inner rings around the CURRENT position are searched first.
  scanAnchor: Vec3 | null;
  target: OreTarget | null;
  standPos: Vec3 | null;
  face: Face | null;
  gotoIssuedTick: number;
  // Navigation overrides, consumed (and cleared) by the GOTO handler on arrival.
  // arrivalPhase: where to go once the stand pos is reached (null → MINE, the
  // scan-driven default). navMode: how to phrase the greedy goal — "block" = exact 3D
  // stand cell, "xz" = column approach (Y-free, walk-to-vein / waypoint resume).
  arrivalPhase: State | null;
  navMode: NavMode;
  // MINE-local vein continuation: cells still to mine in the current cluster, and
  // the cells already broken (so a refill never re-queues them).
  veinQueue: VeinCell[];
  veinMined: Set<string>;
  // What a blocked GOTO means for the active mission. "error" (default) = fail loud, the
  // generic behaviour. "skip" = unreachable-but-not-fatal: cache the ore + re-SCAN. "dig" =
  // 3D vein-chase (drill): mine a staircase/tunnel to the ore (→DIG_TO) rather than walk; only
  // when even digging can't reach it does DIG_TO fall back to cache + SCAN.
  onBlocked: "error" | "skip" | "dig";
  // Set once SCAN has cycled `cfg.scan.maxCycles` with nothing left (the area is mined out). In a
  // batch run (goalCount>0) the mission COMPLETES on this (isDone) so a plan advances to
  // prospect a NEW vein instead of parking; in an unlimited run SCAN still parks at PAUSED.
  // persistence keys vein-depletion marking off this flag (covers both completion paths).
  exhausted: boolean;
}

export const MINING_SLICE = defineSlice("mining", initMiningMem);

export function initMiningMem(): MiningMem {
  return {
    profile: null,
    brokenCount: 0,
    goalCount: 0,
    spiralIdx: 0,
    veinIdx: 0,
    mode: "SPIRAL",
    veinHint: null,
    cache: new Set(),
    scanCycle: 0,
    origin: null,
    scanAnchor: null,
    target: null,
    standPos: null,
    face: null,
    gotoIssuedTick: -1,
    arrivalPhase: null,
    navMode: "block",
    veinQueue: [],
    veinMined: new Set(),
    onBlocked: "error",
    exhausted: false,
  };
}

// Aim navigation at an arbitrary stand pos with an explicit arrival phase + goal
// mode (used by goto_waypoint to walk the bot to a vein area, then SCAN there).
export function setNavOverride(
  mem: MiningMem,
  standPos: Vec3,
  arrivalPhase: State,
  navMode: NavMode,
): void {
  mem.standPos = standPos;
  mem.arrivalPhase = arrivalPhase;
  mem.navMode = navMode;
  mem.target = null;
  mem.gotoIssuedTick = -1;
}

// Restore the scan-driven defaults (block goal, MINE on arrival). Called by the
// GOTO handler whenever it leaves the phase so a later scan→GOTO isn't tainted.
export function clearNavOverride(mem: MiningMem): void {
  mem.arrivalPhase = null;
  mem.navMode = "block";
}

// Aim the bot at a concrete ore cell: record the target, solve the stand position
// for the active tool strategy, and report whether we can break it from where we
// stand (caller picks MINE vs GOTO). Shared by scan and the MINE vein-continuation.
export function setMiningTarget(
  mem: MiningMem,
  target: OreTarget,
  strategy: MiningStrategy,
  playerPos: Vec3 | null,
  reader?: BlockReader,
): StandSolution {
  mem.target = target;
  const sol = solveMiningTarget(target, strategy, playerPos, reader);
  mem.standPos = sol.standPos;
  mem.face = sol.face;
  return sol;
}

// (Strategy is picked per-tick from the held tool via domain/tooling's strategyForTool,
// called in scan/mine — there is no static default to keep here.)

// Begin a harvest run: select the ore/wood profile, set the completion goal, and clear all
// per-run scratch (scan progress, vein queues, broken count, origin). Called from each
// mission's init so a re-start never inherits the previous run's state.
export function startHarvest(mem: MiningMem, profile: HarvestProfile, goalCount: number): void {
  mem.profile = profile;
  mem.goalCount = goalCount;
  mem.brokenCount = 0;
  mem.origin = null;
  mem.target = null;
  mem.standPos = null;
  mem.face = null;
  mem.gotoIssuedTick = -1;
  mem.onBlocked = "error"; // generic fail-loud; mine/chop opt into "skip", drill into "dig", after this call
  clearNavOverride(mem);
  resetScanProgress(mem);
}

export function resetScanProgress(mem: MiningMem): void {
  mem.spiralIdx = 0;
  mem.veinIdx = 0;
  mem.mode = "SPIRAL";
  mem.veinHint = null;
  mem.cache = new Set();
  mem.veinQueue = [];
  mem.veinMined = new Set();
  mem.scanAnchor = null;
  mem.exhausted = false;
  // scanCycle survives across missions otherwise (the slice outlives the run): after enough
  // runs in one area the counter sits ≥ cfg.scan.maxCycles forever, so the FIRST dry spiral pass
  // of a fresh run latches `exhausted` — a chop ended "done" after one tree off this.
  mem.scanCycle = 0;
}
