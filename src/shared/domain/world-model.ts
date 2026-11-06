import { decodeJson } from "@/core/prim/json";
import type { Result } from "@/core/runtime/types";
// Unified, WORLD-SCOPED knowledge store (cache discipline; stage 5). Replaces
// the two disconnected files — miner.state.json (worker waypoints/stats) and
// mc_markers.json (ext.js prospector resources) — with ONE `mc_world.json`.
//
// World-scoping (the fix for "does it work in different worlds?"): every section lives
// under a world signature (`<world/server id>|<dimension>`), so a save's or
// dimension's waypoints/resources never bleed into another (Nether coords overlap the
// Overworld 1:8). Section ownership: the worker (R2) owns waypoints/stats; the
// prospector (R1, ext.js) owns resources. Each writer read-modify-writes ONLY its
// section to avoid clobbering the other's (writes are infrequent; no cross-proc lock).
import type { Waypoint } from "@/shared/domain/waypoints";

const WORLD_MODEL_VERSION = 1;

export interface ResourceMarker {
  readonly kind: string; // vein/ore name, e.g. "iron" or "gtceu:iron_ore"
  readonly x: number;
  readonly y?: number;
  readonly z: number;
  /** Horizontal footprint `[minX, minZ, maxX, maxZ]` from the prospector grid — the volume
   *  EXCAVATE strip-mines. Optional: old caches / hand-added markers omit it. */
  readonly bbox?: readonly [number, number, number, number];
  readonly [extra: string]: unknown;
}

/** A base storage container the bot deposits into (the "storage memory" — see
 *  the storage-dump mission). Discovered by the ext `storage_scan` (auto) or
 *  added by hand (hybrid), so the worker only READS this section — it never writes it
 *  (no cross-proc clobber with the scan). `kind` selects the deposit mechanism; `facing`
 *  is the drawer subfacing (north/south/east/west) needed to aim at a slot quadrant. */
export interface RecordedItem {
  readonly id: string;
  readonly count: number;
}

export interface StorageMarker {
  readonly kind: "drawer" | "chest" | "barrel" | "container";
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly facing?: string;
  /** Slot count recorded at discovery — drawer 1/2/4, or a container's size. Drives the
   *  drawer quadrant geometry; for chests it bounds the recorded snapshot. */
  readonly slots?: number;
  /** Last-known contents — the "chest memory". AUTHORITATIVE for chests/barrels,
   *  whose contents a headless read can't see (server-only); a HINT for drawers (a live
   *  `storage.read` overrides it). null entry = an empty slot. */
  readonly recorded?: ReadonlyArray<RecordedItem | null>;
  /** Set once the loot-run mission has emptied this container, so a later run (or another fleet
   *  bot reading the same world section) doesn't walk back to an already-ransacked chest. Persists
   *  in mc_world.json via the index signature below; `lootedTick` is the bot tick it was emptied
   *  (informational). Re-looting is opt-in (a future policy clears the flag); default = skip. */
  readonly looted?: boolean;
  readonly lootedTick?: number;
  readonly [extra: string]: unknown;
}

interface WorldStats {
  dumps: number;
  veinsFound: number;
  boots: number;
}

/** A column the bot must NOT return to — the "mark it and don't come back" memory, persisted
 *  world-bound in mc_world.json so a trap is remembered ACROSS runs, not just within one. Two
 *  kinds:
 *   - `"drowned"` — a descent aborted into water (a flooded ravine/aquifer that would drown a 1-wide
 *     shaft; descend.ts `DRILL_WATER`).
 *   - `"ravine"` — a surface leg's descent-recoverability veto fired: reaching the target meant diving
 *     into a pit deeper than the bot can climb back out of (greedy-nav `descent.unrecoverable`). Without
 *     this the bot re-approaches the same unclimbable pit every run (in-run `mem.cache` only guards the
 *     current run). navigation.ts `recordRavine` writes it at the target's column.
 *  Column-only (X/Z): the whole vertical column is the trap regardless of Y. `selectDrillVein` (drill)
 *  and the mine SCAN both skip any target within a hazard radius, kind-agnostically. */
export interface HazardMarker {
  readonly kind: "drowned" | "ravine";
  readonly x: number;
  readonly z: number;
  readonly tick?: number; // bot tick it was recorded (informational)
}

export interface WorldSection {
  waypoints: Waypoint[];
  resources: ResourceMarker[];
  storages: StorageMarker[];
  hazards: HazardMarker[];
  stats: WorldStats;
  updatedAt: number;
}

export interface WorldModel {
  version: number;
  /** Monotonic write counter for the compare-and-swap that serializes the multi-writer RMW
   *  (src/shared/harness/world-cas.ts). Bumped on every persisted write; a writer whose read seq no
   *  longer matches on commit re-reads and re-merges. Optional so old/hand-edited files (no stamp)
   *  read as 0. */
  seq?: number;
  worlds: Record<string, WorldSection>;
}

function emptyStats(): WorldStats {
  return { dumps: 0, veinsFound: 0, boots: 0 };
}

function emptySection(): WorldSection {
  return {
    waypoints: [],
    resources: [],
    storages: [],
    hazards: [],
    stats: emptyStats(),
    updatedAt: 0,
  };
}

export function emptyModel(): WorldModel {
  return { version: WORLD_MODEL_VERSION, worlds: {} };
}

/** Coerce arbitrary parsed JSON into a valid WorldModel (defends against old formats
 *  / hand-edits / partial files). Never throws. */
export function normalizeModel(raw: unknown): WorldModel {
  const m = emptyModel();
  if (!raw || typeof raw !== "object") return m;
  const o = raw as { version?: unknown; seq?: unknown; worlds?: unknown };
  if (typeof o.version === "number") m.version = o.version;
  if (typeof o.seq === "number") m.seq = o.seq;
  if (o.worlds && typeof o.worlds === "object") {
    for (const [sig, sec] of Object.entries(o.worlds as Record<string, unknown>)) {
      m.worlds[sig] = normalizeSection(sec);
    }
  }
  return m;
}

function normalizeSection(raw: unknown): WorldSection {
  const s = emptySection();
  if (!raw || typeof raw !== "object") return s;
  const o = raw as Partial<WorldSection>;
  if (Array.isArray(o.waypoints)) s.waypoints = o.waypoints as Waypoint[];
  if (Array.isArray(o.resources)) s.resources = o.resources as ResourceMarker[];
  if (Array.isArray(o.storages)) s.storages = o.storages as StorageMarker[];
  if (Array.isArray(o.hazards)) s.hazards = o.hazards as HazardMarker[];
  if (o.stats && typeof o.stats === "object") {
    const st = o.stats as Partial<WorldStats>;
    s.stats = {
      dumps: st.dumps ?? 0,
      veinsFound: st.veinsFound ?? 0,
      boots: st.boots ?? 0,
    };
  }
  if (typeof o.updatedAt === "number") s.updatedAt = o.updatedAt;
  return s;
}

/** Read a world's section (empty if absent) — never mutates the model. */
export function getSection(m: WorldModel, sig: string): WorldSection {
  return m.worlds[sig] ?? emptySection();
}

/** Return a NEW model with `sig`'s section replaced (other worlds untouched). Preserves the CAS `seq`
 *  stamp (the write layer bumps it on commit). */
export function putSection(m: WorldModel, sig: string, section: WorldSection): WorldModel {
  return { ...m, worlds: { ...m.worlds, [sig]: section } };
}

/** Classify a block id as a loot container the search/loot pipeline cares about (mirrors ext.js
 *  `containerKindAt`): a vanilla/modded chest (but NOT an ender chest — per-player, not lootable
 *  here) or a barrel. Drawers need the interaction facing a volumetric block scan can't read, so
 *  they're out of scope here. Returns null for everything else. */
export function storageKindOf(id: string): StorageMarker["kind"] | null {
  const s = id.toLowerCase();
  if (s.includes("barrel")) return "barrel";
  if (s.includes("chest") && !s.includes("ender")) return "chest";
  return null;
}

const skey = (m: { x: number; y: number; z: number }): string => `${m.x}|${m.y}|${m.z}`;

/** Merge freshly-scanned containers into the recorded list, deduped by position. An existing entry
 *  WINS (its `looted`/`recorded` memory is preserved — a re-scan must never un-loot a chest, the
 *  bug fixed in ext.js `mergeStorages`); genuinely new positions are appended. Pure → unit-testable. */
export function mergeStorageMarkers(
  existing: readonly StorageMarker[],
  incoming: readonly StorageMarker[],
): StorageMarker[] {
  const seen = new Set(existing.map(skey));
  const out = [...existing];
  for (const m of incoming)
    if (!seen.has(skey(m))) {
      seen.add(skey(m));
      out.push(m);
    }
  return out;
}

const hkey = (m: { x: number; z: number }): string => `${m.x}|${m.z}`;

/** Add a drowned-column hazard, deduped by X/Z column (the newest `tick` wins so a re-drown refreshes
 *  it). Pure → unit-testable; mirrors the read-modify-write markers pattern. */
export function mergeHazardMarker(
  existing: readonly HazardMarker[],
  marker: HazardMarker,
): HazardMarker[] {
  const out = existing.filter((h) => hkey(h) !== hkey(marker));
  out.push(marker);
  return out;
}

/** Is (x,z) within `radius` blocks (Euclidean, horizontal) of any recorded hazard column? Used to
 *  skip veins that sit on/next to a known drown trap. radius ≤ 0 → exact-column match only.
 *  Structurally typed on {x,z} so fleet-shared hazards (FleetHazard — kind widened to string) and
 *  peer vein claims (VeinClaim — no kind at all) reuse the same proximity test. */
export function hazardNear(
  hazards: ReadonlyArray<{ readonly x: number; readonly z: number }>,
  x: number,
  z: number,
  radius: number,
): boolean {
  const r2 = Math.max(0, radius) ** 2;
  return hazards.some((h) => (h.x - x) ** 2 + (h.z - z) ** 2 <= r2);
}

// ── Transactional read-modify-write ─────────────────────────────────────────────────────────────
// Every world-model writer used to inline the same ceremony: signature → fs.read → decodeJson →
// normalizeModel → getSection → mutate → putSection → writeAtomic. These wrappers are the ONE home
// for it; the caller supplies only the mutation and logs its own tags off the result.

/** The minimal Ctx surface a world-model transaction needs — the real kernel Ctx satisfies it
 *  structurally, so callers pass their `ctx` directly with no domain→kernel import. */
export interface WorldTx {
  readonly rt: {
    readonly world: { signature(): Result<string> };
    readonly fs: {
      read(path: string): Result<string | null>;
      writeAtomic(path: string, data: string): Result<void>;
    };
  };
  readonly cfg: { readonly worldModelPath: string };
}

/** Read the current world's section — `null` when there's no world signature yet (world not ready).
 *  The read half of the RMW; never writes. */
export function readWorldSection(ctx: WorldTx): WorldSection | null {
  const sigR = ctx.rt.world.signature();
  if (!sigR.ok) return null;
  const rawR = ctx.rt.fs.read(ctx.cfg.worldModelPath);
  const parsed = rawR.ok && rawR.value ? decodeJson(rawR.value) : null;
  const model = normalizeModel(parsed?.ok ? parsed.value : null);
  return getSection(model, sigR.value);
}

export type WorldWrite =
  | { readonly status: "no-signature" } // world not ready — nothing read or written
  | { readonly status: "skipped" } // `mutate` returned null — no change, no write
  | { readonly status: "written" }
  | { readonly status: "write-failed"; readonly error: string };

/** Run a world-model read-modify-write as ONE transaction: read the current section, hand it to
 *  `mutate`, and atomically write the returned section back under the world signature (other worlds
 *  untouched). `mutate` returns `null` to abort the write (nothing to persist). The caller inspects
 *  the returned status to log its own success/failure tags. */
export function withWorldSection(
  ctx: WorldTx,
  mutate: (section: WorldSection) => WorldSection | null,
): WorldWrite {
  const sigR = ctx.rt.world.signature();
  if (!sigR.ok) return { status: "no-signature" };
  const rawR = ctx.rt.fs.read(ctx.cfg.worldModelPath);
  const parsed = rawR.ok && rawR.value ? decodeJson(rawR.value) : null;
  const model = normalizeModel(parsed?.ok ? parsed.value : null);
  const section = getSection(model, sigR.value);
  const nextSection = mutate(section);
  if (nextSection === null) return { status: "skipped" };
  const next = putSection(model, sigR.value, nextSection);
  const wr = ctx.rt.fs.writeAtomic(ctx.cfg.worldModelPath, JSON.stringify(next));
  return wr.ok ? { status: "written" } : { status: "write-failed", error: wr.error };
}

/** Add a hazard column (drowned/ravine) to the current world section — the byte-identical body that
 *  drill's `recordDrowned` and navigation's `recordRavine` used to duplicate. Deduped by X/Z column
 *  (newest tick wins). Returns the transaction status so each caller logs its own tag. */
export function writeHazardMarker(
  ctx: WorldTx,
  kind: HazardMarker["kind"],
  x: number,
  z: number,
  tick: number,
): WorldWrite {
  return withWorldSection(ctx, (section) => ({
    ...section,
    hazards: mergeHazardMarker(section.hazards, { kind, x, z, tick }),
  }));
}
