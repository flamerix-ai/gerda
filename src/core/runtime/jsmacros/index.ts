// Real L0 implementation: composes the per-facet jsMacros (GraalJS) wrappers into one Runtime.
// The whole `src/core/runtime/jsmacros/` directory is ONE exempt boundary — the only place that may
// reference the globals in types/jsmacros.d.ts AND the only place allowed to `try/catch` (inside
// `attempt`, in shared.ts) — the single translation point from "FFI throws" to typed `Result`.
// Each facet file returns its slice; this composer wires them and owns only the tick counter.
import type { ContainerKindRule, Runtime } from "@/core/runtime/Runtime";
import { hudFacet } from "@/core/runtime/jsmacros/hud";
import { handsFacet } from "@/core/runtime/jsmacros/interact";
import { ioFacet } from "@/core/runtime/jsmacros/io";
import { playerFacet } from "@/core/runtime/jsmacros/player";
import { type FxReporter, defaultReport, makeFx } from "@/core/runtime/jsmacros/shared";
import { storageFacet } from "@/core/runtime/jsmacros/storage";
import { worldFacet } from "@/core/runtime/jsmacros/world";

/** Pack-supplied data the facade needs but must not know by heart. */
export interface JsMacrosRuntimeOptions {
  /** Block-id → container-kind rules, matched in order. Defaults to the VANILLA taxonomy only —
   *  a pack with modded storage (Functional Storage drawers…) prepends its own ids at the entry. */
  readonly containerKinds?: readonly ContainerKindRule[];
}

const VANILLA_CONTAINER_KINDS: readonly ContainerKindRule[] = [
  { match: "drawer", kind: "drawer" },
  { match: "barrel", kind: "barrel" },
  { match: "chest", kind: "chest" },
];

export function createJsMacrosRuntime(
  report: FxReporter = defaultReport,
  opts: JsMacrosRuntimeOptions = {},
): Runtime {
  let tickCount = 0;
  const setTick = (t: number) => {
    tickCount = t;
  };

  const fx = makeFx(report);

  const runtime: Runtime = {
    tick: () => tickCount,
    player: playerFacet(fx),
    world: worldFacet(fx),
    storage: storageFacet(fx, opts.containerKinds ?? VANILLA_CONTAINER_KINDS),
    hud: hudFacet(fx),
    ...handsFacet(fx),
    ...ioFacet(fx),
  };

  // expose the internal tick setter without leaking it on the public type
  (runtime as Runtime & { __setTick: (t: number) => void }).__setTick = setTick;
  return runtime;
}
