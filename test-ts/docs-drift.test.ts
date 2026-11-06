// Docs-as-code drift gate: docs/MISSIONS.md must stay true to the mission registry, and the
// public docs must name every capability, plan and reflex (last describe block). Bridge commands:
// test-ts/commands-ref.test.ts.
//
// The missions' `name` and `params` are declarative data, so the doc that
// describes them is CHECKABLE — this test fails the commit gate when someone
// adds/renames a mission or a param without touching the reference page (the
// classic silent docs rot). It deliberately checks presence, not prose: the
// reference must MENTION every mission and every param; what it says about them
// stays a human's job.
//
// The missions are the ones the bundle registers: test-ts/_harness-tables.ts imports
// entry/worker-bundle and spies Kernel.registerMission, so no hand-kept list can fall behind.
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import type { Capability, Ctx } from "@/shared/kernel/capability";
import type { Mission } from "@/shared/kernel/mission";
import { reflexes } from "@/shared/reflexes";
import { loadBundleWiring } from "./_harness-tables";

// Vitest runs from the repo root — cwd-relative, same as harness-contract.test.ts.
const doc = (): string => readFileSync("docs/MISSIONS.md", "utf8");

/** Each mission name with no heading/table mention, and each param the doc never names. */
function missionDrift(
  missions: readonly Pick<Mission, "name" | "params">[],
  text: string,
): string[] {
  const out: string[] = [];
  for (const m of missions) {
    // A heading or table row mentioning the mission by exact name.
    if (!new RegExp(`(^|\\W)${m.name}(\\W|$)`, "m").test(text)) out.push(`mission ${m.name}`);
    for (const p of m.params ?? []) {
      if (!text.includes(p.name)) out.push(`mission ${m.name} param ${p.name}`);
    }
  }
  return out;
}

describe("docs/MISSIONS.md ↔ mission registry", () => {
  let missions: Mission[];

  beforeAll(async () => {
    missions = (await loadBundleWiring()).missions;
  }, 60_000);

  it("the missions are really read from the wiring", () => {
    expect(missions.map((m) => m.name)).toEqual(
      expect.arrayContaining(["mine", "goto", "prospect"]),
    );
    expect(missions.some((m) => (m.params ?? []).length > 0)).toBe(true);
  });

  it("every registered mission and each declared param is in the doc", () => {
    expect(missionDrift(missions, doc())).toEqual([]);
  });

  it("KNOWN-BAD: an absent mission, a mention only inside a word and a missing param are reported", () => {
    const text = "## zz_fixture_missions\n| `p` | int |\n";
    const p = (name: string) => ({ name, type: "int" as const });
    expect(
      missionDrift(
        [
          { name: "zz_absent" },
          { name: "zz_fixture_mission" },
          { name: "zz_fixture_missions", params: [p("p"), p("q")] },
        ],
        text,
      ),
    ).toEqual([
      "mission zz_absent",
      "mission zz_fixture_mission",
      "mission zz_fixture_missions param q",
    ]);
  });
});

// Completeness of the public docs over everything the bundle wires. The names come from the code:
// the capabilities makeModule() passes to Kernel.register, the plans its orchestrator answers
// `plans` with, and the `reflexes` array. Each must appear as a code span (`` `name` ``) in its
// doc — a bare word like "air" or "tool" proves nothing.
const CAPABILITY_DOCS = ["docs/EXTENDING.md", "docs/ARCHITECTURE.md"];
const REFLEX_DOCS = ["docs/SAFETY.md"];
const PLAN_DOCS = ["docs/MISSIONS.md"];
const PLANS_DIR = "src/bot/plans";

/** The names no doc in `docs` mentions as a code span. */
function undocumented(names: readonly string[], docs: readonly string[]): string[] {
  const text = docs.map((d) => readFileSync(d, "utf8")).join("\n");
  return names.filter((n) => !text.includes(`\`${n}\``));
}

/** Plan files under src/bot/plans/ that the bundle does not wire, and wired plans with no file. */
function planFileDrift(wired: readonly string[], files: readonly string[]): string[] {
  const stems = files.filter((f) => f.endsWith(".ts")).map((f) => f.slice(0, -3));
  return [
    ...stems.filter((s) => !wired.includes(s)).map((s) => `file ${s}.ts is not wired`),
    ...wired.filter((w) => !stems.includes(w)).map((w) => `plan ${w} has no ${PLANS_DIR}/${w}.ts`),
  ];
}

/** The plan names the wired orchestrator capability answers its `plans` command with. */
function wiredPlans(caps: readonly Capability[]): string[] {
  const plans = caps.find((c) => c.name === "orchestrator")?.commands?.["plans"];
  if (!plans) throw new Error("no orchestrator capability with a plans command was registered");
  let reply: unknown;
  const ctx = {
    reply: (d: unknown): void => {
      reply = d;
    },
    log: { info: (): void => undefined },
    st: { tickCount: 0 },
  };
  plans(ctx as unknown as Ctx, {});
  return (reply as { available: string[] }).available;
}

describe("public docs name every registered piece", () => {
  let caps: Capability[];
  const reflexNames = reflexes.map((r) => r.name);

  beforeAll(async () => {
    caps = (await loadBundleWiring()).capabilities;
  }, 60_000);

  const capabilityNames = (): string[] =>
    caps.map((c) => c.name).filter((n) => !reflexNames.includes(n));

  it("the lists are really read from the wiring", () => {
    // The bundle registers every reflex through the same Kernel.register call.
    expect(caps.map((c) => c.name)).toEqual(expect.arrayContaining(reflexNames));
    expect(capabilityNames()).toEqual(expect.arrayContaining(["core", "navProbe", "orchestrator"]));
    expect(wiredPlans(caps).length).toBeGreaterThan(0);
  });

  it("every always-on capability is named in EXTENDING.md or ARCHITECTURE.md", () => {
    expect(undocumented(capabilityNames(), CAPABILITY_DOCS)).toEqual([]);
  });

  it("every reflex is named in SAFETY.md", () => {
    expect(undocumented(reflexNames, REFLEX_DOCS)).toEqual([]);
  });

  it("every plan is named in MISSIONS.md, and each plan file is wired", () => {
    const plans = wiredPlans(caps);
    expect(undocumented(plans, PLAN_DOCS)).toEqual([]);
    expect(planFileDrift(plans, readdirSync(PLANS_DIR))).toEqual([]);
  });

  // Bridge commands: docs/COMMANDS.md is rendered from the same manifest and held fresh by
  // test-ts/commands-ref.test.ts.

  // ---- known-bads ---------------------------------------------------------------------------------

  it("KNOWN-BAD: a name no doc mentions, or mentions only as a bare word, is reported", () => {
    const absent = "zz_fixture_absent";
    expect(undocumented([absent, "navProbe"], CAPABILITY_DOCS)).toEqual([absent]);
    // "Reflexes" is prose in SAFETY.md, never a code span.
    expect(readFileSync("docs/SAFETY.md", "utf8")).toContain("reflexes");
    expect(undocumented(["reflexes"], REFLEX_DOCS)).toEqual(["reflexes"]);
  });

  it("KNOWN-BAD: a plan file the bundle does not wire, or a wired plan with no file, is reported", () => {
    const files = readdirSync(PLANS_DIR);
    const plans = wiredPlans(caps);
    expect(planFileDrift(plans, [...files, "zz-fixture-plan.ts"])).toEqual([
      "file zz-fixture-plan.ts is not wired",
    ]);
    expect(planFileDrift([...plans, "zz-fixture-plan"], files)).toEqual([
      `plan zz-fixture-plan has no ${PLANS_DIR}/zz-fixture-plan.ts`,
    ]);
  });
});
