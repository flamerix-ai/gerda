// World facet of the jsMacros runtime — block reads, the world signature, and the entity
// snapshots (items/mobs/peers/frames) main.js publishes. Part of the exempt globals group.
import type { DroppedItem, FrameEntity, Mob, Peer, Runtime } from "@/core/runtime/Runtime";
import type { Fx } from "@/core/runtime/jsmacros/shared";
import { readSnapshot } from "@/core/runtime/snapshot";
import type { FleetAssignment, Result, Vec3 } from "@/core/runtime/types";

export function worldFacet(fx: Fx): Runtime["world"] {
  const { attempt } = fx;
  return {
    blockId(b: Vec3): Result<string> {
      // getBlock returns null for an UNLOADED chunk — that's an err, not "air". Air is a
      // real block whose id is "minecraft:air", so the two are never conflated.
      return attempt(() => {
        const block = World.getBlock(b.x, b.y, b.z);
        if (!block) throw new Error("block not loaded");
        return block.getId();
      });
    },
    signature(): Result<string> {
      return attempt(() => {
        // Primary source: the signature main.js mirrors into our context each tick.
        // FWorld.getDimension/getWorldIdentifier are pinned to main.js's thread and
        // throw "Message not supported" on the worker Service thread, so the worker
        // CANNOT compute this directly — it reads main.js's published value.
        const mirrored = globalThis.__MC_WORLD_SIG;
        if (typeof mirrored === "string" && mirrored.length > 0) return mirrored;
        // Fallback for contexts where the calls DO work (main thread / tests): compute
        // directly. On the worker thread this throws → Result.err → WORLD_SCOPE skips
        // that tick until the mirror lands (a tick or two after boot).
        const d = World.getDimension?.();
        if (typeof d !== "string" || d.length === 0) throw new Error("world not ready");
        const w = World.getWorldIdentifier?.();
        const id = typeof w === "string" && w.length > 0 ? w : "local";
        return `${id}|${d}`;
      });
    },
    items(maxDist: number): Result<DroppedItem[]> {
      return attempt(() => {
        const p = Player.getPlayer();
        if (!p) throw new Error("no player");
        const self = { x: p.getX(), y: p.getY(), z: p.getZ() };
        // Read the item snapshot main.js publishes (worker.js mirrors it into __MC_ITEMS).
        // ItemEntityHelper methods are render-thread-pinned ("Message not supported" off the
        // worker thread), so World.getEntities("item") is unusable here — the bridge is the
        // only working path (live-diagnosed; mirrors world.signature). Absent global
        // (before main.js's first publish) → empty, not an error. Items carry no `distance`
        // field and aren't sorted (the loot mission re-sorts by its own criteria).
        return readSnapshot<DroppedItem>(globalThis.__MC_ITEMS, self, maxDist);
      });
    },
    mobs(maxDist: number): Result<Mob[]> {
      return attempt(() => {
        const p = Player.getPlayer();
        if (!p) throw new Error("no player");
        const self = { x: p.getX(), y: p.getY(), z: p.getZ() };
        // Living-entity reads are render-thread-pinned (same as items), so read the
        // snapshot main.js publishes (worker mirrors it into __MC_MOBS), not the worker's
        // own World.getEntities(). Absent global (pre-publish) → [], not an error.
        return readSnapshot<Omit<Mob, "distance">, Mob>(globalThis.__MC_MOBS, self, maxDist, {
          map: (mb, distance) => ({ ...mb, distance }),
          sort: true,
        });
      });
    },
    peers(maxDist: number): Result<Peer[]> {
      return attempt(() => {
        const p = Player.getPlayer();
        if (!p) throw new Error("no player");
        const self = { x: p.getX(), y: p.getY(), z: p.getZ() };
        // Other-player reads are render-thread-pinned (and publishMobs excludes players), so
        // read the peer snapshot main.js publishes (worker mirrors it into __MC_PEERS), not the
        // worker's own World.getEntities(). Absent global (pre-publish) → [], not an error.
        return readSnapshot<Omit<Peer, "distance">, Peer>(globalThis.__MC_PEERS, self, maxDist, {
          map: (pr, distance) => ({ ...pr, distance }),
          sort: true,
        });
      });
    },
    frames(maxDist: number): Result<FrameEntity[]> {
      return attempt(() => {
        const p = Player.getPlayer();
        if (!p) throw new Error("no player");
        const self = { x: p.getX(), y: p.getY(), z: p.getZ() };
        // Decoration-entity reads are render-thread-pinned like the rest, so read the frame
        // snapshot main.js publishes (worker mirrors it into __MC_FRAMES), not the worker's
        // own World.getEntities(). Absent global (pre-publish) → [], not an error.
        return readSnapshot<Omit<FrameEntity, "distance">, FrameEntity>(
          globalThis.__MC_FRAMES,
          self,
          maxDist,
          { map: (fr, distance) => ({ ...fr, distance }), sort: true },
        );
      });
    },
    assignment(): Result<FleetAssignment | null> {
      return attempt(() => {
        // The coordinator hub pushes the assignment into mc_assignment; worker.js mirrors it
        // into __MC_ASSIGNMENT (same render-thread-free path as items/mobs). Absent/blank =
        // no assignment = null (mine anywhere), never an error.
        const raw = globalThis.__MC_ASSIGNMENT;
        if (typeof raw !== "string" || raw.length === 0) return null;
        return JSON.parse(raw) as FleetAssignment;
      });
    },
  };
}
