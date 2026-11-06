import { core } from "@/bot/capabilities/core";
import { mineMission } from "@/bot/missions/mine";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import type { ConfigOverrides } from "@/shared/config/schema";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogRecord, type LogSink, Logger } from "@/shared/kernel/logger";
import { reflexes } from "@/shared/reflexes";
import { describe, expect, it } from "vitest";

// Persistent hazard-cache consumption (descent-recoverability follow-up): a ravine/drowned column
// recorded in mc_world.json makes the mine SCAN skip any exposed ore within cfg.nav.ravineHazardRadius of
// it — the cross-run twin of the in-run mem.cache, so the bot never re-walks into the same trap.
function bot(cfg: ConfigOverrides = {}): {
  rt: MockRuntime;
  kernel: Kernel;
  st: BotState;
  logs: LogRecord[];
} {
  const logs: LogRecord[] = [];
  const sink: LogSink = { emit: (line) => logs.push(JSON.parse(line) as LogRecord) };
  const rt = createMockRuntime();
  const kernel = new Kernel(
    rt,
    new Logger(sink, "INFO"),
    new Bus(),
    makeGerdaConfig(cfg),
    GERDA_PHASES,
  );
  kernel.register(core);
  for (const r of reflexes) kernel.register(r);
  kernel.registerMission(mineMission);
  const st = makeInitialState();
  kernel.init(st);
  kernel.startMission(st, "mine");
  return { rt, kernel, st, logs };
}

const ORE = { x: 3, y: 64, z: 0 }; // within the first spiral rings of the start pos (0,64,0)
const found = (logs: LogRecord[]) => logs.filter((l) => l.event === "ORE_FOUND");
const skipped = (logs: LogRecord[]) => logs.filter((l) => l.event === "SCAN_HAZARD_SKIP");

// Seed a single hazard column into mc_world.json at the mock's world signature.
function seedHazard(rt: MockRuntime, kind: "ravine" | "drowned", x: number, z: number): void {
  const model = {
    version: 1,
    worlds: {
      [rt.state.worldSig]: {
        waypoints: [],
        resources: [],
        storages: [],
        hazards: [{ kind, x, z }],
        stats: { dumps: 0, veinsFound: 0, boots: 0 },
        updatedAt: 0,
      },
    },
  };
  rt.fs.write(makeGerdaConfig().worldModelPath, JSON.stringify(model));
}

// Seed the ore, optionally a hazard, then tick the mine SCAN to a conclusion.
function run(cfg: ConfigOverrides, hazard?: { kind: "ravine" | "drowned"; x: number; z: number }) {
  const b = bot(cfg);
  b.rt.setBlock(ORE.x, ORE.y, ORE.z, "gtceu:iron_ore"); // air world ⇒ neighbours air ⇒ exposed
  if (hazard) seedHazard(b.rt, hazard.kind, hazard.x, hazard.z);
  for (let i = 0; i < 40 && b.st.phase === "SCAN"; i++) b.kernel.tick(b.st);
  return b.logs;
}

describe("mine scan skips ore near a recorded hazard column (cross-run don't come back)", () => {
  it("finds the ore when there is no recorded hazard (control)", () => {
    expect(found(run({})).length).toBeGreaterThan(0);
  });

  it("does NOT find ore sitting on a recorded ravine column, and logs the skip", () => {
    const logs = run({}, { kind: "ravine", x: ORE.x, z: ORE.z });
    expect(found(logs)).toHaveLength(0);
    expect(skipped(logs).length).toBeGreaterThan(0);
  });

  it("skips ore near a recorded drowned column too (kind-agnostic, within radius)", () => {
    const logs = run({}, { kind: "drowned", x: ORE.x + 1, z: ORE.z }); // 1 block ≤ radius 3
    expect(found(logs)).toHaveLength(0);
  });

  it("cfg.nav.ravineHazardRadius:0 disables the skip — ore is found despite the hazard", () => {
    const logs = run({ nav: { ravineHazardRadius: 0 } }, { kind: "ravine", x: ORE.x, z: ORE.z });
    expect(found(logs).length).toBeGreaterThan(0);
  });

  it("finds ore FAR from the hazard (beyond the radius)", () => {
    const logs = run({}, { kind: "ravine", x: ORE.x + 20, z: ORE.z + 20 });
    expect(found(logs).length).toBeGreaterThan(0);
  });
});
