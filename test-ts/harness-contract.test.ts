// Drift gate + unit coverage for the pure harness core. harness/safe-io.js (R0/R1, plain JS)
// and src/shared/harness/* (R2, this bundle / boot check) MUST agree on the dispatch route decision, the SRG
// inversion, and the declared SRG-required set. If they diverge the harness routes/resolves
// differently than the tested TS and this test fails the `bun run check` gate before anything ships.
import { readFileSync } from "node:fs";
import {
  DEADMAN_KEYS,
  type DeadmanState,
  type DeadmanStep,
  deadmanInit,
  deadmanStep,
} from "@/shared/harness/deadman";
import { routeDispatch } from "@/shared/harness/dispatch";
import {
  buildSrgIndex,
  findMissingSrg,
  findMissingTokens,
  srgLookup,
  srgLookupAll,
} from "@/shared/harness/srg-index";
import {
  HARNESS_SRG_TOKENS,
  REQUIRED_SRG_MEMBERS,
  REQUIRED_SRG_TOKENS,
} from "@/shared/harness/srg-required";
import {
  SRG_RUNTIME_PROBE,
  type SrgMapResult,
  type SrgRuntimeProbe,
  type SrgRuntimeVerdict,
  srgBootLine,
  srgRuntimeVerdict,
} from "@/shared/harness/srg-runtime";
import { type CasStore, casUpdate } from "@/shared/harness/world-cas";
import { describe, expect, it } from "vitest";

// safe-io.js is pure JS (no Java/jsMacros at module scope); running it populates
// globalThis.__MC_HARNESS exactly as it does inside a jsMacros Service.
function loadHarnessJs(): Record<string, unknown> {
  const code = readFileSync("harness/safe-io.js", "utf8");
  const g = globalThis as Record<string, unknown>;
  // biome-ignore lint/security/noGlobalEval: the contract test must execute the real safe-io.js in global scope.
  globalThis.eval(code);
  const h = g["__MC_HARNESS"];
  if (!h) throw new Error("safe-io.js did not assign globalThis.__MC_HARNESS");
  return h as Record<string, unknown>;
}

const js = loadHarnessJs();
const jsSrg = js["srg"] as {
  buildIndex: (m: Record<string, string>) => Record<string, string[]>;
  lookup: (i: Record<string, string[]>, c: string, m: string) => string;
  lookupAll: (i: Record<string, string[]>, c: string, m: string) => string[];
  findMissing: (i: Record<string, string[]>, r: unknown[]) => unknown[];
  findMissingTokens: (m: Record<string, string> | null, t: string[]) => string[];
  runtimeVerdict: (p: SrgRuntimeProbe) => SrgRuntimeVerdict;
};
const jsRoute = js["route"] as (t: string | undefined, h: boolean, e: boolean) => string;
const jsCas = js["cas"] as {
  update: (store: CasStore<string[]>, mutate: (v: string[]) => string[], max?: number) => unknown;
};

// A tiny synthetic srg_names.json exercising both a Mojang-named member and a still-obfuscated one,
// FQCN + simple keying, an overload collapse, and a plain field.
// Field entries carry no type suffix; method entries carry `(params)` (the real scripts/dev/srg.py
// --export format: `FQCN#member` for fields, `FQCN#member(params)` for methods).
const SAMPLE: Record<string, string> = {
  m_6375_: "net.minecraft.client.gui.screens.Screen#m_6375_(double,double,int)", // still obfuscated
  m_6348_: "net.minecraft.client.gui.screens.Screen#mouseReleased(double,double,int)",
  m_7583_: "net.minecraft.client.player.LocalPlayer#respawn()",
  m_41773_: "net.minecraft.world.item.ItemStack#getDamageValue()",
  f_91073_: "net.minecraft.client.Minecraft#level",
  m_dup_a_: "net.minecraft.world.item.ItemStack#getTag()",
};

describe("harness route parity (safe-io.js <-> dispatch.ts)", () => {
  const cases: [string | undefined, boolean, boolean][] = [
    ["goto", true, false],
    ["prospect", false, true],
    ["goto", true, true], // handler shadows ext
    ["unknown", false, false],
    ["", true, true], // empty type → passthrough
    [undefined, true, true],
  ];
  for (const [t, h, e] of cases) {
    it(`routes ${JSON.stringify(t)} h=${h} e=${e}`, () => {
      expect(jsRoute(t, h, e)).toBe(routeDispatch(t, h, e));
    });
  }
});

describe("harness SRG inversion parity (safe-io.js <-> srg-index.ts)", () => {
  it("builds an identical index", () => {
    expect(jsSrg.buildIndex(SAMPLE)).toEqual(buildSrgIndex(SAMPLE));
  });
  it("lookup agrees (and both throw on unknown)", () => {
    const ji = jsSrg.buildIndex(SAMPLE);
    const ti = buildSrgIndex(SAMPLE);
    expect(jsSrg.lookup(ji, "LocalPlayer", "respawn")).toBe(
      srgLookup(ti, "LocalPlayer", "respawn"),
    );
    expect(jsSrg.lookup(ji, "Minecraft", "level")).toBe("f_91073_");
    expect(() => jsSrg.lookup(ji, "Nope", "nope")).toThrow();
    expect(() => srgLookup(ti, "Nope", "nope")).toThrow();
  });
  it("lookupAll agrees", () => {
    const ji = jsSrg.buildIndex(SAMPLE);
    const ti = buildSrgIndex(SAMPLE);
    expect(jsSrg.lookupAll(ji, "ItemStack", "getTag")).toEqual(
      srgLookupAll(ti, "ItemStack", "getTag"),
    );
    expect(jsSrg.lookupAll(ji, "Nope", "x")).toEqual([]);
  });
});

describe("harness required-set parity (safe-io.js <-> srg-required.ts)", () => {
  it("agrees on required tokens", () => {
    expect(js["SRG_REQUIRED"]).toBeDefined();
    const req = js["SRG_REQUIRED"] as { tokens: string[]; members: unknown[] };
    expect(req.tokens).toEqual(REQUIRED_SRG_TOKENS);
  });
  it("agrees on required members", () => {
    const req = js["SRG_REQUIRED"] as { tokens: string[]; members: unknown[] };
    expect(req.members).toEqual(REQUIRED_SRG_MEMBERS);
  });
});

// The runtime half of the SRG boot check (docs/PORTABILITY.md): it used to say ok on
// Fabric because it only compared code with srg_names.json. Known-bad rows are the two real
// non-SRG runtimes the matrix met: Fabric's intermediary Minecraft class, and a Mojang-named
// runtime (NeoForge 1.20.5+) whose Entity has `setYRot` but not the SRG token.
describe("SRG runtime verdict (safe-io.js <-> srg-runtime.ts)", () => {
  const jsVerdict = jsSrg.runtimeVerdict;
  const rows: [string, SrgRuntimeProbe, SrgRuntimeVerdict["ok"]][] = [
    ["Forge 1.20.1", { mcClass: "net.minecraft.client.Minecraft", srgMember: true }, "1"],
    ["Fabric 1.20.1 (intermediary)", { mcClass: "net.minecraft.class_310", srgMember: false }, "0"],
    [
      "Fabric even if the member read lied",
      { mcClass: "net.minecraft.class_310", srgMember: true },
      "0",
    ],
    ["Mojang-named runtime", { mcClass: "net.minecraft.client.Minecraft", srgMember: false }, "0"],
    ["class name unreadable", { mcClass: null, srgMember: true }, "unknown"],
    [
      "reflection failed",
      { mcClass: "net.minecraft.client.Minecraft", srgMember: null },
      "unknown",
    ],
  ];
  for (const [name, probe, want] of rows) {
    it(`${name} → ${want}, identical in both implementations`, () => {
      const ts = srgRuntimeVerdict(probe);
      expect(ts.ok).toBe(want);
      expect(jsVerdict(probe)).toEqual(ts);
    });
  }
  it("probes the bundle's own steer token, identical in both implementations", () => {
    expect(js["SRG_RUNTIME_PROBE"]).toEqual(SRG_RUNTIME_PROBE);
    expect(REQUIRED_SRG_TOKENS).toContain(SRG_RUNTIME_PROBE.member);
  });
});

// One verdict line per boot: the table half and the runtime half used to log separately, so a
// Fabric client printed "SRG boot-check PASS" and then "!!! SRG boot-check FAIL".
describe("SRG boot line (safe-io.js <-> srg-runtime.ts)", () => {
  const jsLine = (jsSrg as unknown as { bootLine: typeof srgBootLine }).bootLine;
  const required = { tokens: 17, members: 12 };
  const none = { tokens: [], members: [] };
  const rot = { tokens: ["m_1_"], members: ["Foo#bar"] };
  const forge = srgRuntimeVerdict({ mcClass: "net.minecraft.client.Minecraft", srgMember: true });
  const fabric = srgRuntimeVerdict({ mcClass: "net.minecraft.class_310", srgMember: false });
  const unknown = srgRuntimeVerdict({ mcClass: null, srgMember: null });
  const rows: [string, SrgMapResult, SrgRuntimeVerdict, string][] = [
    ["Forge, table resolves", { ok: "1", required, missing: none }, forge, "SRG boot-check PASS"],
    [
      "Fabric, table resolves",
      { ok: "1", required, missing: none },
      fabric,
      "!!! SRG boot-check FAIL",
    ],
    ["Forge, pack rot", { ok: "0", required, missing: rot }, forge, "!!! SRG boot-check FAIL"],
    ["no table", { ok: "unknown", required, missing: none }, forge, "SRG boot-check SKIPPED"],
    [
      "no table on Fabric",
      { ok: "unknown", required, missing: none },
      fabric,
      "!!! SRG boot-check FAIL",
    ],
    ["probe failed", { ok: "1", required, missing: none }, unknown, "SRG boot-check PASS"],
  ];
  for (const [name, map, runtime, prefix] of rows) {
    it(`${name} → one "${prefix}" line, identical in both implementations`, () => {
      const line = srgBootLine(map, runtime);
      expect(line.startsWith(prefix)).toBe(true);
      expect(line.match(/boot-check (PASS|FAIL|SKIPPED)/g)).toHaveLength(1);
      expect(jsLine(map, runtime)).toBe(line);
    });
  }
  it("main.js logs the boot check once, through bootLine", () => {
    const main = readFileSync("harness/main.js", "utf8");
    expect(main.match(/log\("[!\s]*SRG boot-check/g)).toBeNull();
    expect(main.match(/log\(H\.srg\.bootLine\(/g)).toHaveLength(1);
  });
});

describe("harness CAS parity (safe-io.js <-> world-cas.ts)", () => {
  // Drive both the JS twin and the TS SSOT through an identical conflicting-store scenario and assert
  // identical result + final disk state (the re-merge must be byte-for-byte the same on both sides).
  function scenario(update: (s: CasStore<string[]>, m: (v: string[]) => string[]) => unknown): {
    result: unknown;
    disk: { seq: number; value: string[] };
  } {
    let disk = { seq: 0, value: [] as string[] };
    let injected = false;
    const store: CasStore<string[]> = {
      read: () => ({ seq: disk.seq, value: [...disk.value] }),
      commit: (value, nextSeq, expectedSeq) => {
        if (!injected) {
          injected = true;
          disk = { seq: disk.seq + 1, value: [...disk.value, "B"] };
        }
        if (expectedSeq !== null && disk.seq !== expectedSeq) return false;
        disk = { seq: nextSeq, value: [...value] };
        return true;
      },
    };
    const result = update(store, (v) => [...v, "A"]);
    return { result, disk };
  }
  it("result + disk identical across the two implementations", () => {
    const t = scenario((s, m) => casUpdate(s, m));
    const j = scenario((s, m) => jsCas.update(s, m));
    expect(j.result).toEqual(t.result);
    expect(j.disk).toEqual(t.disk);
    expect(t.disk.value.slice().sort()).toEqual(["A", "B"]); // both really survived
  });
});

describe("routeDispatch", () => {
  it("HANDLERS win over EXT", () => {
    expect(routeDispatch("x", true, true)).toBe("handler");
  });
  it("EXT when no handler", () => {
    expect(routeDispatch("x", false, true)).toBe("ext");
  });
  it("passthrough when neither / empty type", () => {
    expect(routeDispatch("x", false, false)).toBe("passthrough");
    expect(routeDispatch("", true, true)).toBe("passthrough");
    expect(routeDispatch(undefined, true, true)).toBe("passthrough");
  });
});

describe("buildSrgIndex / findMissing", () => {
  it("keys by both FQCN and simple name; strips signature", () => {
    const i = buildSrgIndex(SAMPLE);
    expect(i["LocalPlayer#respawn"]).toEqual(["m_7583_"]);
    expect(i["net.minecraft.client.player.LocalPlayer#respawn"]).toEqual(["m_7583_"]);
  });
  it("tolerates a null/empty map", () => {
    expect(buildSrgIndex(null)).toEqual({});
    expect(buildSrgIndex(undefined)).toEqual({});
  });
  it("findMissingSrg reports unresolved and mismatch", () => {
    const i = buildSrgIndex(SAMPLE);
    const miss = findMissingSrg(i, [
      { cls: "LocalPlayer", member: "respawn", expect: "m_7583_" }, // ok
      { cls: "LocalPlayer", member: "respawn", expect: "m_WRONG_" }, // mismatch
      { cls: "Ghost", member: "gone" }, // unresolved
    ]);
    expect(miss).toEqual([
      {
        cls: "LocalPlayer",
        member: "respawn",
        reason: "mismatch",
        expect: "m_WRONG_",
        got: "m_7583_",
      },
      { cls: "Ghost", member: "gone", reason: "unresolved", expect: undefined },
    ]);
  });
  it("findMissingTokens reports tokens absent from the map", () => {
    expect(findMissingTokens(SAMPLE, ["m_6375_", "m_GONE_"])).toEqual(["m_GONE_"]);
    expect(findMissingTokens(null, ["m_6375_"])).toEqual([]); // map unavailable → skip (not a scream)
  });
});

// Guards that the DECLARED required set resolves against the real deployed srg_names.json when it's
// present in the repo (the same file sync.py deploys). This is the offline half of the boot check:
// if a committed mapping ever stops covering a declared dependency, it fails here, not in-game.
describe("required set resolves against committed srg_names.json (if present)", () => {
  let map: Record<string, string> | null = null;
  try {
    map = JSON.parse(readFileSync("harness/srg_names.json", "utf8"));
  } catch {
    map = null;
  }
  it.runIf(map)("no missing tokens", () => {
    expect(findMissingTokens(map, REQUIRED_SRG_TOKENS)).toEqual([]);
  });
  it.runIf(map)("no missing members", () => {
    const i = buildSrgIndex(map ?? {});
    expect(findMissingSrg(i, REQUIRED_SRG_MEMBERS)).toEqual([]);
  });
  it("declares HARNESS_SRG_TOKENS as a subset of REQUIRED_SRG_TOKENS", () => {
    for (const t of HARNESS_SRG_TOKENS) expect(REQUIRED_SRG_TOKENS).toContain(t);
  });
});

// The SRG boot self-check semantics: a pack whose mapping has ROTTED (a required token/member is
// gone) must surface as a non-empty miss list (the loud boot diagnosis), not resolve to a silent
// undefined. Simulate rot by dropping a required token + a required member from a real-shaped map.
describe("SRG boot-check surfaces rot (findMissing over the real required set)", () => {
  it("a clean map yields no misses; a rotted map lists exactly what's gone", () => {
    // Build a synthetic map that covers the whole required set, then rot two entries out of it.
    const map: Record<string, string> = {};
    for (const t of REQUIRED_SRG_TOKENS) map[t] = `net.minecraft.Dummy#${t}`;
    // Give each required member a resolvable Mojang-named entry under its simple class.
    let n = 0;
    for (const m of REQUIRED_SRG_MEMBERS)
      map[`m_syn${n++}_`] = `net.minecraft.pkg.${m.cls}#${m.member}`;
    // Clean pass:
    expect(findMissingTokens(map, REQUIRED_SRG_TOKENS)).toEqual([]);
    expect(findMissingSrg(buildSrgIndex(map), REQUIRED_SRG_MEMBERS)).toEqual([]);
    // Rot: drop the first required token and the entry backing the first required member.
    const firstToken = REQUIRED_SRG_TOKENS[0];
    const firstMember = REQUIRED_SRG_MEMBERS[0];
    if (firstToken === undefined || firstMember === undefined)
      throw new Error("required set is empty");
    const rotted: Record<string, string> = {};
    for (const [k, v] of Object.entries(map))
      if (k !== firstToken && k !== "m_syn0_") rotted[k] = v;
    expect(findMissingTokens(rotted, REQUIRED_SRG_TOKENS)).toEqual([firstToken]);
    const memberMiss = findMissingSrg(buildSrgIndex(rotted), REQUIRED_SRG_MEMBERS);
    expect(memberMiss).toHaveLength(1);
    expect(memberMiss[0]).toMatchObject({
      cls: firstMember.cls,
      member: firstMember.member,
      reason: "unresolved",
    });
  });
});

// — Movement-key dead-man (safe-io.js <-> deadman.ts) ———————————————————————————————————————————————
// main.js releases the movement keys ONCE per worker stall (the heartbeat standing still ≥ staleTicks
// main ticks) and never against a beating worker or an absent one. Both twins run the same traces.
type DeadmanStepFn = (
  st: DeadmanState,
  beat: number,
  tick: number,
  staleTicks: number,
) => DeadmanStep;
const jsDeadman = js["deadman"] as {
  KEYS: string[];
  init: () => DeadmanState;
  step: DeadmanStepFn;
};

/** Feed `beats` (one per main tick, ticks 1..n) through a twin; returns the ticks that released. */
function deadmanRun(
  init: () => DeadmanState,
  stepFn: DeadmanStepFn,
  beats: number[],
): { released: number[]; steps: DeadmanStep[] } {
  let st = init();
  const released: number[] = [];
  const steps: DeadmanStep[] = [];
  beats.forEach((beat, i) => {
    const s = stepFn(st, beat, i + 1, 10);
    steps.push(s);
    st = s.state;
    if (s.release) released.push(i + 1);
  });
  return { released, steps };
}
const beating = (n: number, from = 1): number[] => Array.from({ length: n }, (_, i) => from + i);
const still = (beat: number, n: number): number[] => Array.from({ length: n }, () => beat);

describe("movement-key dead-man", () => {
  it("the key sets agree, and hold body keys only", () => {
    expect(jsDeadman.KEYS).toEqual([...DEADMAN_KEYS]);
    expect(DEADMAN_KEYS).not.toContain("key.use");
    expect(DEADMAN_KEYS).not.toContain("key.attack");
  });

  const traces: [string, number[], number[]][] = [
    ["a beating worker never trips", beating(60), []],
    // jitter: main can see the same beat for a tick or two between worker bodies
    ["two-tick jitter never trips", [1, 1, 2, 2, 2, 3, 4, 4, 5, ...beating(30, 6)], []],
    // beat 5 first seen at tick 5; still at tick 15 → 10 ticks stale → ONE release, not one per tick
    ["one stall → one release at the threshold", [...beating(5), ...still(5, 40)], [15]],
    [
      "one tick under the threshold → nothing",
      [...beating(5), ...still(5, 9), ...beating(5, 6)],
      [],
    ],
    [
      "the worker recovers, then stalls again → a second release",
      [...beating(5), ...still(5, 12), ...beating(5, 6), ...still(10, 12)],
      [15, 32],
    ],
    ["no worker (beat 0) → never trips: a human may hold the keys", still(0, 40), []],
    [
      "the worker stops mid-stall (beat → 0) → no release",
      [...beating(5), ...still(5, 5), ...still(0, 30)],
      [],
    ],
  ];
  for (const [name, beats, expected] of traces) {
    it(`${name} — identical in both twins`, () => {
      const ts = deadmanRun(deadmanInit, deadmanStep, beats);
      const j = deadmanRun(jsDeadman.init, jsDeadman.step, beats);
      expect(ts.released).toEqual(expected);
      expect(j.steps).toEqual(ts.steps);
    });
  }

  it("counts stalls and reports stale for the whole stall (main stops forcing sprint)", () => {
    const { steps } = deadmanRun(deadmanInit, deadmanStep, [...beating(5), ...still(5, 20)]);
    const last = steps[steps.length - 1];
    expect(last?.state.stalls).toBe(1);
    expect(last?.state.stallTick).toBe(15);
    expect(steps.filter((s) => s.stale)).toHaveLength(11); // ticks 15..25
  });

  it("main.js wires it: heartbeat counter in, KeyBind release out, sprint gated, diag counter", () => {
    const main = readFileSync("harness/main.js", "utf8");
    expect(main).toMatch(/var DEADMAN_STALE_TICKS = \d+;/);
    expect(main).toMatch(/H\.deadman\.step\(deadman, dmBeat, tickCount, DEADMAN_STALE_TICKS\)/);
    // the per-body counter, not the whole-second stamp
    expect(main).toMatch(/dmBeat = GV\.getInt\(WORKER_ALIVE_KEY\)/);
    expect(main).toMatch(/KeyBind\.keyBind\(H\.deadman\.KEYS\[dk\], false\)/);
    expect(main).toMatch(/ws === "1" && workerFresh && !dm\.stale/);
    expect(main).toMatch(/deadman: \{staleTicks: DEADMAN_STALE_TICKS, stalls: deadman\.stalls/);
  });

  // log() reaches only stdout and chat; an operator reads the journal (get_logs). The release
  // branch writes a journal record in the Logger's shape, to the file get_logs tails. Its `tick` is
  // on the worker clock like every other record: main's own tick count there (48211 among worker
  // ticks 1..55) became navbench's drain baseline. main's count rides in fields.mainTick. No
  // stall length: the record is written on the stall's first stale tick, so it would always read
  // DEADMAN_STALE_TICKS.
  it("a stall reaches the journal get_logs tails, on the worker clock", () => {
    const main = readFileSync("harness/main.js", "utf8");
    const release = main.slice(
      main.indexOf("if (dm.release) {"),
      main.indexOf("// Apply the worker's"),
    );
    expect(release).toMatch(
      /journalAppend\(\{tick: dmBeat, level: "WARN", event: "DEADMAN",\s*fields: \{by: "main\.js", mainTick: tickCount, stalls: deadman\.stalls\}\}\);/,
    );
    expect(main).toMatch(/new FileWriter\(journalPath\(\)\.toString\(\), true\)/);
    const getLogs = main.slice(
      main.indexOf("get_logs: function"),
      main.indexOf("inventory: function"),
    );
    expect(getLogs).toMatch(/var path = journalPath\(\);/);
  });
});
