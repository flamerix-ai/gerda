// The command tables of the harness and the bundle, read OFFLINE from their sources (not a test
// file — no `.test.ts`). One loader per layer, each running the real code where it can:
//   main.js    — the META_COMMANDS literal and the buildManifest() body are cut out of the file
//                and evaluated, so the merge order is main.js's own, not a copy of it;
//   screen.js / bridge.js — the dispatch-table keys (their help rows live in META_COMMANDS);
//   ext.js     — the whole file is evaluated against fake jsMacros globals and every
//                register(name, fn, meta) call is captured;
//   the bundle — src/bot/entry/worker-bundle.ts is imported (no host class lookup at module scope,
//                test-ts/bundle-load.test.ts) and its Module.describe() answered, the same call
//                worker.js makes in-game; Kernel.register / registerMission are spied to record
//                the capabilities and the missions.
// Consumers: commands-ref.test.ts (docs/COMMANDS.md), docs-drift.test.ts (public-doc
// completeness), example-commands.test.ts, ext-plugins.test.ts.
import { readFileSync } from "node:fs";
import { vi } from "vitest";

import type { Capability } from "@/shared/kernel/capability";
import type { Mission } from "@/shared/kernel/mission";

/** The text between `open` and the first match of `close` after it. Throws when either is absent. */
export function block(src: string, open: string, close: RegExp): string {
  const start = src.indexOf(open);
  if (start < 0) throw new Error(`"${open}" not found`);
  const rest = src.slice(start + open.length);
  const end = rest.search(close);
  if (end <= 0) throw new Error(`no ${close} after "${open}"`);
  return rest.slice(0, end);
}

export const keys = (src: string, re: RegExp): string[] =>
  [...src.matchAll(re)].map((m) => m[1] ?? "");

/** Every command name a container layer answers before the worker sees it, by source. */
export type Source = "handlers" | "screen" | "ext" | "bridge" | "meta";

/** The container dispatch tables as name sets. `files` overrides a harness file's text (fixtures). */
export function containerSources(
  files: Partial<Record<string, string>> = {},
): Record<Source, Set<string>> {
  const read = (f: string): string => files[f] ?? readFileSync(f, "utf8");
  const main = read("harness/main.js");
  const screen = read("harness/screen.js");
  const ext = read("harness/ext.js");
  const bridge = read("harness/bridge.js");
  return {
    // main.js HANDLERS literal (4-space keys) — the first dispatch stop.
    handlers: new Set(keys(block(main, "var HANDLERS = {", /^};/m), /^ {4}(\w+):/gm)),
    // screen.js handler map, merged into HANDLERS at boot.
    screen: new Set(keys(block(screen, "    var S = {", /^ {4}};/m), /^ {8}(\w+):/gm)),
    // ext.js plugins (register / defineCmd) — the second dispatch stop.
    ext: new Set(keys(ext, /\b(?:register|defineCmd)\(\s*"(\w+)"/g)),
    // bridge.js answers these itself, before main.js.
    bridge: new Set(keys(bridge, /\btype === "(\w+)"/g)),
    // help metadata rows that claim the container or the bridge.
    meta: new Set(keys(main, /^\s+(\w+):\s*\{where:\s*"(?:container|bridge)"/gm)),
  };
}

// ---- the manifest row shape (main.js META_COMMANDS, ext.js meta, Module.describe) ----------------

export interface ParamDoc {
  name: string;
  type: string;
  required?: boolean;
  desc?: string;
}
export interface CommandDoc {
  where: string;
  desc: string;
  params: ParamDoc[];
}
export type Manifest = Record<string, CommandDoc>;

/** main.js META_COMMANDS, evaluated from its object literal. */
export function metaCommands(mainSrc: string): Manifest {
  const body = block(mainSrc, "var META_COMMANDS = {", /^};/m);
  return new Function(`return {${body}};`)() as Manifest;
}

/** main.js buildManifest() run on the given layers: the merge `describe` answers in-game. */
export function buildManifest(mainSrc: string, worker: Manifest, ext: Manifest): Manifest {
  const body = block(mainSrc, "function buildManifest() {", /^}/m);
  const run = new Function("GV", "WORKER_CMDS_KEY", "EXT", "META_COMMANDS", body) as (
    gv: { getString(k: string): string },
    key: string,
    ext: Record<string, { meta: CommandDoc }>,
    meta: Manifest,
  ) => Manifest;
  const key = "worker.cmds";
  const gv = { getString: (k: string): string => (k === key ? JSON.stringify(worker) : "") };
  const extEntries = Object.fromEntries(Object.entries(ext).map(([n, meta]) => [n, { meta }]));
  return run(gv, key, extEntries, metaCommands(mainSrc));
}

// ---- ext.js evaluated against fake jsMacros/Java globals -----------------------------------------

export type Resp = Record<string, unknown>;
export type Handler = (req: Record<string, unknown>, id: number) => void;

// Any property, any call, any construction: the module-scope Java.type lookups ext.js makes for
// plugins a caller does not drive.
export function anything(): unknown {
  const fn = (): unknown => proxy;
  const proxy: unknown = new Proxy(fn, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : proxy),
    apply: () => proxy,
    construct: () => proxy as object,
  });
  return proxy;
}

export interface Fakes {
  classes: Record<string, unknown>;
  missingClasses?: Set<string>;
  onWaitTick?: () => void;
  hotbar?: { getItemId: () => string }[];
  /** ext.js source to evaluate instead of the file (fixtures). */
  extSrc?: string;
}

const EXT_GLOBALS = [
  "Java",
  "Client",
  "JavaWrapper",
  "Player",
  "Hud",
  "register",
  "writeResp",
  "World",
  "Chat",
  "__MC_WORLD_STORE",
  "__MC_CAM",
  "srg",
  "srgAll",
];

export function loadExt(f: Fakes): {
  handlers: Record<string, Handler>;
  metas: Manifest;
  resps: Resp[];
} {
  const g = globalThis as Record<string, unknown>;
  // biome-ignore lint/security/noGlobalEval: the real ipc.js must run in global scope.
  globalThis.eval(readFileSync("harness/ipc.js", "utf8"));
  const handlers: Record<string, Handler> = {};
  const metas: Manifest = {};
  const resps: Resp[] = [];
  g["__MC_WORLD_STORE"] = { signature: () => "w|d", read: () => ({}), section: () => ({}) };
  g["__MC_CAM"] = anything();
  g["Java"] = {
    type: (name: string) => {
      if (f.missingClasses?.has(name)) {
        throw new Error(`Access to host class ${name} is not allowed or does not exist.`);
      }
      return f.classes[name] ?? anything();
    },
  };
  g["Client"] = {
    runOnMainThread: (fn: () => void) => fn(),
    waitTick: (n = 1) => {
      for (let i = 0; i < n; i++) f.onWaitTick?.();
    },
  };
  g["JavaWrapper"] = { methodToJava: (fn: unknown) => fn };
  g["Hud"] = { getOpenScreen: () => null };
  g["Player"] = {
    openInventory: () => ({
      getSlot: (sl: number) => (f.hotbar ?? [])[sl - 36] ?? null,
    }),
  };
  g["register"] = (name: string, fn: Handler, meta: CommandDoc) => {
    handlers[name] = fn;
    metas[name] = meta;
  };
  g["writeResp"] = (_id: number, r: Resp) => resps.push(r);
  // biome-ignore lint/security/noGlobalEval: the real ext.js must run in global scope.
  globalThis.eval(f.extSrc ?? readFileSync("harness/ext.js", "utf8"));
  return { handlers, metas, resps };
}

/** Remove the globals loadExt installed (and the srg/srgAll ext.js publishes). */
export function unloadExt(): void {
  const g = globalThis as Record<string, unknown>;
  for (const k of EXT_GLOBALS) delete g[k];
}

/** The ext.js plugin metas, by command name. */
export function extMetas(extSrc?: string): Manifest {
  const { metas } = loadExt(extSrc === undefined ? { classes: {} } : { classes: {}, extSrc });
  unloadExt();
  return metas;
}

// ---- the worker bundle ---------------------------------------------------------------------------

export interface BundleWiring {
  /** Module.describe(): the bundle's live command set with WORKER_COMMAND_DOCS attached. */
  describe: Manifest;
  /** Every capability makeModule() passed to Kernel.register, in registration order. */
  capabilities: Capability[];
  /** Every mission makeModule() passed to Kernel.registerMission, in registration order. */
  missions: Mission[];
}

/** Import the real bundle entry in a fresh module graph and read its wiring. */
export async function loadBundleWiring(): Promise<BundleWiring> {
  vi.resetModules();
  const { Kernel } = await import("@/shared/kernel/capability");
  const spy = vi.spyOn(Kernel.prototype, "register");
  const missionSpy = vi.spyOn(Kernel.prototype, "registerMission");
  const g = globalThis as Record<string, unknown>;
  const saved = g["Module"];
  await import("@/bot/entry/worker-bundle");
  const mod = g["Module"] as { describe(): Manifest };
  g["Module"] = saved;
  const capabilities = spy.mock.calls.map((c) => c[0]);
  const missions = missionSpy.mock.calls.map((c) => c[0]);
  spy.mockRestore();
  missionSpy.mockRestore();
  return { describe: mod.describe(), capabilities, missions };
}

/** The full manifest the container's `describe` serves, built offline from the three sources. */
export async function sourceManifest(): Promise<Manifest> {
  const { describe } = await loadBundleWiring();
  return buildManifest(readFileSync("harness/main.js", "utf8"), describe, extMetas());
}
