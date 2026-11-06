import { diagnostics } from "@/bot/capabilities/diagnostics";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import { Bus } from "@/shared/kernel/bus";
import { Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogRecord, type LogSink, Logger } from "@/shared/kernel/logger";
import { describe, expect, it } from "vitest";

// diagnostics.smoke — runs facade probes in the (mock here, worker live) context and
// logs a PASS/FAIL per check. The mock returns healthy sensor values, so every check
// passes; flipping a sensor out of range / to err must surface as a failed check.
function bot(): {
  rt: MockRuntime;
  kernel: Kernel;
  logs: LogRecord[];
  st: ReturnType<typeof makeInitialState>;
} {
  const logs: LogRecord[] = [];
  const sink: LogSink = { emit: (line) => logs.push(JSON.parse(line) as LogRecord) };
  const rt = createMockRuntime();
  const kernel = new Kernel(
    rt,
    new Logger(sink, "INFO"),
    new Bus(),
    makeGerdaConfig(),
    GERDA_PHASES,
  );
  kernel.register(diagnostics);
  const st = makeInitialState();
  kernel.init(st);
  return { rt, kernel, logs, st };
}

const smokeChecks = (logs: LogRecord[]) => logs.filter((l) => l.event === "SMOKE");
const done = (logs: LogRecord[]) => logs.find((l) => l.event === "SMOKE_DONE");

describe("diagnostics.smoke", () => {
  it("all facade probes pass on a healthy mock", () => {
    const { kernel, logs, st } = bot();
    kernel.command(st, { type: "smoke" });
    const summary = done(logs);
    expect(summary?.fields).toMatchObject({ fail: 0 });
    const total = (summary?.fields as { total: number }).total;
    expect(smokeChecks(logs)).toHaveLength(total);
    expect(smokeChecks(logs).every((l) => (l.fields as { ok: boolean }).ok)).toBe(true);
  });

  it("an out-of-range sensor surfaces as a failed check (not a silent pass)", () => {
    const { rt, kernel, logs, st } = bot();
    rt.state.food = 99; // impossible hunger value
    kernel.command(st, { type: "smoke" });
    const food = smokeChecks(logs).find(
      (l) => (l.fields as { check: string }).check === "player.food",
    );
    expect((food?.fields as { ok: boolean }).ok).toBe(false);
    expect((done(logs)?.fields as { fail: number }).fail).toBeGreaterThanOrEqual(1);
  });

  it("a sensor that errors surfaces as a failed check", () => {
    const { rt, kernel, logs, st } = bot();
    rt.state.playerPresent = false; // every sensor now returns err("no player")
    kernel.command(st, { type: "smoke" });
    expect((done(logs)?.fields as { fail: number }).fail).toBeGreaterThanOrEqual(1);
  });

  it("a runtime that cannot steer fails the setYaw check even though lookAt passes", () => {
    const { rt, kernel, logs, st } = bot();
    // Fabric shape: jsMacros' own lookAt works, the SRG setYRot the navigator steers with does not.
    rt.interact.setYaw = () => ({ ok: false, error: "SRG.setYRot is not a function" });
    kernel.command(st, { type: "smoke" });
    const check = (name: string) =>
      smokeChecks(logs).find((l) => (l.fields as { check: string }).check === name);
    expect((check("interact.lookAt")?.fields as { ok: boolean }).ok).toBe(true);
    expect((check("interact.setYaw(current)")?.fields as { ok: boolean }).ok).toBe(false);
  });

  it("eat:true dispatches one bite and logs SMOKE_EAT", () => {
    const { rt, kernel, logs, st } = bot();
    rt.state.food = 10;
    rt.state.slots.set(36, { id: "minecraft:bread", count: 3, durabilityPct: 100 }); // held (hotbar 0)
    kernel.command(st, { type: "smoke", eat: true });
    expect(logs.find((l) => l.event === "SMOKE_EAT")).toBeDefined();
    expect(rt.state.eatCalls).toBe(1);
  });
});

// Facade anti-sprawl drift guard: the smoke harness is the live coverage for the
// raw-Java reader surface, so it must not silently fall behind the facade. Every
// zero-arg player.* reader has to be exercised by a SMOKE check — add a reader, you
// get a build failure until you add its probe (or explicitly exclude it here).
describe("facade smoke coverage (drift guard)", () => {
  // readers whose smoke probe is intentionally NOT named player.<method> or is covered
  // elsewhere; keep empty unless a method genuinely shouldn't be smoke-run, with a reason.
  // jump() is a zero-arg MUTATOR (fires a real jumpFromGround), not a reader — smoke-running it would
  // make the bot hop, so it's driven by the parkour executor + its own unit tests, not the smoke probe.
  const EXCLUDED = new Set<string>(["jump"]);

  it("every zero-arg player reader is covered by a smoke check", () => {
    const { kernel, logs, st } = bot();
    kernel.command(st, { type: "smoke" });
    const covered = new Set(smokeChecks(logs).map((l) => (l.fields as { check: string }).check));

    const rt = createMockRuntime();
    // biome-ignore lint/suspicious/noExplicitAny: reflectively enumerate the facade group
    const group = rt.player as Record<string, any>;
    const readers = Object.keys(group).filter(
      (k) => typeof group[k] === "function" && group[k].length === 0,
    );

    const missing = readers.filter(
      (m) => !EXCLUDED.has(m) && ![...covered].some((c) => c.startsWith(`player.${m}`)),
    );
    expect(missing, `uncovered player readers: ${missing.join(", ")}`).toEqual([]);
  });
});
