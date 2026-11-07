import type { Peer } from "@/core/runtime/Runtime";
// follow domain — the follow mission's SELECTION policy (which peer to trail). The generic pursuit
// primitives (re-find by uuid, gap gate, approach cell) live in domain/pursuit.ts, shared with
// hunt; this keeps only what's specific to following: pick the named peer, else the nearest.
import { minBy } from "@/shared/domain/select";

/** Pick the peer to follow: the named one if `name` is given (case-insensitive exact match),
 *  else the nearest peer. null = no matching peer in the snapshot. The snapshot is already
 *  distance-sorted by the facade, but we re-scan so the function is correct on any order. */
export function pickPeer(peers: readonly Peer[], name: string | null): Peer | null {
  const want = name?.toLowerCase() ?? null;
  const pool = want !== null ? peers.filter((p) => p.name.toLowerCase() === want) : peers;
  return minBy(pool, (p) => p.distance);
}
