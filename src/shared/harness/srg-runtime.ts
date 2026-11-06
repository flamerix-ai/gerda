// Is the RUNNING game a Forge-SRG runtime? The SRG boot self-check (harness/main.js) used to compare
// the code's SRG tokens with srg_names.json only — a file the repo ships — so it said `ok` on
// Fabric 1.20.1/1.21 too (docs/PORTABILITY.md), where none of those names exist and every
// raw-SRG call (the GUI hands, the navigator's setYaw, onGround) fails. This half asks the game:
//   1. the Minecraft class name — Fabric runs on intermediary names (`net.minecraft.class_310`);
//   2. does Entity declare the bot's own steer method under its SRG name (`setYRot` → the token in
//      SRG_RUNTIME_PROBE)? NeoForge 1.20.5+ and a Mojang-mapped runtime keep `setYRot`, Forge has
//      the SRG token.
// main.js gathers both by REFLECTION ONLY (Class name, getMethod) on its service thread — it never
// calls a game method, so it is offline-safe and never touches the render thread.
//
// MIRROR: harness/safe-io.js `srg.runtimeVerdict` / `srg.bootLine` + `SRG_RUNTIME_PROBE`; the contract test
// (test-ts/harness-contract.test.ts) holds the two in lockstep.
import { SRG as BUNDLE_SRG } from "@/core/runtime/jsmacros/srg";

/** The one member the runtime probe looks up: Entity.setYRot(float) under its SRG name — the call the
 *  navigator steers with, so "missing" means exactly "this bot cannot steer here". */
export const SRG_RUNTIME_PROBE = {
  cls: "net.minecraft.world.entity.Entity",
  member: BUNDLE_SRG.setYRot,
  mojang: "setYRot",
} as const;

export interface SrgRuntimeProbe {
  /** `Client.getMinecraft().getClass().getName()`, or null when that read threw. */
  readonly mcClass: string | null;
  /** Entity (looked up by its Mojang class name) declares SRG_RUNTIME_PROBE.member: true; the class or
   *  the method is absent: false; the probe could not run at all: null. */
  readonly srgMember: boolean | null;
}

export interface SrgRuntimeVerdict {
  /** Same alphabet as the map check: "1" Forge SRG, "0" not SRG, "unknown" probe failed. */
  readonly ok: "1" | "0" | "unknown";
  readonly reason: string;
}

const UNSUPPORTED =
  "the GUI hands (click x/y, scroll, type, keypress) and Gerda Bot movement need Forge SRG names — see docs/PORTABILITY.md";

export function srgRuntimeVerdict(p: SrgRuntimeProbe): SrgRuntimeVerdict {
  if (p.mcClass?.startsWith("net.minecraft.class_")) {
    return {
      ok: "0",
      reason: `Fabric/intermediary runtime (Minecraft class is ${p.mcClass}); ${UNSUPPORTED}`,
    };
  }
  if (p.srgMember === false) {
    return {
      ok: "0",
      reason: `not a Forge SRG runtime: ${SRG_RUNTIME_PROBE.cls} has no ${SRG_RUNTIME_PROBE.member} (${SRG_RUNTIME_PROBE.mojang}); ${UNSUPPORTED}`,
    };
  }
  if (p.mcClass === null || p.srgMember === null) {
    return { ok: "unknown", reason: "runtime probe failed (no class name or reflection error)" };
  }
  return { ok: "1", reason: `Forge SRG runtime (${SRG_RUNTIME_PROBE.member} present)` };
}

/** The srg_names.json half of the boot check, as main.js measured it. */
export interface SrgMapResult {
  /** "1" every required name resolved, "0" some did not, "unknown" srg_names.json absent. */
  readonly ok: "1" | "0" | "unknown";
  readonly required: { readonly tokens: number; readonly members: number };
  readonly missing: { readonly tokens: readonly string[]; readonly members: readonly string[] };
}

/** The ONE boot log line for both halves. main.js used to log the table half and the runtime half
 *  separately, so Fabric printed `SRG boot-check PASS` and then `!!! SRG boot-check FAIL`. */
export function srgBootLine(map: SrgMapResult, runtime: SrgRuntimeVerdict): string {
  const table =
    map.ok === "1"
      ? `srg_names.json resolved ${map.required.tokens} tokens + ${map.required.members} members`
      : map.ok === "0"
        ? `pack rot: ${map.missing.tokens.length} token(s) + ${map.missing.members.length} member(s) unresolved — regenerate srg_names.json (scripts/dev/srg.py --export); missing=${JSON.stringify(map.missing)}`
        : "srg_names.json not deployed (run scripts/dev/srg.py --export + sync)";
  if (runtime.ok === "0") return `!!! SRG boot-check FAIL — ${runtime.reason}; ${table}`;
  const probe =
    runtime.ok === "1" ? runtime.reason : `runtime probe inconclusive — ${runtime.reason}`;
  if (map.ok === "0") return `!!! SRG boot-check FAIL — ${table}; ${probe}`;
  if (map.ok === "unknown") return `SRG boot-check SKIPPED — ${table}; ${probe}`;
  return `SRG boot-check PASS — ${table}; ${probe}`;
}
