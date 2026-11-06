import { decodeJson } from "@/core/prim/json";
// world-store — the reusable world-SCOPED section store mechanism, split out of the persistence
// capability (SRP). It owns the IO + scoping lifecycle for a mc_world.json section: read the whole
// multi-world model, load the current world's section into a caller-owned payload, re-scope on a
// dimension change (flushing the previous section first), and save the owned fields back while
// PRESERVING every foreign section (the prospector's `resources`, the storage registry, hazard
// columns). The capability layered on top supplies the POLICY via a SectionIO seam: which fields it
// owns (load/gather) and when to record them. This is the stateful scoped-mem counterpart to
// domain/world-model's one-shot `withWorldSection`/`readWorldSection` transactions (same putSection
// preserve-foreign guarantee; this variant keeps a long-lived dirty/loaded/sig lifecycle).
import {
  type WorldModel,
  type WorldSection,
  getSection,
  normalizeModel,
  putSection,
} from "@/shared/domain/world-model";
import { type CasStore, casUpdate } from "@/shared/harness/world-cas";
import type { Ctx } from "@/shared/kernel/capability";
import { WORLD_SCOPE, type WorldScope } from "@/shared/kernel/resource";

/** The scope lifecycle state the store maintains for its owner — the world signature it's scoped to
 *  plus the loaded/dirty flags. A capability's slice mem embeds these so the store can drive them. */
export interface ScopeState {
  sig: string; // world signature this run is scoped to
  loaded: boolean;
  dirty: boolean;
}

/** The POLICY seam: the owner declares which section fields it owns. `load` copies a freshly-read
 *  section's owned fields INTO the owner (firstScope = the first load of this run, e.g. to bump a
 *  boot counter); `gather` builds the section to persist from the owner's current state, preserving
 *  `prev`'s foreign fields (resources/storages/hazards). */
export interface SectionIO {
  load(section: WorldSection, firstScope: boolean): void;
  gather(prev: WorldSection, tick: number): WorldSection;
}

/** Read the whole multi-world model off disk (normalized — tolerates old/partial files). Screams on
 *  an IO/parse failure (not mere absence) so a real file is never silently clobbered by a blank model
 *  on the next save. */
export function readModel(ctx: Ctx): WorldModel {
  const rawR = ctx.rt.fs.read(ctx.cfg.worldModelPath);
  if (!rawR.ok) {
    ctx.log.warn(ctx.st.tickCount, "PERSIST_READ_FAIL", { error: rawR.error });
    return normalizeModel(null);
  }
  if (rawR.value === null) return normalizeModel(null); // absent file → fresh model
  const decoded = decodeJson(rawR.value);
  if (!decoded.ok) {
    ctx.log.warn(ctx.st.tickCount, "PERSIST_PARSE_FAIL", { error: decoded.error });
    return normalizeModel(null);
  }
  return normalizeModel(decoded.value);
}

/** Load (or re-load) the section for the scoped world into the owner via `io.load`. Called once the
 *  world is ready (WORLD_SCOPE resolved) and again on a signature CHANGE (dimension travel) — flushing
 *  the previous section first so nothing is lost on the switch. The `scope` handle is the structural
 *  proof the world is ready (it can't be fabricated). */
export function scopeTo(ctx: Ctx, st: ScopeState, scope: WorldScope, io: SectionIO): void {
  if (st.loaded && st.dirty && st.sig) save(ctx, st, io);
  const firstScope = !st.loaded;
  const section = getSection(readModel(ctx), scope.sig);
  st.sig = scope.sig;
  io.load(section, firstScope);
  st.loaded = true;
  st.dirty = true; // persist the boot increment / fresh scope
}

/** (Re)scope the owner to the world the `scope` handle names if it differs from the current scope.
 *  The handle is only obtainable when the world is ready, so this can't run early. */
export function scopeIfChanged(ctx: Ctx, st: ScopeState, scope: WorldScope, io: SectionIO): void {
  if (scope.sig !== st.sig) scopeTo(ctx, st, scope, io);
}

/** Save the owner's section back, PRESERVING every foreign section (read-modify-write so a concurrent
 *  prospector/storage/hazard write isn't clobbered). Keyed on `st.sig`. No-op without a signature. */
export function save(ctx: Ctx, st: ScopeState, io: SectionIO): void {
  const sig = st.sig;
  if (!sig) return;
  // mc_world.json is RMW'd by this (worker) thread AND the main.js supervisor/ext thread — a naive
  // last-writer-wins loses a hazard/storage/resource update the other writer made between our read and
  // write. Route the save through the harness compare-and-swap: re-read + re-gather over the
  // freshest model on a seq conflict (so the foreign sections survive), bump seq, write ATOMICALLY (temp
  // + rename) so no reader sees a torn file. Same protocol + seq stamp as world_store.js.
  let error: string | null = null;
  let wrote = false;
  const store: CasStore<WorldModel> = {
    read: () => {
      const m = readModel(ctx);
      return { seq: m.seq ?? 0, value: m };
    },
    commit: (value, nextSeq, expectedSeq) => {
      if (expectedSeq !== null && (readModel(ctx).seq ?? 0) !== expectedSeq) return false;
      const w = ctx.rt.fs.writeAtomic(
        ctx.cfg.worldModelPath,
        JSON.stringify({ ...value, seq: nextSeq }),
      );
      wrote = w.ok;
      error = w.ok ? null : w.error;
      return w.ok;
    },
  };
  casUpdate(store, (model) =>
    putSection(model, sig, io.gather(getSection(model, sig), ctx.st.tickCount)),
  );
  if (!wrote) {
    // Keep dirty so the next interval retries — never silently drop the world model.
    ctx.log.warn(ctx.st.tickCount, "PERSIST_WRITE_FAIL", { sig, error });
    return;
  }
  st.dirty = false;
  ctx.log.trc(ctx.st.tickCount, "PERSIST_SAVE", { sig });
}

/** Resolve a WorldScope for a command (issued off-tick, outside the guard's resource resolution) and
 *  re-scope the owner if the world changed. Returns null when the world isn't ready yet, so the
 *  command skips rather than writing a bogus key. */
export function scopedForCommand(ctx: Ctx, st: ScopeState, io: SectionIO): WorldScope | null {
  const r = WORLD_SCOPE.resolve({ rt: ctx.rt });
  if (!r.ok) return null;
  scopeIfChanged(ctx, st, r.value, io);
  return r.value;
}
