import { decodeJson } from "@/core/prim/json";
import type { Vec3 } from "@/core/runtime/types";
// Pure waypoint model + JourneyMap export formatter. The bot keeps its own
// waypoint list as the source of truth (modpack-agnostic, persisted by the
// persistence capability); the JourneyMap formatter is an optional adapter so the
// human sees bot markers (home, dumps, veins, death) on their in-game map, since
// Monifactory ships JourneyMap. No jsMacros here — all data in / data out.
import { nearestBy } from "@/shared/domain/select";

export type WaypointKind = "home" | "dump" | "vein" | "depleted" | "death" | "custom";

const WAYPOINT_KINDS: ReadonlySet<string> = new Set([
  "home",
  "dump",
  "vein",
  "depleted",
  "death",
  "custom",
]);

/** Validate an arbitrary string as a WaypointKind (the SSOT for the union), falling back
 *  to "custom" for anything unknown — so untyped command/JSON input can never smuggle a
 *  bogus kind in via an unchecked `as`. */
export function asWaypointKind(s: string): WaypointKind {
  // reliability-ok: the Set membership IS the validation — this is the single, audited
  // narrowing point for the WaypointKind union (a decoder boundary).
  return WAYPOINT_KINDS.has(s) ? (s as WaypointKind) : "custom";
}

export interface Waypoint extends Vec3 {
  readonly name: string;
  readonly kind: WaypointKind;
  readonly dim: string;
}

const DEFAULT_DIM = "minecraft:overworld";

export function makeWaypoint(
  name: string,
  pos: Vec3,
  kind: WaypointKind = "custom",
  dim: string = DEFAULT_DIM,
): Waypoint {
  return { name, kind, dim, x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
}

/** Insert or replace by name (names are unique keys). Returns a new array. */
export function upsertWaypoint(list: readonly Waypoint[], wp: Waypoint): Waypoint[] {
  const out = list.filter((w) => w.name !== wp.name);
  out.push(wp);
  return out;
}

export function removeWaypoint(list: readonly Waypoint[], name: string): Waypoint[] {
  return list.filter((w) => w.name !== name);
}

/**
 * Mark every still-active `vein` waypoint within `radius` of `pos` as `depleted`
 * (the area's been scanned dry). Returns a new array + the names that changed.
 */
export function markDepletedNear(
  list: readonly Waypoint[],
  pos: Vec3,
  radius: number,
): { waypoints: Waypoint[]; changed: Waypoint[] } {
  const r2 = radius ** 2;
  const changed: Waypoint[] = [];
  const waypoints = list.map((w) => {
    if (w.kind !== "vein") return w;
    const d = (w.x - pos.x) ** 2 + (w.y - pos.y) ** 2 + (w.z - pos.z) ** 2;
    if (d > r2) return w;
    const next: Waypoint = { ...w, kind: "depleted" };
    changed.push(next);
    return next;
  });
  return { waypoints, changed };
}

export function nearestWaypoint(
  list: readonly Waypoint[],
  pos: Vec3,
  kind?: WaypointKind,
): Waypoint | null {
  return nearestBy(kind ? list.filter((w) => w.kind === kind) : list, pos, (w) => w);
}

export function serializeWaypoints(list: readonly Waypoint[]): string {
  return JSON.stringify(list);
}

export function parseWaypoints(json: string | null): Waypoint[] {
  if (!json) return [];
  const decoded = decodeJson(json); // the single JSON.parse boundary — no raw try/catch
  if (!decoded.ok || !Array.isArray(decoded.value)) return [];
  return decoded.value.filter(
    (w): w is Waypoint =>
      w &&
      typeof w.name === "string" &&
      typeof w.x === "number" &&
      typeof w.y === "number" &&
      typeof w.z === "number",
  );
}

const KIND_COLOR: Record<WaypointKind, { r: number; g: number; b: number }> = {
  home: { r: 0, g: 200, b: 0 },
  dump: { r: 0, g: 128, b: 255 },
  vein: { r: 255, g: 200, b: 0 },
  depleted: { r: 110, g: 110, b: 110 }, // greyed-out: mined out
  death: { r: 255, g: 0, b: 0 },
  custom: { r: 255, g: 255, b: 255 },
};

interface JourneyMapWaypoint {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly colorizedIcon: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly enable: boolean;
  readonly type: string;
  readonly origin: string;
  readonly dimensions: string[];
  readonly persistent: boolean;
  readonly showDeviation: boolean;
  readonly iconColor: number;
  readonly customIconColor: boolean;
}

/** ARGB (opaque) as a signed 32-bit int, matching the value JourneyMap bakes into
 *  `colorizedIcon` (e.g. r=137,g=108,b=39 → 0xFF896C27 → -7771097). */
function argbInt(r: number, g: number, b: number): number {
  return (0xff << 24) | (r << 16) | (g << 8) | b | 0;
}

// JourneyMap's real icon resource. The earlier `waypoint-normal.png` does NOT exist, so JM
// threw while loading the texture every frame the waypoint manager was open → the screen
// flickered. Verified against a human-created waypoint file (5.10.x / 1.20.1).
const JM_ICON = "journeymap:ui/img/waypoint-icon.png";

/** JourneyMap's own waypoint id (and on-disk filename): `name_x,y,z` with every run of
 *  non-word / non-letter chars collapsed to "-" — its `CommonConstants.getCSSSafeString`
 *  (regex `[^\w\p{L}]+`, derived via javap of journeymap-5.10.3). We MUST match it: on save
 *  JM rebuilds the id from `name` (dropping any prefix we add) and rewrites the file under
 *  that id, so a non-matching id (e.g. an old `miner_`-prefixed one) creates a DUPLICATE.
 *  `\p{L}` keeps non-ASCII letters (e.g. Cyrillic names) just like JM does. */
function journeyMapId(name: string, x: number, y: number, z: number): string {
  return `${name}_${x},${y},${z}`.replace(/[^\w\p{L}]+/gu, "-");
}

/** Map a bot waypoint to JourneyMap's on-disk waypoint JSON (5.10.x / 1.20.1). Schema
 *  validated against a real human-created JM waypoint file: `icon` is a resourcepack path,
 *  and `colorizedIcon`/`iconColor`/`customIconColor` are NOT optional — JM does not
 *  regenerate them and renders broken (flickers) without them. `colorizedIcon` encodes the
 *  opaque ARGB of r/g/b; `iconColor=-1`/`customIconColor=false` = "no per-waypoint tint".
 *  `id` follows JM's own scheme (see journeyMapId) so re-writing a waypoint overwrites JM's
 *  file instead of duplicating it. Must match the ext.js `journeymap_sync` writer. */
export function toJourneyMapWaypoint(wp: Waypoint): JourneyMapWaypoint {
  const c = KIND_COLOR[wp.kind];
  return {
    id: journeyMapId(wp.name, wp.x, wp.y, wp.z),
    name: wp.name,
    icon: JM_ICON,
    colorizedIcon: `fake:color-${argbInt(c.r, c.g, c.b)}-waypoint-icon.png`,
    x: wp.x,
    y: wp.y,
    z: wp.z,
    r: c.r,
    g: c.g,
    b: c.b,
    enable: true,
    type: "Normal",
    origin: "gerda-bot",
    dimensions: [wp.dim],
    persistent: true,
    showDeviation: false,
    iconColor: -1,
    customIconColor: false,
  };
}
